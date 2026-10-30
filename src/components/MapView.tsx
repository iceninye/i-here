import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MlMap, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { BUILDINGS_3D, LANDSD_3DTILES_URL, LANDSD_TILES } from '../config';
import { circlePolygon, type Fix } from '../lib/geo';

interface Props {
  fix: Fix | null;
  is3D: boolean;
  /** 收件人模式：家人分享過嚟嘅位置 */
  sharedPin?: { lat: number; lng: number; label?: string } | null;
}

const HK_CENTER: [number, number] = [114.1694, 22.3193];
const HK_BOUNDS: [[number, number], [number, number]] = [[113.75, 22.1], [114.5, 22.6]];

const STYLE: StyleSpecification = {
  version: 8,
  sources: {
    basemap: { type: 'raster', tiles: [LANDSD_TILES.basemap], tileSize: 256, maxzoom: 20, attribution: LANDSD_TILES.attribution },
    label: { type: 'raster', tiles: [LANDSD_TILES.labelTc], tileSize: 256, maxzoom: 20 },
    accuracy: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#eef2f4' } },
    { id: 'basemap', type: 'raster', source: 'basemap' },
    { id: 'label', type: 'raster', source: 'label' },
    { id: 'accuracy-fill', type: 'fill', source: 'accuracy', paint: { 'fill-color': '#1a73e8', 'fill-opacity': 0.12 } },
    { id: 'accuracy-line', type: 'line', source: 'accuracy', paint: { 'line-color': '#1a73e8', 'line-width': 2, 'line-opacity': 0.5 } },
  ],
};

/** 標記底部係圓點（22px），向下移半粒，令圓點中心 = 實際座標 = 精度圈中心 */
const DOT_OFFSET: [number, number] = [0, 11];

