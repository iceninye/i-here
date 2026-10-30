/**
 * API 診斷紀錄（只存喺記憶體，最多 30 條）。
 * 網址加 ?debug=1 會顯示診斷面板，方便喺手機上睇到每個政府 API 實際回咗乜。
 * 請求一開始就記一條「pending」，完成先更新 —— 等緊嘅請求都睇得到。
 */
export interface ApiLogEntry {
  name: string;
  url: string;
  ok: boolean;
  /** 'pending'、HTTP status，或者錯誤名（TypeError = 多數係 CORS / 網絡；AbortError = 逾時） */
  status: string;
  ms: number;
  /** 回應頭 600 字 */
  snippet: string;
}

let entries: readonly ApiLogEntry[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

/** 記一條新紀錄，回傳一個 function 用嚟更新佢 */
export function logApi(e: ApiLogEntry): (patch: Partial<ApiLogEntry>) => void {
  let current = e;
  entries = [current, ...entries].slice(0, 30);
  emit();
  return patch => {
    const next = { ...current, ...patch };
    entries = entries.map(x => (x === current ? next : x));
    current = next;
    emit();
  };
}

/** 每次有改動都係新 array（useSyncExternalStore 要求） */
export function getApiLog(): readonly ApiLogEntry[] {
  return entries;
}

export function subscribeApiLog(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
