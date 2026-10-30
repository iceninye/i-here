/**
 * API 診斷紀錄（只存喺記憶體，最多 30 條）。
 * 網址加 ?debug=1 會顯示診斷面板，方便喺手機上睇到每個政府 API 實際回咗乜。
 */
export interface ApiLogEntry {
  name: string;
  url: string;
  ok: boolean;
  /** HTTP status，或者錯誤名（TypeError = 多數係 CORS / 網絡） */
  status: string;
  ms: number;
  /** 回應頭 600 字 */
  snippet: string;
  /** 由呢個回應抽到幾多個地方 */
  found?: number;
}

const entries: ApiLogEntry[] = [];
const listeners = new Set<() => void>();

export function logApi(e: ApiLogEntry): void {
  entries.unshift(e);
  entries.length = Math.min(entries.length, 30);
  listeners.forEach(l => l());
}

export function getApiLog(): readonly ApiLogEntry[] {
  return entries;
}

export function subscribeApiLog(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
