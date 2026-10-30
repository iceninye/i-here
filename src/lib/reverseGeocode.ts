import { ENDPOINTS, apiUrl } from '../config';
import { fetchJson } from './fetchJson';
import type { HK80Point } from './hk80';

/** 附近一個可以讀出嚟嘅地方（大廈 / 屋邨 / 設施 / 地標） */
export interface PlaceCandidate {
  name: string;
  address?: string;
  x: number;
  y: number;
  /** 同使用者嘅距離（米，HK80 平面距離） */
  distanceM: number;
}

export interface ResolvedPlace {
  /** 大字顯示：「興輝樓」 */
  name: string;
  /** 「附近」/「旁邊」— 按距離揀 */
  proximity: 'at' | 'near';
  distanceM: number;
  /** 官方門牌地址（ALS 補全；冇就用 identify 嘅地址） */
  address?: string;
  /** 另外幾個附近地標，幫手對照 */
  landmarks: PlaceCandidate[];
}

const NAME_KEYS = ['nameZH', 'nameTC', 'cname', 'chineseName', 'nameZh', 'name', 'nameEN', 'ename'];
const ADDR_KEYS = ['addressZH', 'addressTC', 'caddress', 'chineseAddress', 'address', 'addressEN', 'eaddress'];

function pick(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * 地政總署 identify API 嘅回應有幾層（results[].addressInfo[] …），而欄位名喺唔同圖層之間唔一致。
 * 呢度唔假設固定結構：遞迴搵所有「有名 + 有 HK80 座標」嘅 object。
 */
export function extractCandidates(json: unknown, origin: { x: number; y: number }): PlaceCandidate[] {
  const out: PlaceCandidate[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, depth: number) => {
    if (depth > 8 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(n => walk(n, depth + 1));
    const o = node as Record<string, unknown>;
    const name = pick(o, NAME_KEYS);
    const x = num(o.x ?? o.easting ?? o.Easting);
    const y = num(o.y ?? o.northing ?? o.Northing);
    if (name && x !== undefined && y !== undefined && x > 790000 && y > 790000) {
      const key = `${name}|${Math.round(x)}|${Math.round(y)}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ name, address: pick(o, ADDR_KEYS), x, y, distanceM: Math.hypot(x - origin.x, y - origin.y) });
      }
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  walk(json, 0);
  return out.sort((a, b) => a.distanceM - b.distanceM);
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

/* ---------------- 組合 ---------------- */

/** 25 m 內當「就喺呢度」，否則「附近」 */
const AT_THRESHOLD_M = 25;

export async function reverseGeocode(p: HK80Point, signal?: AbortSignal): Promise<ResolvedPlace | null> {
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  const identify = await fetchJson(apiUrl(`${ENDPOINTS.identify}?x=${x}&y=${y}&lang=zh`), { signal, timeoutMs: 6000 });
  const cands = extractCandidates(identify, p);
  const top = cands[0];
  if (!top) return null;

  let address = top.address;
  try {
    const q = encodeURIComponent(top.address ? `${top.name} ${top.address}` : top.name);
    const als = await fetchJson(apiUrl(`${ENDPOINTS.als}?q=${q}&n=5`), { signal, timeoutMs: 4000 });
    address = pickAlsAddress(als, p) ?? address;
  } catch (e) {
    if (signal?.aborted) throw e;
    // ALS 失敗唔緊要，用 identify 嘅地址
  }

  return {
    name: top.name,
    proximity: top.distanceM <= AT_THRESHOLD_M ? 'at' : 'near',
    distanceM: top.distanceM,
    address,
    landmarks: cands.slice(1).filter(c => c.name !== top.name).slice(0, 3),
  };
}
