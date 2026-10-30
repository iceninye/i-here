/**
 * i-here CORS 代理（Cloudflare Worker，可選）。
 *
 * 用途：部分政府 API 冇回 `Access-Control-Allow-Origin`，或者偶爾慢 / 限流。
 * 經呢個 Worker 轉發可以：加 CORS header、喺 edge cache 結果（地址唔會分鐘級改變）、統一 timeout。
 *
 * 用法：GET https://<worker>/<host>/<path>?<query>
 *   例：/geodata.gov.hk/gs/api/v1.0.0/identify?x=836000&y=819000&lang=zh
 *
 * 安全：只准 ALLOWED_HOSTS 入面嘅 host（唔係 open proxy）；只准 GET；Origin 白名單。
 * 私隱：Worker 唔記錄座標；Cloudflare 預設 log 只係 request metadata，可喺 dashboard 關閉。
 */

const ALLOWED_HOSTS = new Set([
  'www.geodetic.landsd.gov.hk',
  'geodata.gov.hk',
  'www.als.gov.hk',
]);

const ALLOWED_ORIGINS = [
  /^https:\/\/iceninye\.github\.io$/,
  /^https:\/\/i-here\.[\w-]+\.workers\.dev$/,
  /^http:\/\/localhost(:\d+)?$/,
];

const CACHE_TTL_S = 60 * 60 * 24; // 地址 / 坐標轉換結果一日都唔會變

function corsHeaders(origin: string | null): Record<string, string> {
  const ok = origin && ALLOWED_ORIGINS.some(r => r.test(origin));
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export default {
  async fetch(req: Request, _env: unknown, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const origin = req.headers.get('Origin');
    const cors = corsHeaders(origin);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });

    const url = new URL(req.url);
    const [, host, ...rest] = url.pathname.split('/');
    if (!ALLOWED_HOSTS.has(host)) return new Response('Host not allowed', { status: 403, headers: cors });
    const upstream = `https://${host}/${rest.join('/')}${url.search}`;

    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(upstream, { method: 'GET' });
    let res = await cache.match(cacheKey);
    if (!res) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        res = await fetch(upstream, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
      } catch {
        return new Response('Upstream timeout', { status: 504, headers: cors });
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) {
        res = new Response(res.body, res);
        res.headers.set('Cache-Control', `public, max-age=${CACHE_TTL_S}`);
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
      }
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};
