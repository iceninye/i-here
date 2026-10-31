import { useCallback, useEffect, useRef, useState } from 'react';
import { GEO, GeoError, acquireBestFix, geoErrorFrom, haversineM, isInHongKong, toFix, type Fix } from '../lib/geo';
import { wgs84ToHK80Api, wgs84ToHK80Local, type HK80Point } from '../lib/hk80';
import { logFix } from '../lib/fixLog';
import { reverseGeocode, type ResolvedPlace } from '../lib/reverseGeocode';

export type LocationStatus = 'locating' | 'ready' | 'error';
export type PlaceStatus = 'idle' | 'loading' | 'ready' | 'not-found' | 'failed';

export interface CurrentLocation {
  status: LocationStatus;
  /** 最新 fix；取樣期間會一路收窄（地圖可以即刻顯示） */
  fix: Fix | null;
  hk80: HK80Point | null;
  place: ResolvedPlace | null;
  placeStatus: PlaceStatus;
  error: GeoError | null;
  /** 精度差過 GEO.POOR_ACCURACY_M —— UI 應提示「走去空曠地方」 */
  poorAccuracy: boolean;
  /** 重新定位（用戶撳「再搵一次」） */
  refresh: () => void;
}

/** 移動超過呢個距離先重新查地址（避免企喺度 GPS 飄移不停 call API） */
const RESOLVE_MOVE_M = 40;
/** 兩次查地址最少相隔 */
const RESOLVE_MIN_INTERVAL_MS = 15000;
/** 追蹤模式下，移動超過呢個距離或精度明顯變好先更新 fix（減少 re-render） */
const TRACK_MOVE_M = 8;

/**
 * 打開即定位：
 *   1. 取樣窗（mtr-app 技術）搵最準嘅 fix，期間逐步更新地圖
 *   2. WGS84 -> HK80（本機 proj4 即刻計；地政總署坐標轉換 API 喺背景核對）
 *   3. HK80 -> 附近建築物 / 地標（identify + searchNearby + OSM 並行）-> 先顯示地名 -> ALS 補官方門牌地址
 *   4. 之後保持低頻追蹤：行開咗先再查地址；App 去咗背景就暫停 GPS 慳電
 */
export function useCurrentLocation({ enabled = true }: { enabled?: boolean } = {}): CurrentLocation {
  const [status, setStatus] = useState<LocationStatus>('locating');
  const [fix, setFix] = useState<Fix | null>(null);
  const [hk80, setHk80] = useState<HK80Point | null>(null);
  const [place, setPlace] = useState<ResolvedPlace | null>(null);
  const [placeStatus, setPlaceStatus] = useState<PlaceStatus>('idle');
  const [error, setError] = useState<GeoError | null>(null);
  const [runId, setRunId] = useState(0);

  const lastFix = useRef<Fix | null>(null);
  const lastResolved = useRef<{ fix: Fix; at: number } | null>(null);
  const resolveCtrl = useRef<AbortController | null>(null);

  const resolve = useCallback(async (f: Fix, force = false) => {
    if (!isInHongKong(f.lat, f.lng)) return;
    const prev = lastResolved.current;
    if (!force && prev) {
      const moved = haversineM(prev.fix.lat, prev.fix.lng, f.lat, f.lng);
      if (moved < RESOLVE_MOVE_M || Date.now() - prev.at < RESOLVE_MIN_INTERVAL_MS) return;
    }
    lastResolved.current = { fix: f, at: Date.now() };
    resolveCtrl.current?.abort();
    const ctrl = new AbortController();
    resolveCtrl.current = ctrl;
    setPlaceStatus('loading');
    // 本機 HK80 即刻有；官方 API 喺背景核對（成功先更新顯示，唔會阻住查地址）
    const p80 = wgs84ToHK80Local(f.lat, f.lng);
    setHk80(p80);
    void wgs84ToHK80Api(f.lat, f.lng, ctrl.signal).then(api => {
      if (api && !ctrl.signal.aborted) setHk80(api);
    });
    try {
      const resolved = await reverseGeocode(p80, { lat: f.lat, lng: f.lng }, ctrl.signal, partial => {
        // 地名一到就顯示；ALS 補全地址之後再更新
        if (ctrl.signal.aborted) return;
        setPlace(partial);
        setPlaceStatus('ready');
      });
      if (ctrl.signal.aborted) return;
      setPlace(resolved);
      setPlaceStatus(resolved ? 'ready' : 'not-found');
    } catch {
      if (ctrl.signal.aborted) return;
      // 保留上一個地名（如果有），唔好令畫面突然變空白
      setPlaceStatus('failed');
      lastResolved.current = prev; // 下次有移動就再試
    }
  }, []);

  const accept = useCallback((f: Fix) => {
    lastFix.current = f;
    setFix(f);
    setError(isInHongKong(f.lat, f.lng) ? null : new GeoError('outside-hk'));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setError(new GeoError('unsupported'));
      setStatus('error');
      return;
    }

    const sampling = new AbortController();
    let watchId: number | null = null;
    let disposed = false;

    const startTracking = () => {
      if (watchId !== null || disposed) return;
      watchId = navigator.geolocation.watchPosition(
        pos => {
          const f = toFix(pos);
          const prev = lastFix.current;
          if (!f) return;
          logFix(f);
          const moved = prev ? haversineM(prev.lat, prev.lng, f.lat, f.lng) : Infinity;
          const better = prev ? f.accuracy < prev.accuracy * 0.7 : true;
          // 只係精度變差但冇郁 → 唔更新，避免精度圈忽大忽細嚇親人
          if (moved < TRACK_MOVE_M && !better) return;
          if (prev && f.accuracy > GEO.POOR_ACCURACY_M && f.accuracy > prev.accuracy * 2 && moved < f.accuracy) return;
          accept(f);
          void resolve(f);
        },
        () => { /* 追蹤期間嘅錯誤唔打斷畫面；已有位置繼續顯示 */ },
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 },
      );
    };
    const stopTracking = () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      watchId = null;
    };

    setStatus('locating');
    acquireBestFix({
      maxAgeMs: runId === 0 ? GEO.INITIAL_MAX_AGE_MS : 0, // 首次可用快取；用戶撳重新定位就要新鮮 fix
      onFix: accept,
      onSample: logFix,
      signal: sampling.signal,
    })
      .then(best => {
        if (disposed) return;
        accept(best);
        setStatus('ready');
        void resolve(best, true);
        if (document.visibilityState === 'visible') startTracking();
      })
      .catch((e: unknown) => {
        if (disposed) return;
        setError(e instanceof GeoError ? e : geoErrorFrom({ code: 2, message: String(e) }));
        setStatus(lastFix.current ? 'ready' : 'error');
      });

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stopTracking();
      else if (lastFix.current) startTracking();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      sampling.abort();
      stopTracking();
      resolveCtrl.current?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, runId, accept, resolve]);

  const refresh = useCallback(() => {
    lastResolved.current = null;
    setRunId(n => n + 1);
  }, []);

  return {
    status,
    fix,
    hk80,
    place,
    placeStatus,
    error,
    poorAccuracy: !!fix && fix.accuracy > GEO.POOR_ACCURACY_M,
    refresh,
  };
}
