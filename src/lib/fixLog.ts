import type { Fix } from './geo';

/**
 * 原始定位紀錄（只存喺記憶體，最多 300 條），畀 ?debug=1 面板匯出 CSV。
 * 用途：喺已知位置（例如港鐵出口）行幾次，量度真實誤差，再決定融合 / 平滑做幾多。
 */
export interface FixSample extends Fix {
  /** 距離上一個 fix 嘅秒數 */
  dt: number;
}

let samples: readonly FixSample[] = [];
const listeners = new Set<() => void>();

export function logFix(f: Fix): void {
  const prev = samples[samples.length - 1];
  const dt = prev ? (f.timestamp - prev.timestamp) / 1000 : 0;
  samples = [...samples, { ...f, dt }].slice(-300);
  listeners.forEach(l => l());
}

export function getFixLog(): readonly FixSample[] {
  return samples;
}

export function subscribeFixLog(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function fixLogCsv(list: readonly FixSample[] = samples): string {
  return ['iso_time,lat,lng,accuracy_m,dt_s',
    ...list.map(s => `${new Date(s.timestamp).toISOString()},${s.lat.toFixed(7)},${s.lng.toFixed(7)},${Number.isFinite(s.accuracy) ? s.accuracy.toFixed(1) : ''},${s.dt.toFixed(1)}`),
  ].join('\n');
}
