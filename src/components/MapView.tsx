import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MlMap, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { BUILDINGS_3D, LANDSD_3DTILES_URL, LANDSD_TILES } from '../config';
import { circlePolygon, type Fix } from '../lib/geo';
import { extrapolateFix } from '../lib/interpolate';
import type { MotionState } from '../lib/motion';
import type { PeerState } from '../lib/liveShare';
import { Icon } from './Icon';

/** 實時分享嘅對方（§5.3）：fix 係解密之後嘅位置，插值同「我」一樣做 */
export interface LivePeerView {
  id: string;
  state: PeerState;
  fix: Fix | null;
}

interface Props {
  fix: Fix | null;
  is3D: boolean;
  /** 運動狀態（§4.4）：只有非 still 先做 marker 外推插值 */
  motion?: MotionState;
  /** 訊號丟失（§4.6）：停止外推，pin 變灰、精度圈變虛線 */
  signalLost?: boolean;
  /** 收件人模式：對方分享過嚟嘅位置 */
  sharedPin?: { lat: number; lng: number; label?: string } | null;
  /** 實時分享中嘅對方（可以零個或者一個；房上限 2 人） */
  livePeers?: LivePeerView[];
}

const HK_CENTER: [number, number] = [114.1694, 22.3193];
const HK_BOUNDS: [[number, number], [number, number]] = [[113.75, 22.1], [114.5, 22.6]];

const STYLE: StyleSpecification = {
  version: 8,
  sources: {
    basemap: { type: 'raster', tiles: [LANDSD_TILES.basemap], tileSize: 256, maxzoom: 20, attribution: LANDSD_TILES.attribution },
    label: { type: 'raster', tiles: [LANDSD_TILES.labelTc], tileSize: 256, maxzoom: 20 },
    accuracy: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    'peer-accuracy': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#eef2f4' } },
    { id: 'basemap', type: 'raster', source: 'basemap' },
    { id: 'label', type: 'raster', source: 'label' },
    { id: 'accuracy-fill', type: 'fill', source: 'accuracy', paint: { 'fill-color': '#1a73e8', 'fill-opacity': 0.12 } },
    { id: 'accuracy-line', type: 'line', source: 'accuracy', paint: { 'line-color': '#1a73e8', 'line-width': 2, 'line-opacity': 0.5 } },
    // 對方嘅精度圈用另一個色（§5.3：己方藍、對方另一色），先畫喺自己嗰層下面
    { id: 'peer-accuracy-fill', type: 'fill', source: 'peer-accuracy', paint: { 'fill-color': '#e8710a', 'fill-opacity': 0.12 } },
    { id: 'peer-accuracy-line', type: 'line', source: 'peer-accuracy', paint: { 'line-color': '#e8710a', 'line-width': 2, 'line-opacity': 0.5 } },
  ],
};

/** 標記底部係圓點（22px），向下移半粒，令圓點中心 = 實際座標 = 精度圈中心 */
const DOT_OFFSET: [number, number] = [0, 11];

