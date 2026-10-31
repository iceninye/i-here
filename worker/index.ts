/**
 * i-here Worker entry（PLAN §6.1）
 *
 * 責任：
 *  - `POST /api/live`：建房（生成 128-bit roomId → 揀 DO → /init 攞 hostToken）；每 IP rate limit。
 *  - `GET  /api/live/ws`：WebSocket upgrade。**roomId 唔喺 URL**（避免 access log / Referer 洩漏 bearer
 *    secret，PLAN §5.2 / §5.4.6），改由 client 放喺 `Sec-WebSocket-Protocol` header 傳過嚟。
 *    呢個係 browser WebSocket API 唯一可以喺 upgrade 時帶 server-routing 資料、又唔入 URL 嘅渠道
 *    （WebSocket  constructor 唔畀 set 自訂 header）。Worker 用它揀 DO stub，DO 再 echo 返同一個
 *    subprotocol 完成 handshake（browser 規定：server 冇 echo client 請求嘅 subprotocol 就會 abort）。
 *  - 其餘路徑 → 靜態資產（`env.ASSETS`）。
 *
 * 部署（D11 = B）：GitHub Pages 前端跨域 call 呢個 Worker 嘅 `/api/*`，所以要處理 CORS preflight
 * 同 WebSocket `Origin` 白名單。
 */

import type { Env } from './env';
import { corsHeaders, isAllowedOrigin, tooManyRequests } from './http';

export { LiveShareRoom } from './liveShareRoom';

/** roomId：128-bit 隨機，base64url（≈22 字元） */
function newRoomId(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  let s = '';
  for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 由 `Sec-WebSocket-Protocol` 抽 roomId。client 送 `["ih-live", "<roomId>"]`。 */
function roomIdFromSubprotocol(header: string | null): string | null {
  if (!header) return null;
  const parts = header.split(',').map(p => p.trim());
  // roomId 係唔係 "ih-live" 嗰個 token
  const id = parts.find(p => p && p !== 'ih-live');
  return id ?? null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    // ---- POST /api/live：建房 ----
    if (url.pathname === '/api/live' && request.method === 'POST') {
      if (origin && !isAllowedOrigin(origin, env)) {
        return new Response('origin not allowed', { status: 403, headers: corsHeaders(origin, env) });
      }
      // 每 IP 每分鐘 rate limit（§5.4.4）；用 DO-free 嘅簡易 in-memory 计数唔夠穩，改用 ephemeral 檢查：
      // 呢度用一個命名 DO 做 per-IP token bucket 會太重；免費層用 ctx + 簡單 heuristic（見 http.ts）。
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      if (tooManyRequests(ip, env)) {
        return new Response('rate limited', { status: 429, headers: { 'Retry-After': '60', ...corsHeaders(origin, env) } });
      }

      const roomId = newRoomId();
      const stub = env.LIVE_SHARE.get(env.LIVE_SHARE.idFromName(roomId), { locationHint: 'apac' });
      const init = await stub.fetch(new Request('https://do/init?roomId=' + encodeURIComponent(roomId), { method: 'POST' }));
      if (!init.ok) {
        return new Response('room init failed', { status: 502, headers: corsHeaders(origin, env) });
      }
      const meta = (await init.json()) as { hostToken: string; expiresAt: number };
      void ctx;
      return Response.json(
        { roomId, hostToken: meta.hostToken, expiresAt: meta.expiresAt },
        { headers: corsHeaders(origin, env) },
      );
    }

    // ---- GET /api/live/ws：WebSocket upgrade ----
    if (url.pathname === '/api/live/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket upgrade', { status: 426, headers: corsHeaders(origin, env) });
      }
      if (origin && !isAllowedOrigin(origin, env)) {
        return new Response('origin not allowed', { status: 403 });
      }
      const roomId = roomIdFromSubprotocol(request.headers.get('Sec-WebSocket-Protocol'));
      if (!roomId) {
        // roomId 唔喺 URL；冇 subprotocol 就無從路由
        return new Response('missing room subprotocol', { status: 400 });
      }
      const stub = env.LIVE_SHARE.get(env.LIVE_SHARE.idFromName(roomId), { locationHint: 'apac' });
      return stub.fetch(request);
    }

    // ---- 其餘：靜態資產 ----
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
