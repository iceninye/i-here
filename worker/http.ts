/**
 * HTTP helpers：CORS（D11 = B）+ Origin 白名單 + 建房 rate limit（§5.4.4）。
 */

import type { Env } from './env';

/**
 * 解析白名單。支援萬用字元 `https://*.example.dev`。留空 = 空陣列（只 same-origin）。
 */
function allowedList(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Origin 係咪容許。冇 Origin（same-origin / curl）一律放行；有 Origin 就要 match 白名單。
 * 萬用字元只容許喺 host 最左 label（`*.pages.dev`），避免 `*` 通配一切。
 */
export function isAllowedOrigin(origin: string | null, env: Env, selfOrigin?: string): boolean {
  if (!origin) return true;
  // 瀏覽器同源 call 都會帶 Origin；Worker 自己嘅 origin 永遠放行
  if (selfOrigin && origin === selfOrigin) return true;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  const list = allowedList(env);
  return list.some(pattern => {
    let p: URL;
    try { p = new URL(pattern); } catch { return false; }
    if (p.protocol !== parsed.protocol) return false;
    if (p.hostname.startsWith('*.')) {
      const suffix = p.hostname.slice(1); // ".example.dev"
      return parsed.hostname.endsWith(suffix) && parsed.hostname.length > suffix.length;
    }
    return p.hostname === parsed.hostname && (p.port || '') === (parsed.port || '');
  });
}

/** CORS response headers。只 echo 容許嘅 Origin（唔好用 `*` 配 credentials-style 請求）。 */
export function corsHeaders(origin: string | null, env: Env, selfOrigin?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && isAllowedOrigin(origin, env, selfOrigin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

/* ---------------- Rate limit（best-effort，per-isolate in-memory） ----------------
 * 免費層冇 KV binding 時，用 isolate 記憶體做 sliding window。限制：
 *  - isolate 被 evict / 另一個 colo 就 reset —— 係**減慢滥用**而唔係硬保證（§5.4.4 目的係避免被刷爆 DO）。
 *  - 要更嚴謹就加 KV / 命名 DO 做 per-IP counter；此處刻意保持輕量。
 */
interface Bucket { count: number; resetAt: number }
const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;

export function tooManyRequests(ip: string, env: Env, scope = 'create', limitOverride?: number): boolean {
  const limit = limitOverride ?? Number(env.RATE_LIMIT_PER_MIN ?? '10');
  ip = scope + ':' + ip;
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now >= b.resetAt) {
    buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    // 簡單清理：map 太大就清過期嘅，避免記憶體膨脹
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
    }
    return false;
  }
  b.count += 1;
  return b.count > limit;
}
