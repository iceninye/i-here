/**
 * Marker 插值 / 外推（PLAN §4.4）
 *
 * 兩個 GPS update（~1 Hz）之間，用 fix 嘅 `speed` + `heading` 外推「我」marker 嘅位置，
 * 令移動時標記平滑移動而唔係一跳一跳。
 *
 * 嚴格限制（避免外推錯誤位置誤導用戶）：
 *  - 只喺 `speed` 同 `heading` 都已知時做（任一未知 → 唔外推，直接snap）。
 *  - 只喺 `accuracy <= maxAccuracyM`（默認 30 m）時做 —— 粗略 fix 外推只會放大誤差。
 *  - 最多外推 `maxSeconds`（默認 1.5 s）—— 超出就当冇新訊號，停喺最後位置。
 *  - 距離好短（≤ 數十米），用等距圆柱近似已夠準，唔使 vincenty。
 */

import type { Fix } from './geo';

export interface ExtrapolateOptions {
  /** 最多外推幾多秒（默認 1.5） */
  maxSeconds?: number;
  /** 精度差過呢個值就唔外推（默認 30 m） */
  maxAccuracyM?: number;
}

const METERS_PER_DEG_LAT = 111320;

/**
 * 由 `fix` 外推 `dtSeconds` 之後嘅位置。唔符合外推條件就回 `null`（呼叫方應直接 snap 去 fix）。
 * 回傳嘅 lat/lng 一定係有限數值。
 */
export function extrapolateFix(fix: Fix, dtSeconds: number, opts: ExtrapolateOptions = {}): { lat: number; lng: number } | null {
  const maxSeconds = opts.maxSeconds ?? 1.5;
  const maxAccuracyM = opts.maxAccuracyM ?? 30;

  if (fix.speed === undefined || fix.heading === undefined) return null;
  if (!Number.isFinite(fix.accuracy) || fix.accuracy > maxAccuracyM) return null;
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return null;

  // 限幅：負數當 0，超過 maxSeconds 就截斷（停喺最後外推位置，唔好越飄越遠）
  const dt = Math.min(dtSeconds, maxSeconds);
  const dist = fix.speed * dt; // 米
  if (!Number.isFinite(dist) || dist <= 0) return null;

  const bearing = (fix.heading * Math.PI) / 180; // 0 = 正北，順時針
  const dLat = (dist * Math.cos(bearing)) / METERS_PER_DEG_LAT;
  const cosLat = Math.cos((fix.lat * Math.PI) / 180);
  // 極地附近 cosLat → 0 會爆；香港唔會發生，但保守 clamp 避免除以 0
  const dLng = (dist * Math.sin(bearing)) / (METERS_PER_DEG_LAT * (Math.abs(cosLat) < 1e-6 ? 1e-6 : cosLat));

  const lat = fix.lat + dLat;
  const lng = fix.lng + dLng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}
