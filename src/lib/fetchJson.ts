import { logApi } from './apiLog';

export class HttpError extends Error {
  constructor(public status: number, public url: string) {
    super(`HTTP ${status}`);
  }
}

/** fetch + timeout + 外部 AbortSignal。政府 API 偶爾好慢，唔可以拖住成個畫面。每次 call 都記入診斷紀錄。 */
export async function fetchJson<T = unknown>(
  url: string,
  { timeoutMs = 6000, signal, headers, name = new URL(url).host }:
    { timeoutMs?: number; signal?: AbortSignal; headers?: Record<string, string>; name?: string } = {},
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
  const onAbort = () => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort);
  const t0 = performance.now();
  const update = logApi({ name, url, ok: false, status: 'pending', ms: 0, snippet: '' });
  const log = (ok: boolean, status: string, snippet: string) =>
    update({ ok, status, ms: Math.round(performance.now() - t0), snippet: snippet.slice(0, 600) });
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', ...headers } });
    const text = await res.text();
    if (!res.ok) {
      log(false, `HTTP ${res.status}`, text);
      throw new HttpError(res.status, url);
    }
    try {
      const json = JSON.parse(text) as T;
      log(true, `HTTP ${res.status}`, text);
      return json;
    } catch (e) {
      log(false, 'not JSON', text);
      throw e;
    }
  } catch (e) {
    if (!(e instanceof HttpError) && !(e instanceof SyntaxError)) {
      // TypeError: Failed to fetch → 通常係 CORS 或網絡；AbortError/TimeoutError → 逾時或被取消
      log(false, (e as Error)?.name ?? 'error', String((e as Error)?.message ?? e));
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
