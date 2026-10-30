export class HttpError extends Error {
  constructor(public status: number, public url: string) {
    super(`HTTP ${status}`);
  }
}

/** fetch + timeout + 外部 AbortSignal。政府 API 偶爾好慢，唔可以拖住成個畫面。 */
export async function fetchJson<T = unknown>(
  url: string,
  { timeoutMs = 6000, signal, headers }: { timeoutMs?: number; signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
  const onAbort = () => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', ...headers } });
    if (!res.ok) throw new HttpError(res.status, url);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
