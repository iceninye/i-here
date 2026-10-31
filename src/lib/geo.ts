/**
 * 定位核心 —— 由 mtr-app (v52.x) 嘅 acquireBestPosition / handleGeoFix 移植並改良：
 *  1. 取樣窗：watchPosition 收集多個 fix，保留精度最好嗰個（第一個 fix 通常係粗略 Wi-Fi / 基站估算）。
 *  2. 提早完成：精度 <= GOOD_ACCURACY_M 即刻停。
 *  3. 合法性關卡：座標要有限數值、喺香港範圍內。
 *  4. 新增：每個更好嘅 fix 都即時回報 (onFix)，地圖可以先出點、慢慢收窄，唔使等成個取樣窗。
 *  5. 改動：精度差（> POOR_ACCURACY_M）唔再拒絕 —— 對迷路長者嚟講「大概位置」好過「冇位置」，
 *     改為顯示警告並提示走去空曠地方。
 */

export interface Fix {
  lat: number;
  lng: number;
  /** 米，95% 信心半徑（瀏覽器定義） */
  accuracy: number;
  timestamp: number;
}

export type GeoErrorCode = 'denied' | 'unavailable' | 'timeout' | 'unsupported' | 'outside-hk';

export class GeoError extends Error {
  constructor(public code: GeoErrorCode, message?: string) {
    super(message ?? code);
  }
}

export const GEO = {
  /** 收集 fix 嘅時間窗 */
  SAMPLE_WINDOW_MS: 8000,
  /** 好到可以提早停 */
  GOOD_ACCURACY_M: 30,
  /** 超過就顯示「定位不準確」警告（但仍然顯示） */
  POOR_ACCURACY_M: 150,
  /** 冷啟動可以用幾秒內嘅快取 fix，令地圖即刻有點 */
  INITIAL_MAX_AGE_MS: 5000,
  TIMEOUT_MS: 10000,
} as const;

export function isInHongKong(lat: number, lng: number): boolean {
  // 香港 + 鄰近水域嘅範圍（比 mtr-app 嘅 20–24 / 113–115 收窄；北邊同深圳交界一帶無可避免重疊，
  // 嗰度 identify API 自然搵唔到大廈，UI 會退回只顯示座標）
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= 22.13 && lat <= 22.58 && lng >= 113.82 && lng <= 114.45;
}

export function toFix(pos: GeolocationPosition): Fix | null {
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  return { lat, lng, accuracy: Number.isFinite(accuracy) ? accuracy : Infinity, timestamp: pos.timestamp };
}

export function geoErrorFrom(err: GeolocationPositionError | { code: number; message?: string }): GeoError {
  if (err.code === 1) return new GeoError('denied', err.message);
  if (err.code === 3) return new GeoError('timeout', err.message);
  return new GeoError('unavailable', err.message);
}

/**
 * 反變差加權融合 —— 將取樣窗內多個 fix 合成一個更準嘅位置。
 * 權重 = 1/accuracy²（越準嘅 fix 話語權越大）。融合後嘅精度取
 * min(1/√Σw, 最準單獨 fix)：統計上唔會好過最好嗰個觀測，但通常更穩定。
 * 全部座標只喺本機計算，唔會上傳。
 */
export function fuseFixes(fixes: Fix[]): Fix | null {
  const valid = fixes.filter(f => Number.isFinite(f.accuracy) && f.accuracy > 0);
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];

  let sumW = 0;
  let wLat = 0;
  let wLng = 0;
  let ts = 0;
  let best = Infinity;
  for (const f of valid) {
    const w = 1 / (f.accuracy * f.accuracy);
    sumW += w;
    wLat += w * f.lat;
    wLng += w * f.lng;
    if (f.timestamp > ts) ts = f.timestamp;
    if (f.accuracy < best) best = f.accuracy;
  }
  const accuracy = Math.max(1, Math.min(1 / Math.sqrt(sumW), best));
  return { lat: wLat / sumW, lng: wLng / sumW, accuracy, timestamp: ts };
}

