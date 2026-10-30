import proj4 from 'proj4';
import { ENDPOINTS, apiUrl } from '../config';
import { fetchJson } from './fetchJson';

/** HK1980 Grid (EPSG:2326)，7 參數轉換。離線後備精度約 1–2 m，足夠搵附近大廈。 */
const HK80 =
  '+proj=tmerc +lat_0=22.31213333333334 +lon_0=114.1785555555556 +k=1 +x_0=836694.05 +y_0=819069.8 ' +
  '+ellps=intl +towgs84=-162.619,-276.959,-161.764,0.067753,-2.243648,-1.158828,-1.094246 +units=m +no_defs';

export interface HK80Point {
  /** Easting (m) */
  x: number;
  /** Northing (m) */
  y: number;
  source: 'landsd-api' | 'local';
}

export function wgs84ToHK80Local(lat: number, lng: number): HK80Point {
  const [x, y] = proj4('EPSG:4326', HK80, [lng, lat]);
  return { x, y, source: 'local' };
}

/** 回應格式按版本略有不同（hkE/hkN、E/N…），用 key 名寬鬆辨認 */
export function parseTransformResponse(json: unknown): { x: number; y: number } | null {
  if (!json || typeof json !== 'object') return null;
  let x: number | undefined;
  let y: number | undefined;
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) continue;
    if (/^(hk)?e(asting)?$/i.test(k)) x = n;
    else if (/^(hk)?n(orthing)?$/i.test(k)) y = n;
  }
  // 香港方格網合理範圍
  if (x === undefined || y === undefined || x < 790000 || x > 880000 || y < 790000 || y > 850000) return null;
  return { x, y };
}

/**
 * WGS84 -> HK80：優先用地政總署坐標轉換 API（官方、測量級），
 * 失敗（CORS / 逾時 / 格式唔啱）就用本機 proj4，保證流程唔會斷。
 */
export async function wgs84ToHK80(lat: number, lng: number, signal?: AbortSignal): Promise<HK80Point> {
  const url = `${ENDPOINTS.transform}?inSys=wgsgeog&outSys=hkgrid&lat=${lat.toFixed(7)}&long=${lng.toFixed(7)}`;
  try {
    const p = parseTransformResponse(await fetchJson(apiUrl(url), { timeoutMs: 3000, signal }));
    if (p) return { ...p, source: 'landsd-api' };
  } catch (e) {
    if (signal?.aborted) throw e;
  }
  return wgs84ToHK80Local(lat, lng);
}