function markerEl(text: string, cls: string): HTMLElement {
  const el = document.createElement('div');
  el.className = `pin ${cls}`;
  // pin__arrow：heading 箭咀（§4.4），繞圓點中心旋轉；冇 heading 或者靜止時隱藏
  el.innerHTML = `<span class="pin__label"></span><span class="pin__dot"></span>` +
    `<span class="pin__arrow"><svg viewBox="0 0 64 64" aria-hidden="true"><polygon points="32 12 36.5 22 27.5 22" /></svg></span>`;
  (el.querySelector('.pin__label') as HTMLElement).textContent = text;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/**
 * 顯示 / 隱藏 heading 箭咀並旋轉到方位角（0° = 正北，順時針）。
 * 只喺郁緊（非 still、非訊號丟失）而且 `heading` 已知時顯示 —— 未知 ≠ 向北（§4.1）。
 */
function setHeading(el: HTMLElement, fix: Fix, moving: boolean): void {
  const arrow = el.querySelector('.pin__arrow') as HTMLElement | null;
  if (!arrow) return;
  if (!moving || fix.heading === undefined || !Number.isFinite(fix.heading)) {
    el.classList.remove('pin--heading');
    return;
  }
  // 方位角存喺 CSS 變數；地圖轉動時由 --b（地圖 bearing）扣返，箭咀先會繼續指向真實方向
  el.style.setProperty('--h', String(fix.heading));
  el.classList.add('pin--heading');
}

export function MapView({ fix, is3D, motion = 'still', signalLost = false, sharedPin, livePeers }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const meMarker = useRef<maplibregl.Marker | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [following, setFollowing] = useState(true);
  const [bearing, setBearing] = useState(0);
  const followingRef = useRef(true);
  followingRef.current = following;
  // 插值用：最新 fix + 收到佢嘅時刻（§4.4）。用 ref 免 rAF loop 每帧重新綁定。
  const latestFix = useRef<Fix | null>(null);
  const receivedAt = useRef<number>(0);
  // 對方 marker 同佢哋嘅插值狀態（§5.3：對方 marker 同一套插值）
  const peerMarkers = useRef(new Map<string, maplibregl.Marker>());
  const peerTrack = useRef(new Map<string, { fix: Fix; at: number }>());

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
      // 兩指轉動可以旋轉地圖（預設向北；右下角指北針一撳返正北）。冇 pitch 跟住轉，避免誤觸傾斜
      pitchWithRotate: false,
    });
    const syncBearing = () => {
      const b = map.getBearing();
      container.current?.style.setProperty('--b', String(b));
      setBearing(Math.round(b));
    };
    map.on('rotate', syncBearing);
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
    // 訊號丟失：pin 變灰（§4.6）
    meMarker.current.getElement().classList.toggle('pin--lost', signalLost);
    // heading 箭咀（§4.4）：郁緊而方位角已知先顯示
    setHeading(meMarker.current.getElement(), fix, motion !== 'still' && !signalLost);
    // 記低呢個 fix 同收到時刻，畀 rAF 外推 loop 用（§4.4）
    latestFix.current = fix;
    receivedAt.current = performance.now();
    const radius = Number.isFinite(fix.accuracy) ? Math.min(fix.accuracy, 2000) : 0;
    (map.getSource('accuracy') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: radius
        ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circlePolygon(fix.lat, fix.lng, radius)] } }]
        : [],
    });
    // 訊號丟失：精度圈變虛線（最後已知位置），正常時實線
    map.setPaintProperty('accuracy-line', 'line-dasharray', signalLost ? [2, 2] : [1, 0]);
    if (followingRef.current && !sharedPin) {
      // 精度圈要完整見到：粗略 fix 時拉遠啲
      const zoom = radius > 500 ? 14 : radius > 150 ? 16 : 17.5;
      map.easeTo({ center: [fix.lng, fix.lat], zoom: Math.max(map.getZoom(), zoom), duration: 800 });
    }
  }, [fix, loaded, sharedPin, signalLost, motion]);

  // Marker 外推插值（§4.4）：兩個 GPS update 之間用 speed + heading 平滑移動「我」同對方嘅 marker。
  //   - 只喺非 still、非訊號丟失、speed/heading 已知、accuracy ≤ 30 m 時外推，最多 1.5 s（extrapolateFix 內部限制）。
  //   - 新 fix 到達 → 上面嘅 effect 已經 setLngLat 到真位置（直接 snap，唔慢慢拖）。
  //   - extrapolateFix 回 null（條件未符）時唔郁 marker，保持 snap 咗嘅位置。
  const peersMoving = !!livePeers?.some(p => p.state === 'live' && p.fix);
  useEffect(() => {
    if (!loaded) return;
    if (motion === 'still' && !peersMoving) return;
    let raf = 0;
    const tick = () => {
      const map = mapRef.current;
      const now = performance.now();
      if (map) {
        if (motion !== 'still' && !signalLost) {
          const marker = meMarker.current;
          const f = latestFix.current;
          if (marker && f) {
            const p = extrapolateFix(f, (now - receivedAt.current) / 1000);
            if (p) marker.setLngLat([p.lng, p.lat]);
          }
        }
        // 對方：佢哋嘅 fix 係 ~1 Hz 經 server 中轉過嚟，插值令移動睇落順滑（§5.3）
        for (const [id, t] of peerTrack.current) {
          const marker = peerMarkers.current.get(id);
          if (!marker) continue;
          const p = extrapolateFix(t.fix, (now - t.at) / 1000);
          if (p) marker.setLngLat([p.lng, p.lat]);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loaded, motion, signalLost, peersMoving]);

  // 實時分享：對方 marker（另一色）+ 對方 accuracy 圈（§5.3）
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const peers = livePeers ?? [];
    const seen = new Set<string>();
    const circles: [number, number][][] = [];
    for (const p of peers) {
      if (!p.fix) continue; // 未收到位置（啱啱 joined）→ 冇嘢畫
      seen.add(p.id);
      let marker = peerMarkers.current.get(p.id);
      if (!marker) {
        marker = new maplibregl.Marker({ element: markerEl('對方', 'pin--peer'), anchor: 'bottom', offset: DOT_OFFSET });
        peerMarkers.current.set(p.id, marker);
      }
      marker.setLngLat([p.fix.lng, p.fix.lat]).addTo(map);
      // 對方暫停 / 訊號丟失：變灰 + 停止外推（保留最後已知位置）
      const stale = p.state === 'lost' || p.state === 'paused';
      marker.getElement().classList.toggle('pin--lost', stale);
      setHeading(marker.getElement(), p.fix, !stale);
      if (stale) peerTrack.current.delete(p.id);
      else peerTrack.current.set(p.id, { fix: p.fix, at: performance.now() });
      const radius = Number.isFinite(p.fix.accuracy) ? Math.min(p.fix.accuracy, 2000) : 0;
      if (radius) circles.push(circlePolygon(p.fix.lat, p.fix.lng, radius));
    }
    // 已離開 / 房散嘅 peer：移走 marker
    for (const [id, marker] of peerMarkers.current) {
      if (seen.has(id)) continue;
      marker.remove();
      peerMarkers.current.delete(id);
      peerTrack.current.delete(id);
    }
    (map.getSource('peer-accuracy') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: circles.map(ring => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } })),
    });
  }, [livePeers, loaded]);

  // 收件人模式 pin
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !sharedPin) return;
    const m = new maplibregl.Marker({ element: markerEl(sharedPin.label ? '對方' : '位置', 'pin--shared'), anchor: 'bottom', offset: DOT_OFFSET })
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

  const resetNorth = () => { mapRef.current?.easeTo({ bearing: 0, duration: 500 }); };

  const recenter = () => {
    setFollowing(true);
    const map = mapRef.current;
    if (map && fix) map.easeTo({ center: [fix.lng, fix.lat], zoom: Math.max(map.getZoom(), 17), duration: 600 });
  };

  return (
    <div className="map-wrap">
      <div ref={container} className="map" role="img" aria-label="地圖，藍色「我」標記係你而家嘅位置" />
      <div className="map-fabs">
        {bearing !== 0 && (
          <button type="button" className="fab" onClick={resetNorth} aria-label="指北針：撳一下將地圖轉返向北" title="轉返向北">
            <span style={{ display: 'inline-flex', transform: `rotate(${-bearing}deg)` }}><Icon name="compass" /></span>
          </button>
        )}
        {!following && fix && (
          <button type="button" className="fab" onClick={recenter} aria-label="回到我的位置" title="回到我的位置">
            <Icon name="target" />
          </button>
        )}
      </div>
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
