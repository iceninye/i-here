import { ENDPOINTS, OSM_FALLBACK } from '../config';
import { fetchJson } from './fetchJson';
import { haversineM } from './geo';
import type { HK80Point } from './hk80';

/**
 * 地名類別。排序用：建築物 / 屋苑 > 交通 > 店舖 > 設施 > 街道。
 * 標題要係「你身處嘅地方」，唔可以係 WiFi 熱點、郵箱、路旁泊車位呢類設施。
 */
export type PlaceKind = 'building' | 'estate' | 'transport' | 'shop' | 'facility' | 'street' | 'other';

/** 附近一個可以讀出嚟嘅地方（大廈 / 屋邨 / 設施 / 地標） */
export interface PlaceCandidate {
  name: string;
  address?: string;
  /** 同使用者嘅距離（米）；冇座標時係 NaN */
  distanceM: number;
  kind: PlaceKind;
}

export type PlaceSource = 'identify' | 'nearby' | 'osm';

export interface ResolvedPlace {
  /** 大字顯示：「興輝樓」 */
  name: string;
  /** 「就喺度」/「附近」— 按距離揀 */
  proximity: 'at' | 'near';
  distanceM: number;
  kind: PlaceKind;
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

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/* ---------------- 分類 ---------------- */

/** 絕對唔可以做標題嘅設施（實測 searchNearby 最前面幾乎全係呢啲） */
const TITLE_BLACKLIST = [
  /wi-?fi|熱點/i,
  /郵箱|郵筒|信箱|郵政信箱/,
  /泊車位|停車位|咪錶|路旁|電動車|充電/,
  /停車場|泊車處|car ?park/i,
  /除顫器|\baed\b/i,
  /回收|垃圾|食水|飲水/,
  /公廁|公共廁所|洗手間|廁所/,
  /燈柱|交通燈|行人過路|巴士站牌|電話亭/,
];

export function isTitleEligible(name: string): boolean {
  return !TITLE_BLACKLIST.some(r => r.test(name));
}

const TRANSPORT = /站$|碼頭|總站|轉車站|渡輪|機場|口岸|隧道/;
const ESTATE = /邨|苑|花園|廣場|中心|大廈|大樓|商場|閣|居|軒|匯|城|樓|山莊|園$/;
const STREET = /[路街道里徑巷]$/;

export function classifyName(name: string, addressType?: string | null): PlaceKind {
  if (addressType === 'B') return TRANSPORT.test(name) ? 'transport' : ESTATE.test(name) ? 'estate' : 'building';
  if (TRANSPORT.test(name)) return 'transport';
  if (ESTATE.test(name)) return 'estate';
  if (STREET.test(name)) return 'street';
  return addressType ? 'other' : 'facility';
}

/**
 * 標題分數 = 距離（米）+ 類別罰分，越低越好。
 * 例：40 m 外嘅大廈（40）勝過 10 m 外嘅店舖（10+40=50）；5 m 嘅店舖（45）勝過 60 m 外嘅大廈（60）。
 */
const KIND_PENALTY: Record<PlaceKind, number> = {
  building: 0, estate: 0, transport: 20, shop: 40, facility: 60, street: 130, other: 150,
};
/** 標題最遠距離（米）；店舖 / 設施要更近 */
const KIND_MAX_M: Record<PlaceKind, number> = {
  building: 300, estate: 300, transport: 250, shop: 50, facility: 120, street: 150, other: 150,
};

function eligibleAsTitle(c: PlaceCandidate): boolean {
  return isTitleEligible(c.name) && Number.isFinite(c.distanceM) && c.distanceM <= KIND_MAX_M[c.kind];
}

export function pickTitle(cands: PlaceCandidate[]): PlaceCandidate | undefined {
  return cands
    .filter(eligibleAsTitle)
    .sort((a, b) => a.distanceM + KIND_PENALTY[a.kind] - (b.distanceM + KIND_PENALTY[b.kind]))[0];
}

/** 「附近還有」：唔重複標題、唔係黑名單、300 米內、近到遠、最多 3 個 */
export function pickLandmarks(cands: PlaceCandidate[], title: PlaceCandidate): PlaceCandidate[] {
  return cands
    .filter(c => c.name !== title.name && isTitleEligible(c.name) && Number.isFinite(c.distanceM) && c.distanceM <= 300)
    .sort((a, b) => a.distanceM - b.distanceM)
    .filter((c, i, arr) => arr.findIndex(o => o.name === c.name) === i)
    .slice(0, 3);
}

function distanceTo(o: Record<string, unknown>, origin: Origin): number {
  const x = num(o.x);
  const y = num(o.y);
  if (x !== undefined && y !== undefined && x > 790000 && x < 880000 && y > 790000 && y < 850000) {
    return Math.hypot(x - origin.x, y - origin.y);
  }
  const lat = num(o.lat ?? o.latitude);
  const lng = num(o.lng ?? o.lon ?? o.long ?? o.longitude);
  if (lat !== undefined && lng !== undefined && Math.abs(lat - 22.3) < 1 && Math.abs(lng - 114.1) < 1) {
    return haversineM(lat, lng, origin.lat, origin.lng);
  }
  return NaN;
}

/* ---------------- identify ---------------- */

/**
 * identify 回應（實測）：
 *   { results: [ { type: 'ADDRESS', addressInfo: [ { cname, ename, caddress, eaddress, addressType: 'B', x, y,
 *                   hashTag, facility: [ …嵌套嘅設施（AED 等）… ] } ] } ] }
 * 只讀第一層 addressInfo；嵌套嘅 `facility` 係呢幢大廈入面嘅設施，唔係你所在嘅地方，所以唔讀。
 */
export function parseIdentify(json: unknown, origin: Origin): PlaceCandidate[] {
  const results = isRecord(json) && Array.isArray(json.results) ? json.results : [];
  const out: PlaceCandidate[] = [];
  for (const r of results) {
    const infos = isRecord(r) && Array.isArray(r.addressInfo) ? r.addressInfo : [];
    for (const item of infos) {
      if (!isRecord(item)) continue;
      const name = str(item.cname) ?? str(item.ename);
      if (!name) continue;
      out.push({
        name,
        address: str(item.caddress) ?? str(item.eaddress),
        distanceM: distanceTo(item, origin),
        kind: classifyName(name, str(item.addressType) ?? 'B'),
      });
    }
  }
  return out;
}

/* ---------------- searchNearby ---------------- */

/**
 * searchNearby：未有完整真實 fixture（debug 面板「複製原始回應」可以錄低）。
 * 所以呢度只收「陣列（或 results / data / items 入面嘅陣列）+ 明確嘅名稱 key」，唔再做模糊搵 key。
 * 回應冇距離上限（實測 582–1438 項），距離同黑名單都喺 pickTitle / pickLandmarks 篩。
 */
const NEARBY_NAME_KEYS = ['cname', 'nameZH', 'nameTC', 'name', 'ename', 'nameEN'];
const NEARBY_ADDR_KEYS = ['caddress', 'addressZH', 'addressTC', 'address', 'eaddress', 'addressEN'];

export function parseNearby(json: unknown, origin: Origin): PlaceCandidate[] {
  const list = Array.isArray(json)
    ? json
    : isRecord(json)
      ? [json.results, json.data, json.items, json.addressInfo].find(Array.isArray) ?? []
      : [];
  const out: PlaceCandidate[] = [];
  for (const item of list as unknown[]) {
    if (!isRecord(item)) continue;
    const name = NEARBY_NAME_KEYS.map(k => str(item[k])).find(Boolean);
    if (!name) continue;
    out.push({
      name,
      address: NEARBY_ADDR_KEYS.map(k => str(item[k])).find(Boolean),
      distanceM: distanceTo(item, origin),
      kind: classifyName(name),
    });
  }
  return out;
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
    kind: classifyName(name),
  };
}

