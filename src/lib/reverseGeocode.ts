import { ENDPOINTS, apiUrl } from '../config';
import { fetchJson } from './fetchJson';
import { haversineM } from './geo';
import type { HK80Point } from './hk80';

/** 附近一個可以讀出嚟嘅地方（大廈 / 屋邨 / 設施 / 地標） */
export interface PlaceCandidate {
  name: string;
  address?: string;
  /** 同使用者嘅距離（米）；回應冇座標時係 NaN */
  distanceM: number;
}

export type PlaceSource = 'identify' | 'nearby' | 'osm';

export interface ResolvedPlace {
  /** 大字顯示：「興輝樓」 */
  name: string;
  /** 「就喺度」/「附近」— 按距離揀 */
  proximity: 'at' | 'near';
  distanceM: number;
  /** 官方門牌地址（ALS 補全；冇就用來源本身嘅地址） */
  address?: string;
  /** 另外幾個附近地標，幫手對照 */
  landmarks: PlaceCandidate[];
  source: PlaceSource;
}

export interface Origin {
  /** HK80 */
  x: number;
  y: number;
  lat: number;
  lng: number;
}

const NAME_KEYS = ['nameZH', 'nameTC', 'nameZh', 'cname', 'cName', 'chineseName', 'chiName', 'name_zh', 'name', 'nameEN', 'ename'];
const ADDR_KEYS = ['addressZH', 'addressTC', 'addressZh', 'caddress', 'cAddress', 'chineseAddress', 'chiAddress', 'address_zh', 'address', 'addressEN', 'eaddress'];
/** 呢啲 key 雖然有 "name"，但係圖層 / 類別名，唔係地方名 */
const NOT_PLACE_KEY = /layer|type|class|categ|field|alias|display|source|district|region/i;
const CJK = /[㐀-鿿]/;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** 先試已知 key；再試任何「似地方名」嘅 key，中文優先 */
function pickName(o: Record<string, unknown>): string | undefined {
  const known = NAME_KEYS.map(k => str(o[k])).filter((v): v is string => !!v);
  const fuzzy = Object.entries(o)
    .filter(([k]) => /name/i.test(k) && !NOT_PLACE_KEY.test(k) && !NAME_KEYS.includes(k))
    .map(([, v]) => str(v))
    .filter((v): v is string => !!v);
  const all = [...known, ...fuzzy].filter(v => !/^[\d\s\-.]+$/.test(v));
  return all.find(v => CJK.test(v)) ?? all[0];
}

function pickAddress(o: Record<string, unknown>): string | undefined {
  const known = ADDR_KEYS.map(k => str(o[k])).filter((v): v is string => !!v);
  const fuzzy = Object.entries(o)
    .filter(([k]) => /addr/i.test(k) && !ADDR_KEYS.includes(k))
    .map(([, v]) => str(v))
    .filter((v): v is string => !!v);
  const all = [...known, ...fuzzy];
  return all.find(v => CJK.test(v)) ?? all[0];
}

function distanceTo(o: Record<string, unknown>, origin: Origin): number {
  const x = num(o.x ?? o.X ?? o.easting ?? o.Easting ?? o.hkE ?? o.E);
  const y = num(o.y ?? o.Y ?? o.northing ?? o.Northing ?? o.hkN ?? o.N);
  if (x !== undefined && y !== undefined && x > 790000 && x < 880000 && y > 790000 && y < 850000) {
    return Math.hypot(x - origin.x, y - origin.y);
  }
  const lat = num(o.lat ?? o.latitude ?? o.Latitude);
  const lng = num(o.lng ?? o.lon ?? o.long ?? o.longitude ?? o.Longitude);
  if (lat !== undefined && lng !== undefined && Math.abs(lat - 22.3) < 1 && Math.abs(lng - 114.1) < 1) {
    return haversineM(lat, lng, origin.lat, origin.lng);
  }
  return NaN;
}

/**
 * 地政總署 identify / searchNearby 嘅回應結構未有公開 schema，而欄位名喺唔同圖層之間唔一致。
 * 呢度唔假設固定結構：遞迴搵所有「有地方名」嘅 object，有座標就計距離。
 * 有距離嘅排前（近到遠），冇距離嘅保持原本次序排後。
 */