function markerEl(text: string, cls: string): HTMLElement {
  const el = document.createElement('div');
  el.className = `pin ${cls}`;
  el.innerHTML = `<span class="pin__label"></span><span class="pin__dot"></span>`;
  (el.querySelector('.pin__label') as HTMLElement).textContent = text;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

export function MapView({ fix, is3D, sharedPin }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const meMarker = useRef<maplibregl.Marker | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  followingRef.current = following;

  // init
  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({
      container: container.current,
      style: STYLE,
      center: sharedPin ? [sharedPin.lng, sharedPin.lat] : HK_CENTER,
      zoom: sharedPin ? 17 : 11,
      maxZoom: 20,
      minZoom: 10,
      maxBounds: HK_BOUNDS,
      maxPitch: 70,
      attributionControl: { compact: true },
      // 長者容易誤觸旋轉：一指拖動 / 兩指縮放就夠
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    // 'style.load' 比 'load' 早好多（'load' 要等第一批瓦片），標記同精度圈唔使等底圖
    map.once('style.load', () => setLoaded(true));
    // 用戶自己拖地圖 → 停止自動跟隨，顯示「回到我的位置」
    map.on('dragstart', e => { if (e.originalEvent) setFollowing(false); });
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
    // sharedPin 只用作初始視角
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 我嘅位置 + 精度圈
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !fix) return;
    if (!meMarker.current) meMarker.current = new maplibregl.Marker({ element: markerEl('我', 'pin--me'), anchor: 'bottom', offset: DOT_OFFSET });
    meMarker.current.setLngLat([fix.lng, fix.lat]).addTo(map);
    const radius = Number.isFinite(fix.accuracy) ? Math.min(fix.accuracy, 2000) : 0;
    (map.getSource('accuracy') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: radius
        ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circlePolygon(fix.lat, fix.lng, radius)] } }]
        : [],
    });
    if (followingRef.current && !sharedPin) {
      // 精度圈要完整見到：粗略 fix 時拉遠啲
      const zoom = radius > 500 ? 14 : radius > 150 ? 16 : 17.5;
      map.easeTo({ center: [fix.lng, fix.lat], zoom: Math.max(map.getZoom(), zoom), duration: 800 });
    }
  }, [fix, loaded, sharedPin]);

  // 收件人模式 pin
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !sharedPin) return;
    const m = new maplibregl.Marker({ element: markerEl(sharedPin.label ? '家人' : '位置', 'pin--shared'), anchor: 'bottom', offset: DOT_OFFSET })
      .setLngLat([sharedPin.lng, sharedPin.lat])
      .addTo(map);
    return () => { m.remove(); };
  }, [sharedPin, loaded]);

  // 2D / 3D
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    let cleanup3DTiles: (() => void) | undefined;
    let cancelled = false;
    if (is3D) {
      ensureBuildingLayers(map);
      map.setLayoutProperty('bld-3d', 'visibility', 'visible');
      map.setLayoutProperty('bld-here', 'visibility', 'visible');
      map.easeTo({ pitch: 60, bearing: -17, zoom: Math.max(map.getZoom(), 17), duration: 900 });
      if (LANDSD_3DTILES_URL) {
        addLandsD3DTiles(map)
          .then(c => { if (cancelled) c(); else { cleanup3DTiles = c; map.setLayoutProperty('bld-3d', 'visibility', 'none'); } })
          .catch(() => { /* 失敗就保留輕量外廓 */ });
      }
    } else if (map.getLayer('bld-3d')) {
      map.setLayoutProperty('bld-3d', 'visibility', 'none');
      map.setLayoutProperty('bld-here', 'visibility', 'none');
      map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
    }
    return () => { cancelled = true; cleanup3DTiles?.(); };
  }, [is3D, loaded]);

  // 立體圖：將「我所在嗰幢」染橙色，方便對照現實
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !is3D || !fix) return;
    const highlight = () => {
      if (!map.getLayer('bld-3d')) return;
      const pt = map.project([fix.lng, fix.lat]);
      const box: [[number, number], [number, number]] = [[pt.x - 6, pt.y - 6], [pt.x + 6, pt.y + 6]];
      const f = map.queryRenderedFeatures(box, { layers: ['bld-3d'] })[0];
      (map.getSource('here-building') as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features: f ? [{ type: 'Feature', properties: f.properties, geometry: f.geometry }] : [],
      });
    };
    map.once('idle', highlight);
    return () => { map.off('idle', highlight); };
  }, [fix, is3D, loaded]);

  const recenter = () => {
    setFollowing(true);
    const map = mapRef.current;
    if (map && fix) map.easeTo({ center: [fix.lng, fix.lat], zoom: Math.max(map.getZoom(), 17), duration: 600 });
  };

  return (
    <div className="map-wrap">
      <div ref={container} className="map" role="img" aria-label="地圖，藍色「我」標記係你而家嘅位置" />
      {!following && fix && (
        <button type="button" className="recenter-btn" onClick={recenter}>
          <span aria-hidden="true">◎</span> 回到我的位置
        </button>
      )}
    </div>
  );
}

function ensureBuildingLayers(map: MlMap) {
  if (map.getSource('bld')) return;
  map.addSource('bld', { type: 'vector', url: BUILDINGS_3D.tileJson, attribution: BUILDINGS_3D.attribution });
  map.addSource('here-building', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const height: maplibregl.ExpressionSpecification = ['coalesce', ['get', 'render_height'], 10];
  const base: maplibregl.ExpressionSpecification = ['coalesce', ['get', 'render_min_height'], 0];
  map.addLayer(
    {
      id: 'bld-3d', type: 'fill-extrusion', source: 'bld', 'source-layer': BUILDINGS_3D.sourceLayer, minzoom: 14,
      paint: {
        'fill-extrusion-color': ['interpolate', ['linear'], height, 0, '#d9dde3', 60, '#b9c2cf', 200, '#8f9db3'],
        'fill-extrusion-height': height,
        'fill-extrusion-base': base,
        'fill-extrusion-opacity': 0.88,
      },
    },
    'accuracy-fill',
  );
  map.addLayer(
    {
      id: 'bld-here', type: 'fill-extrusion', source: 'here-building',
      paint: {
        'fill-extrusion-color': '#f28c28',
        'fill-extrusion-height': height,
        'fill-extrusion-base': base,
        'fill-extrusion-opacity': 0.95,
      },
    },
    'accuracy-fill',
  );
}

async function addLandsD3DTiles(map: MlMap): Promise<() => void> {
  const { addLandsD3DTiles: add } = await import('./landsd3dTiles');
  return add(map, LANDSD_3DTILES_URL, e => console.warn('[3D tiles]', e));
}
