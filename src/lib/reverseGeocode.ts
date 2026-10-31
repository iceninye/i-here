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
  /** 呢個地方本身嘅 HK80 座標（街道冇）。ALS 要用佢核對「同名但唔同地方」 */
  x?: number;
  y?: number;
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

/** 純設施名稱：本身唔係「地方」，做標題或者「附近還有」都冇意義（實測 searchNearby 會回「升降機」） */
const GENERIC_FACILITY = new Set(['升降機', '扶手電梯', '扶手梯', '電梯', '樓梯', '通道', '行人通道']);

export function isTitleEligible(name: string): boolean {
  return !GENERIC_FACILITY.has(name) && !TITLE_BLACKLIST.some(r => r.test(name));
}

const TRANSPORT = /站$|進出口|出口|入口|碼頭|總站|轉車站|渡輪|機場|口岸|隧道/;
/**
 * 屋苑 / 商場 / 公園呢類「一片地方」：identify 會用 addressType S / P 直接講明，
 * searchNearby 冇類型，要靠名稱（例如「大埔道公園」）。
 */
const ESTATE = /邨|苑|花園|公園|遊樂場|廣場|商場|街市|體育館|山莊|村|中心|城$/;
/** 單幢建築物（興輝樓、某某大廈、A 座） */
const BUILDING = /大廈|大樓|樓|座|閣|居|軒|匯|塔/;
const SHOP = /便利店|超級市場|超市|餐廳|酒樓|麵包|藥房|藥行|銀行|診所|醫務中心|7-11|惠康|百佳|店$|舖$/;
const STREET = /[路街道里徑巷]$/;

/**
 * addressType（identify）：ST 街道、S 屋苑 / 村 / 地方名稱、P 建築物平台（例如柏瓏）、B 建築物、F 設施。
 * searchNearby 冇類型，靠名稱判斷。
 *
 * B 一律當「建築物」，除非名稱明顯係屋苑 / 商場（大興邨、康怡廣場）：
 * 「興輝樓」係一幢大廈，唔係一個屋苑，之後做「你喺呢幢大廈」高亮要靠呢個分別。
 */