export function extractCandidates(json: unknown, origin: Origin): PlaceCandidate[] {
  const out: PlaceCandidate[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, depth: number) => {
    if (depth > 8 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(n => walk(n, depth + 1));
    const o = node as Record<string, unknown>;
    const name = pickName(o);
    if (name) {
      const distanceM = distanceTo(o, origin);
      const key = `${name}|${Number.isFinite(distanceM) ? Math.round(distanceM) : ''}`;
      if (!seen.has(name) && !seen.has(key)) {
        seen.add(name);
        seen.add(key);
        out.push({ name, address: pickAddress(o), distanceM });
      }
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  walk(json, 0);
  const withD = out.filter(c => Number.isFinite(c.distanceM)).sort((a, b) => a.distanceM - b.distanceM);
  return [...withD, ...out.filter(c => !Number.isFinite(c.distanceM))];
}

/* ---------------- OGCIO ALS ---------------- */

interface AlsChiAddress {
  Region?: string;
  ChiDistrict?: { DcDistrict?: string };
  ChiStreet?: { StreetName?: string; BuildingNoFrom?: string; BuildingNoTo?: string };
  ChiVillage?: { VillageName?: string; BuildingNoFrom?: string };
  ChiEstate?: { EstateName?: string };
  ChiBlock?: { BlockDescriptor?: string; BlockNo?: string };
  BuildingName?: string;
}
interface AlsSuggested {
  Address?: {
    PremisesAddress?: {
      ChiPremisesAddress?: AlsChiAddress;
      GeospatialInformation?: { Easting?: string | number; Northing?: string | number };
    };
  };
}

/** ALS 中文地址 → 香港慣用次序：區域 > 地區 > 街道門牌 > 屋邨 > 大廈 */
export function formatAlsChinese(a: AlsChiAddress): string {
  const street = a.ChiStreet?.StreetName
    ? `${a.ChiStreet.StreetName}${a.ChiStreet.BuildingNoFrom ? `${a.ChiStreet.BuildingNoFrom}${a.ChiStreet.BuildingNoTo ? `-${a.ChiStreet.BuildingNoTo}` : ''}號` : ''}`
    : '';
  const village = a.ChiVillage?.VillageName
    ? `${a.ChiVillage.VillageName}${a.ChiVillage.BuildingNoFrom ? `${a.ChiVillage.BuildingNoFrom}號` : ''}`
    : '';
  const block = a.ChiBlock?.BlockNo ? `${a.ChiBlock.BlockNo}${a.ChiBlock.BlockDescriptor ?? ''}` : '';
  return [a.Region, a.ChiDistrict?.DcDistrict, street || village, a.ChiEstate?.EstateName, a.BuildingName, block]
    .filter(Boolean)
    .join('');
}

/** 由 ALS 結果中揀離 origin 最近（< maxM）嗰個，避免同名大廈（例如多個「富豪花園」）搞錯 */
export function pickAlsAddress(json: unknown, origin: { x: number; y: number }, maxM = 250): string | undefined {
  const list = (json as { SuggestedAddress?: AlsSuggested[] } | null)?.SuggestedAddress ?? [];
  let best: { d: number; text: string } | undefined;
  for (const s of list) {
    const pa = s.Address?.PremisesAddress;
    const chi = pa?.ChiPremisesAddress;
    const e = num(pa?.GeospatialInformation?.Easting);
    const n = num(pa?.GeospatialInformation?.Northing);
    if (!chi || e === undefined || n === undefined) continue;
    const d = Math.hypot(e - origin.x, n - origin.y);
    const text = formatAlsChinese(chi);
    if (text && d <= maxM && (!best || d < best.d)) best = { d, text };
  }
  return best?.text;
}

/* ---------------- OpenStreetMap 後備 ---------------- */

interface NominatimResult {
  name?: string;
  display_name?: string;
  lat?: string;
  lon?: string;
  address?: Record<string, string>;
}

/** Nominatim → 地方名 + 中文地址（大→細次序） */
export function parseNominatim(json: unknown, origin: Origin): PlaceCandidate | null {
  const r = json as NominatimResult | null;
  if (!r || typeof r !== 'object' || !r.address) return null;
  const a = r.address;
  const road = a.road ? `${a.road}${a.house_number ? `${a.house_number}號` : ''}` : undefined;
  const name = str(r.name) ?? a.building ?? a.amenity ?? a.shop ?? a.leisure ?? a.tourism ?? road ?? a.neighbourhood ?? a.suburb;
  if (!name) return null;
  const parts = [a.state, a.city_district ?? a.city ?? a.county, a.suburb, a.neighbourhood ?? a.quarter, road]
    .filter((v): v is string => !!v && v !== name);
  const address = [...new Set(parts)].join('') || undefined;
  const lat = num(r.lat);
  const lng = num(r.lon);
  return {
    name,
    address,
    distanceM: lat !== undefined && lng !== undefined ? haversineM(lat, lng, origin.lat, origin.lng) : NaN,
  };
}

/* ---------------- 組合 ---------------- */

/** 25 m 內當「就喺呢度」，否則「附近」 */
const AT_THRESHOLD_M = 25;
/** identify 冇俾座標時，當佢就喺查詢點 */
const assumeAtPoint = (c: PlaceCandidate): PlaceCandidate =>
  Number.isFinite(c.distanceM) ? c : { ...c, distanceM: 0 };

async function tryExtract(url: string, name: string, origin: Origin, signal?: AbortSignal): Promise<PlaceCandidate[]> {
  try {
    return extractCandidates(await fetchJson(apiUrl(url), { signal, timeoutMs: SOURCE_TIMEOUT_MS, name }), origin);
  } catch (e) {
    if (signal?.aborted) throw e;
    return [];
  }
}

async function tryOsm(origin: Origin, signal?: AbortSignal): Promise<PlaceCandidate | null> {
  try {
    const url = `${ENDPOINTS.nominatim}?format=jsonv2&lat=${origin.lat.toFixed(6)}&lon=${origin.lng.toFixed(6)}` +
      '&zoom=18&addressdetails=1&accept-language=zh-HK,zh-Hant,zh';
    const osm = parseNominatim(await fetchJson(url, { signal, timeoutMs: SOURCE_TIMEOUT_MS, name: 'OpenStreetMap' }), origin);
    return osm && !Number.isFinite(osm.distanceM) ? { ...osm, distanceM: 0 } : osm;
  } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  }
}

function toPlace(c: PlaceCandidate, source: PlaceSource, landmarks: PlaceCandidate[]): ResolvedPlace {
  return {
    name: c.name,
    proximity: c.distanceM <= AT_THRESHOLD_M ? 'at' : 'near',
    distanceM: c.distanceM,
    address: c.address,
    landmarks,
    source,
  };
}

/** 每個來源最多等幾耐。全部並行，所以最差情況係呢個時間 + ALS，而唔係逐個加埋。 */
const SOURCE_TIMEOUT_MS = 5000;

/**
 * HK80 → 地方名 + 地址：
 *  1. identify（www.map.gov.hk 同 geodata.gov.hk 鏡像）、searchNearby、OpenStreetMap **全部並行**
 *     （實測政府 API 喺手機上可以好慢，逐個試要 20 秒以上）
 *  2. 揀地名：identify > 最近嘅 searchNearby 設施 > OpenStreetMap
 *  3. onPartial：OSM 一到先回報一次（暫時），政府 API 答完再回報揀好嘅地名，畫面即刻有字
 *  4. 有地名就用 ALS 補官方門牌地址，回傳完整結果
 */
export async function reverseGeocode(
  p: HK80Point,
  at: { lat: number; lng: number },
  signal?: AbortSignal,
  onPartial?: (place: ResolvedPlace) => void,
): Promise<ResolvedPlace | null> {
  const origin: Origin = { x: p.x, y: p.y, lat: at.lat, lng: at.lng };
  const qs = `x=${Math.round(p.x)}&y=${Math.round(p.y)}&lang=zh`;

  let govDone = false;
  const osmP = tryOsm(origin, signal).then(osm => {
    // OSM 通常最快（實測 ~0.3 s）；政府 API 未答就先顯示 OSM 結果，之後再換成官方地名
    if (osm && !govDone) onPartial?.(toPlace(osm, 'osm', []));
    return osm;
  });
  const [main, mirror, nearby] = await Promise.all([
    tryExtract(`${ENDPOINTS.identify}?${qs}`, 'identify', origin, signal),
    tryExtract(`${ENDPOINTS.identifyAlt}?${qs}`, 'identify (geodata)', origin, signal),
    tryExtract(`${ENDPOINTS.searchNearby}?${qs}`, 'searchNearby', origin, signal),
  ]);
  govDone = true;
  const osm = await osmP;
  const identified = main.length ? main : mirror;

  let source: PlaceSource = 'identify';
  let top: PlaceCandidate | undefined = identified.map(assumeAtPoint)[0];
  const nearbySorted = nearby.filter(c => Number.isFinite(c.distanceM));
  // identify 個點冇嘢（例如企喺馬路 / 公園）→ 用最近嘅附近設施
  if (!top || (nearbySorted[0] && top.distanceM > nearbySorted[0].distanceM + 30)) {
    if (nearbySorted[0]) { top = nearbySorted[0]; source = 'nearby'; }
  }
  if (!top && osm) { top = osm; source = 'osm'; }
  if (!top) return null;
  const chosen = top;

  const landmarks = [...identified, ...nearbySorted]
    .filter(c => c.name !== chosen.name && Number.isFinite(c.distanceM) && c.distanceM <= 300)
    .sort((a, b) => a.distanceM - b.distanceM)
    .filter((c, i, arr) => arr.findIndex(o => o.name === c.name) === i)
    .slice(0, 3);

  const base = toPlace(chosen, source, landmarks);
  onPartial?.(base);

  try {
    const q = encodeURIComponent(chosen.address ? `${chosen.name} ${chosen.address}` : chosen.name);
    const als = await fetchJson(apiUrl(`${ENDPOINTS.als}?q=${q}&n=5`), { signal, timeoutMs: 4000, name: 'ALS' });
    const address = pickAlsAddress(als, p);
    if (address) return { ...base, address };
  } catch (e) {
    if (signal?.aborted) throw e;
    // ALS 失敗唔緊要，用來源本身嘅地址
  }
  return base;
}
