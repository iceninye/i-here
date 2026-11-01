/** Worker / DO 環境綁定（PLAN §6.1） */
export interface Env {
  /** LiveShareRoom Durable Object binding */
  LIVE_SHARE: DurableObjectNamespace;
  /** Static Assets binding（run_worker_first 只 intercept /api/*，其餘由 assets serve） */
  ASSETS?: Fetcher;
  /**
   * 容許跨域 call `/api/*` 嘅 Origin 白名單（逗號分隔）。D11 = B：GitHub Pages 前端跨域 call Worker。
   * 例：`https://iceninye.github.io,https://*.i-here.pages.dev`。留空 = 只容許 same-origin。
   */
  ALLOWED_ORIGINS?: string;
  /** 每 IP 每分鐘最多建幾多個房（§5.4.4）。默認 10。 */
  RATE_LIMIT_PER_MIN?: string;
}