/* ---------------- 組合 ---------------- */

/** 25 m 內當「就喺呢度」，否則「附近」 */
const AT_THRESHOLD_M = 25;
/** 每個來源最多等幾耐。 */
const SOURCE_TIMEOUT_MS = 5000;

function toPlace(c: PlaceCandidate, source: PlaceSource, landmarks: PlaceCandidate[]): ResolvedPlace {
  return {
    name: c.name,
    proximity: c.distanceM <= AT_THRESHOLD_M ? 'at' : 'near',
    distanceM: c.distanceM,
    kind: c.kind,
    address: c.address,
    landmarks,
    source,
  };
}

async function tryParse<T>(
  url: string,
  name: string,
  parse: (json: unknown) => T[],
  signal?: AbortSignal,
): Promise<T[]> {
  try {
    return parse(await fetchJson(url, { signal, timeoutMs: SOURCE_TIMEOUT_MS, name }));
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

async function lookupAls(title: PlaceCandidate, p: HK80Point, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const q = encodeURIComponent(title.address ? `${title.name} ${title.address}` : title.name);
    return pickAlsAddress(await fetchJson(`${ENDPOINTS.als}?q=${q}&n=5`, { signal, timeoutMs: 4000, name: 'ALS' }), p);
  } catch (e) {
    if (signal?.aborted) throw e;
    return undefined; // ALS 失敗唔緊要，用來源本身嘅地址
  }
}

/**
 * HK80 → 地方名 + 地址：
 *  1. identify（所在大廈）同 searchNearby（附近設施）並行
 *  2. identify 一回（~0.7 s）就揀標題並 onPartial，畫面即刻有字；之後 ALS 補官方門牌地址，同 searchNearby 並行
 *  3. identify 冇可用標題 → 等 searchNearby，經分類 / 黑名單 / 距離篩選後揀
 *  4. 全部冇 → 只有 build 時開咗 VITE_OSM_FALLBACK 先會問 OpenStreetMap；否則回 null（畫面只顯示座標，仍可分享）
 */
export async function reverseGeocode(
  p: HK80Point,
  at: { lat: number; lng: number },
  signal?: AbortSignal,
  onPartial?: (place: ResolvedPlace) => void,
): Promise<ResolvedPlace | null> {
  const origin: Origin = { x: p.x, y: p.y, lat: at.lat, lng: at.lng };
  const qs = `x=${Math.round(p.x)}&y=${Math.round(p.y)}&lang=zh`;

  const identifyP = tryParse(`${ENDPOINTS.identify}?${qs}`, 'identify', j => parseIdentify(j, origin), signal);
  const nearbyP = tryParse(`${ENDPOINTS.searchNearby}?${qs}`, 'searchNearby', j => parseNearby(j, origin), signal);

  const identified = await identifyP;
  let title = pickTitle(identified);
  let source: PlaceSource = 'identify';

  if (title) {
    onPartial?.(toPlace(title, source, pickLandmarks(identified, title)));
  }

  // identify 已有標題：ALS 同 searchNearby 並行；否則先等 searchNearby
  const nearby = title ? undefined : await nearbyP;
  if (!title && nearby) {
    title = pickTitle(nearby);
    source = 'nearby';
    if (title) onPartial?.(toPlace(title, source, pickLandmarks([...identified, ...nearby], title)));
  }

  if (!title && OSM_FALLBACK) {
    const osm = await tryOsm(origin, signal);
    if (osm) { title = osm; source = 'osm'; onPartial?.(toPlace(osm, source, [])); }
  }
  if (!title) return null;

  const chosen = title;
  const [address, nearbyAll] = await Promise.all([lookupAls(chosen, p, signal), nearby ?? nearbyP]);
  return {
    ...toPlace(chosen, source, pickLandmarks([...identified, ...nearbyAll], chosen)),
    address: address ?? chosen.address,
  };
}