/**
 * 剔除離群 fix —— 距離臨時融合中心太遠（> 2.5× 最準精度，最少 60m）就丟走，
 * 避免一個漂移嘅基站/Wi-Fi 估算污染融合結果。少於 3 個樣本唔做（無從判斷）。
 */
export function rejectOutliers(fixes: Fix[]): Fix[] {
  if (fixes.length < 3) return fixes;
  const centre = fuseFixes(fixes);
  if (!centre) return fixes;
  const best = Math.min(...fixes.map(f => f.accuracy));
  const limit = Math.max(2.5 * best, 60);
  const kept = fixes.filter(f => haversineM(f.lat, f.lng, centre.lat, centre.lng) <= limit);
  return kept.length >= 1 ? kept : fixes;
}

export interface AcquireOptions {
  maxAgeMs?: number;
  windowMs?: number;
  goodAccuracyM?: number;
  /** 每當有更準嘅 fix 就 call（包括第一個） */
  onFix?: (fix: Fix) => void;
  /** 每個合法 fix 都 call（包括冇更準嘅），畀量度用 */
  onSample?: (fix: Fix) => void;
  signal?: AbortSignal;
  geolocation?: Geolocation;
}

/**
 * 喺取樣窗內收集 fix，resolve 最準嗰個。位置只喺本機處理；watch 一定會被清除。
 * Reject GeoError（冇任何 fix 時）；signal abort 時 resolve 目前最好嘅 fix 或 reject 'timeout'。
 */
export function acquireBestFix(opts: AcquireOptions = {}): Promise<Fix> {
  const geo = opts.geolocation ?? (typeof navigator !== 'undefined' ? navigator.geolocation : undefined);
  const windowMs = opts.windowMs ?? GEO.SAMPLE_WINDOW_MS;
  const good = opts.goodAccuracyM ?? GEO.GOOD_ACCURACY_M;

  return new Promise<Fix>((resolve, reject) => {
    if (!geo) return reject(new GeoError('unsupported'));
    let best: Fix | null = null;
    const samples: Fix[] = [];
    let done = false;
    let watchId: number | null = null;

    const finish = (err?: GeoError) => {
      if (done) return;
      done = true;
      if (watchId !== null) geo.clearWatch(watchId);
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      // 融合所有合法樣本（先剔離群）；得返一個 / 冇樣本時退回最準嗰個
      const result = fuseFixes(rejectOutliers(samples)) ?? best;
      if (result) resolve(result);
      else reject(err ?? new GeoError('timeout'));
    };
    const onAbort = () => finish(new GeoError('timeout', 'aborted'));

    watchId = geo.watchPosition(
      pos => {
        const fix = toFix(pos);
        if (!fix) return;
        opts.onSample?.(fix);
        samples.push(fix);
        if (!best || fix.accuracy < best.accuracy) {
          best = fix;
          opts.onFix?.(fix);
        }
        if (fix.accuracy <= good) finish();
      },
      // 已經有 fix 就繼續等；冇 fix 先當失敗
      err => { if (!best || err.code === 1) finish(geoErrorFrom(err)); },
      { enableHighAccuracy: true, timeout: GEO.TIMEOUT_MS, maximumAge: opts.maxAgeMs ?? 0 },
    );
    const timer = setTimeout(() => finish(), windowMs);
    opts.signal?.addEventListener('abort', onAbort);
  });
}

/** 兩點距離（米） */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 精度圈 polygon（GeoJSON [lng, lat]） */
export function circlePolygon(lat: number, lng: number, radiusM: number, steps = 64): [number, number][] {
  const coords: [number, number][] = [];
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    coords.push([lng + dLng * Math.cos(t), lat + dLat * Math.sin(t)]);
  }
  return coords;
}