export function classifyName(name: string, addressType?: string | null): PlaceKind {
  if (addressType === 'ST') return 'street';
  if (TRANSPORT.test(name)) return 'transport';
  if (addressType === 'S' || addressType === 'P') return 'estate';
  // 店舖要先試：「醫務中心」「…廣場店」都含屋苑字眼，但係舖頭（標題最遠 50 m，屋苑 300 m）
  if (SHOP.test(name)) return 'shop';
  if (ESTATE.test(name)) return 'estate';
  if (BUILDING.test(name) || addressType === 'B') return 'building';
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

function ownXY(o: Record<string, unknown>): { x?: number; y?: number } {
  const x = num(o.x);
  const y = num(o.y);
  return x !== undefined && y !== undefined && x > 790000 && x < 880000 && y > 790000 && y < 850000 ? { x, y } : {};
}

/* ---------------- identify ---------------- */

/**
 * identify 回應（實測）：
 *   { results: [ { type: 'ADDRESS', addressInfo: [ { cname, ename, caddress, eaddress, addressType: 'B', x, y,
 *                   hashTag, facility: [ …嵌套嘅設施（AED 等）… ] } ] } ] }
 * 只讀第一層 addressInfo；嵌套嘅 `facility` 係呢幢大廈入面嘅設施，唔係你所在嘅地方，所以唔讀。
 *
 * 街道（addressType 'ST'）冇座標（x、y 係 null），而且可以同時有幾條（路口，例如宏達路 + 媽橫路）。
 * identify 本身就係「呢個點有咩」嘅查詢，所以冇座標嘅結果當作就喺查詢點（距離 0）。
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
      const d = distanceTo(item, origin);
      out.push({
        name,
        address: str(item.caddress) ?? str(item.eaddress),
        distanceM: Number.isFinite(d) ? d : 0,
        kind: classifyName(name, str(item.addressType) ?? 'B'),
        ...ownXY(item),
      });
    }
  }
  return out;
}

/* ---------------- searchNearby ---------------- */

/**
 * searchNearby 回應（實測）：陣列 [{ name, address, x, y, additionalInfoKey[], additionalInfoValue[] }]，
 * x / y 係 HK80，冇類型，冇距離上限（實測 43–1438 項），而且大部分係 WiFi 熱點、郵箱、公廁、停車場、
 * 回收點、路旁泊車位（name 係街名）。距離同黑名單喺 pickTitle / pickLandmarks 篩。
 * 只收「陣列（或 results / data / items 入面嘅陣列）+ 明確嘅名稱 key」，唔做模糊搵 key。
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
    // 路旁泊車位記錄係用街名做 name（東匯路、錦上路…），座標係泊車位位置，唔係你所在嘅街
    const keys = Array.isArray(item.additionalInfoKey) ? item.additionalInfoKey.map(String) : [];
    if (keys.some(k => /泊車位|收費/.test(k))) continue;
    const kind = classifyName(name);
    if (kind === 'street') continue; // 街道只信 identify
    out.push({
      name,
      address: NEARBY_ADDR_KEYS.map(k => str(item[k])).find(Boolean),
      distanceM: distanceTo(item, origin),
      kind,
      ...ownXY(item),
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

/**
 * 「就喺呢度 / 附近」門檻 —— 用實際距離同定位準確度，唔再靠 API 嘅 nearBool（後者成日錯）。
 * 準確度好（≤ 門檻）：門檻內都算「喺」。
 * 準確度差：按比例收細「喺」嘅範圍（最少 5 m），寧願講「附近」都唔好亂認「喺」。
 */
const AT_THRESHOLD_M = 25;

export function proximityFor(dist: number, accuracy = AT_THRESHOLD_M): 'at' | 'near' {
  if (!Number.isFinite(dist)) return 'near';
  const atLimit = accuracy <= AT_THRESHOLD_M
    ? AT_THRESHOLD_M
    : Math.max(5, (AT_THRESHOLD_M * AT_THRESHOLD_M) / accuracy);
  return dist <= atLimit ? 'at' : 'near';
}

/** 每個來源最多等幾耐。 */
const SOURCE_TIMEOUT_MS = 5000;

function toPlace(
  c: PlaceCandidate,
  source: PlaceSource,
  landmarks: PlaceCandidate[],
  accuracy = AT_THRESHOLD_M,
): ResolvedPlace {
  return {
    name: c.name,
    proximity: proximityFor(c.distanceM, accuracy),
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

/**
 * ALS 嘅文字配對會俾「最似」嘅地址，唔一定係同一個地方：實測 A 出口（港鐵錦上路站-A進出口）嘅第一個結果係
 * 165 m 外嘅「MTR KAM TIN BUILDING」。所以要用「呢個地方自己嘅座標」去核對，而且只收好近嘅（同一幢 / 同一屋苑）。
 * 實測：柏瓏 identify 座標同 ALS 座標只差 4 m。
 */
const ALS_MAX_FROM_PLACE_M = 60;

async function lookupAls(title: PlaceCandidate, p: HK80Point, signal?: AbortSignal): Promise<string | undefined> {
  // 冇自己座標（OpenStreetMap 後備）就用你嘅位置核對
  const at = title.x !== undefined && title.y !== undefined ? { x: title.x, y: title.y } : { x: p.x, y: p.y };
  try {
    const q = encodeURIComponent(title.address ? `${title.name} ${title.address}` : title.name);
    // ALS 嘅輸出語言由 Accept-Language 決定（唔傳就只回英文，實測）；呢個 header 屬 CORS safelisted，唔使 preflight
    return pickAlsAddress(
      await fetchJson(`${ENDPOINTS.als}?q=${q}&n=5`, { signal, timeoutMs: 4000, name: 'ALS', headers: { 'Accept-Language': 'en,zh-Hant' } }),
      at,
      ALS_MAX_FROM_PLACE_M,
    );
  } catch (e) {
    if (signal?.aborted) throw e;
    return undefined; // ALS 失敗唔緊要，用來源本身嘅地址
  }
}

/**
 * HK80 → 地方名 + 地址：
 *  1. identify（所在大廈 / 屋苑 / 街道）同 searchNearby（附近設施）並行
 *  2. identify 一回（~1 s）就揀標題並 onPartial，畫面即刻有字
 *  3. searchNearby 一回（~1 s）就同 identify 嘅結果一齊重新揀標題（分類 / 黑名單 / 距離），好過先前嘅就取代
 *  4. 最後用 ALS 補官方門牌地址（街名唔查）
 *  4. 全部冇 → 只有 build 時開咗 VITE_OSM_FALLBACK 先會問 OpenStreetMap；否則回 null（畫面只顯示座標，仍可分享）
 */
export async function reverseGeocode(
  p: HK80Point,
  at: { lat: number; lng: number; accuracy?: number },
  signal?: AbortSignal,
  onPartial?: (place: ResolvedPlace) => void,
): Promise<ResolvedPlace | null> {
  const origin: Origin = { x: p.x, y: p.y, lat: at.lat, lng: at.lng };
  const acc = at.accuracy ?? AT_THRESHOLD_M;
  const qs = `x=${Math.round(p.x)}&y=${Math.round(p.y)}&lang=zh`;

  const identifyP = tryParse(`${ENDPOINTS.identify}?${qs}`, 'identify', j => parseIdentify(j, origin), signal);
  const nearbyP = tryParse(`${ENDPOINTS.searchNearby}?${qs}`, 'searchNearby', j => parseNearby(j, origin), signal);

  const identified = await identifyP;
  let title = pickTitle(identified);
  let source: PlaceSource = 'identify';

  // identify 一回就先顯示（~1 s）；之後 searchNearby 一回再比較一次，更貼身嘅（例如 23 米外嘅車站出口
  // 勝過 79 米外嘅屋苑）會取代佢
  if (title) onPartial?.(toPlace(title, source, pickLandmarks(identified, title), acc));
  const first = title;

  const nearby = await nearbyP;
  const best = pickTitle([...identified, ...nearby]);
  if (best) {
    title = best;
    source = identified.includes(best) ? 'identify' : 'nearby';
    if (best !== first) onPartial?.(toPlace(best, source, pickLandmarks([...identified, ...nearby], best), acc));
  }

  if (!title && OSM_FALLBACK) {
    const osm = await tryOsm(origin, signal);
    if (osm) { title = osm; source = 'osm'; onPartial?.(toPlace(osm, source, [], acc)); }
  }
  if (!title) return null;

  const chosen = title;
  // 街名唔使查 ALS：實測 ALS 對「天福路」會回沙田嘅結果，只會白白多一個請求
  const address = chosen.kind === 'street' ? undefined : await lookupAls(chosen, p, signal);
  return {
    ...toPlace(chosen, source, pickLandmarks([...identified, ...nearby], chosen), acc),
    address: address ?? chosen.address,
  };
}
