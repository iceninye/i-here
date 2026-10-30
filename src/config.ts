/**
 * 所有外部 endpoint 集中喺度，方便換代理 / 換版本。
 * 政府 API 文件：
 *  - 坐標轉換 API     https://data.gov.hk/tc-data/dataset/hk-landsd-openmap-coordinates-transformation-api
 *  - Identify API     https://data.gov.hk/en-data/dataset/hk-landsd-openmap-development-identify-api
 *  - Search Nearby    https://data.gov.hk/en-data/dataset/hk-landsd-openmap-development-search-nearby-api
 *  - 門牌地址搜尋 ALS  https://data.gov.hk/tc-data/dataset/hk-ogcio-st_div_02-als
 *  - 地圖 API         https://data.gov.hk/tc-data/dataset/hk-landsd-open-data-map-api
 */

const PROXY = (import.meta.env.VITE_API_PROXY ?? '').replace(/\/+$/, '');

/** 有設 VITE_API_PROXY 就經 Worker 轉發：https://proxy/<host>/<path>?<query> */
export function apiUrl(url: string): string {
  if (!PROXY) return url;
  const u = new URL(url);
  return `${PROXY}/${u.host}${u.pathname}${u.search}`;
}

export const ENDPOINTS = {
  /** WGS84 經緯度 -> HK1980 方格網 (inSys=wgsgeog, outSys=hkgrid) */
  transform: 'https://www.geodetic.landsd.gov.hk/transform/v2/',
  /** 以 HK80 座標識別該點嘅設施 / 建築物。官方文件（CSDI）寫嘅 host 係 www.map.gov.hk */
  identify: 'https://www.map.gov.hk/gs/api/v1.0.0/identify',
  /** 同一個 API 喺 GeoData Store 嘅鏡像，主 host 失敗先試 */
  identifyAlt: 'https://geodata.gov.hk/gs/api/v1.0.0/identify',
  /** 1 km 內嘅設施（地標），幫手對照 */
  searchNearby: 'https://geodata.gov.hk/gs/api/v1.0.0/searchNearby',
  /** OGCIO 門牌地址搜尋（正向），用嚟將建築物名補全成官方地址 */
  als: 'https://www.als.gov.hk/lookup',
  /** 政府 API 全部失敗時嘅後備（OpenStreetMap，有 CORS；用量政策：每秒最多 1 次，App 已限 15 秒一次） */
  nominatim: 'https://nominatim.openstreetmap.org/reverse',
} as const;

/** 地政總署 XYZ 地圖瓦片（WGS84 / Web Mercator，免 key） */
export const LANDSD_TILES = {
  basemap: 'https://mapapi.geodata.gov.hk/gs/api/v1.0.0/xyz/basemap/WGS84/{z}/{x}/{y}.png',
  imagery: 'https://mapapi.geodata.gov.hk/gs/api/v1.0.0/xyz/imagery/WGS84/{z}/{x}/{y}.png',
  labelTc: 'https://mapapi.geodata.gov.hk/gs/api/v1.0.0/xyz/label/hk/tc/WGS84/{z}/{x}/{y}.png',
  attribution:
    '<a href="https://api.portal.hkmapservice.gov.hk/disclaimer" target="_blank" rel="noopener">© 地政總署</a>',
} as const;

/** 輕量 3D 建築物外廓（有高度屬性嘅向量瓦片，OpenMapTiles schema）。只喺開立體圖時先載入。 */
export const BUILDINGS_3D = {
  tileJson: 'https://tiles.openfreemap.org/planet',
  sourceLayer: 'building',
  attribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>',
} as const;

export const LANDSD_3DTILES_URL = import.meta.env.VITE_LANDSD_3DTILES_URL ?? '';
