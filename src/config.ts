/**
 * 所有外部 endpoint 集中喺度。
 * 政府 API 文件：
 *  - 坐標轉換 API     https://data.gov.hk/tc-data/dataset/hk-landsd-openmap-coordinates-transformation-api
 *  - Identify API     https://data.gov.hk/en-data/dataset/hk-landsd-openmap-development-identify-api
 *  - Search Nearby    https://data.gov.hk/en-data/dataset/hk-landsd-openmap-development-search-nearby-api
 *  - 門牌地址搜尋 ALS  https://data.gov.hk/tc-data/dataset/hk-ogcio-st_div_02-als
 *  - 地圖 API         https://data.gov.hk/tc-data/dataset/hk-landsd-open-data-map-api
 *
 * 實測（手機，2026-10）：www.map.gov.hk 嘅 identify ~0.7 s 回應；geodata.gov.hk 嘅 gs/api 請求一直冇回應，
 * 所以唔再用。政府 API 回 CORS `*`，毋須代理。
 */

export const ENDPOINTS = {
  /** WGS84 經緯度 -> HK1980 方格網 (inSys=wgsgeog, outSys=hkgrid) */
  transform: 'https://www.geodetic.gov.hk/transform/v2/',
  /** 以 HK80 座標識別該點嘅建築物 / 街道 */
  identify: 'https://www.map.gov.hk/gs/api/v1.0.0/identify',
  /** 1 km 內嘅設施（回應冇距離上限，要自己篩） */
  searchNearby: 'https://www.map.gov.hk/gs/api/v1.0.0/searchNearby',
  /** OGCIO 門牌地址搜尋（正向），用嚟將地名補全成官方地址 */
  als: 'https://www.als.gov.hk/lookup',
  /** OpenStreetMap 後備。預設關閉：會將座標送去第三方（見 OSM_FALLBACK） */
  nominatim: 'https://nominatim.openstreetmap.org/reverse',
} as const;

/** 只有 build 時設 VITE_OSM_FALLBACK=1 先會開。私隱優先：預設座標只送政府 API。 */
export const OSM_FALLBACK = import.meta.env.VITE_OSM_FALLBACK === '1';

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
