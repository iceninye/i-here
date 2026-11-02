import { useCallback, useEffect, useRef, useState } from 'react';
import { GEO, GeoError, acquireBestFix, derivedSpeed, geoErrorFrom, haversineM, isInHongKong, toFix, type Fix } from '../lib/geo';
import { wgs84ToHK80Api, wgs84ToHK80Local, type HK80Point } from '../lib/hk80';
import { logFix } from '../lib/fixLog';
import { reverseGeocode, type ResolvedPlace } from '../lib/reverseGeocode';
import { createMotionTracker, type MotionState } from '../lib/motion';

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
  /** 運動狀態（§4.2）：still / walking / fast —— 控制地名節流、插值、UI */
  motion: MotionState;
  /** 目前速度（km/h）；未知就 null（§4.2） */
  speedKmh: number | null;
  /** 曾有 fix，之後 >SIGNAL_LOST_MS 冇新 fix 而且頁面喺前景（§4.6） */
  signalLost: boolean;
  /** 重新定位（用戶撳「再搵一次」） */
  refresh: () => void;
}

/** 移動超過呢個距離先重新查地址（避免企喺度 GPS 飄移不停 call API） */
const RESOLVE_MOVE_M = 40;
/** 精度大幅改善時，兩次查地址最少相隔 */
const RESOLVE_SHARPEN_MIN_MS = 2000;
/** 兩次查地址最少相隔 */
const RESOLVE_MIN_INTERVAL_MS = 15000;
/** fast 狀態：地名查詢節流更鬆（200 m / 20 s，PLAN §4.3） */
const FAST_RESOLVE_MOVE_M = 200;
const FAST_RESOLVE_MIN_INTERVAL_MS = 20000;
/** 追蹤模式下，移動超過呢個距離或精度明顯變好先更新 fix（減少 re-render） */
const TRACK_MOVE_M = 8;
/** 訊號丟失判斷：呢段時間冇新 fix（§4.6） */
const SIGNAL_LOST_MS = 10000;

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
  const [motion, setMotion] = useState<MotionState>('still');
  const [speedKmh, setSpeedKmh] = useState<number | null>(null);
  const [signalLost, setSignalLost] = useState(false);

  const lastFix = useRef<Fix | null>(null);
  const lastResolved = useRef<{ fix: Fix; at: number } | null>(null);
  const resolveCtrl = useRef<AbortController | null>(null);
  const motionRef = useRef(createMotionTracker());
  const motionState = useRef<MotionState>('still');
  const lastFixTs = useRef<number>(0);

  const resolve = useCallback(async (f: Fix, force = false) => {
    if (!isInHongKong(f.lat, f.lng)) return;
    const prev = lastResolved.current;
    if (!force && prev) {
      const moved = haversineM(prev.fix.lat, prev.fix.lng, f.lat, f.lng);
      // 第一個 fix 通常好粗略（實測：±24 m 嗰個實際差 ~26 m，約 17 秒後先收窄到 ±3 m）：
      // 精度大幅改善而位置動咗，就算未行夠 40 m 都要重新查
      const sharpened = f.accuracy * 2.5 < prev.fix.accuracy && moved > 10;
      const elapsed = Date.now() - prev.at;
      // fast 狀態節流更鬆（200 m / 20 s，§4.3）：高速下大廈名冇意義、又燒 API
      const fast = motionState.current === 'fast';
      const moveLimit = fast ? FAST_RESOLVE_MOVE_M : RESOLVE_MOVE_M;
      const intervalLimit = fast ? FAST_RESOLVE_MIN_INTERVAL_MS : RESOLVE_MIN_INTERVAL_MS;
      // 精度改善咗就唔受間隔限制（只要隔 2 秒，避免連環請求）；否則要行夠距離同相隔夠耐
      if (sharpened ? elapsed < RESOLVE_SHARPEN_MIN_MS : moved < moveLimit || elapsed < intervalLimit) return;
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
      const resolved = await reverseGeocode(p80, { lat: f.lat, lng: f.lng, accuracy: f.accuracy }, ctrl.signal, partial => {
        // 地名一到就顯示；ALS 補全地址之後再更新
        if (ctrl.signal.aborted) return;
        setPlace(partial);
        setPlaceStatus('ready');
      }, { preferStreet: motionState.current === 'fast' });
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
    const prev = lastFix.current;
    lastFix.current = f;
    lastFixTs.current = Date.now();
    setFix(f);
    setSignalLost(false);
    setError(isInHongKong(f.lat, f.lng) ? null : new GeoError('outside-hk'));
    // 運動狀態機（§4.2）：speed 未知時用推算速度；兩者都冇就保持原狀態
    const state = motionRef.current.update(f);
    motionState.current = state;
    setMotion(state);
    const v = f.speed ?? (prev ? derivedSpeed(prev, f) : undefined);
    setSpeedKmh(v === undefined ? null : Math.round(v * 3.6));
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
          // 收到任何 fix 都代表 GPS 仲有訊號：就算下面因為「冇郁」而唔更新畫面，都要刷新心跳，
          // 否則企定嘅人 10 秒後會被誤報「訊號丟失」（真機：精度 ±9 m 都顯示丟失、marker 變灰）
          lastFixTs.current = Date.now();
          setSignalLost(false);
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
    motionRef.current = createMotionTracker();
    motionState.current = 'still';
    setMotion('still');
    setSpeedKmh(null);
    setSignalLost(false);
    setRunId(n => n + 1);
  }, []);

  // 訊號丟失偵測（§4.6）：ready 之後，前景而 >SIGNAL_LOST_MS 冇新 fix 就當丟失
  useEffect(() => {
    if (status !== 'ready') return;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (lastFixTs.current && Date.now() - lastFixTs.current > SIGNAL_LOST_MS) setSignalLost(true);
    }, 1000);
    return () => clearInterval(id);
  }, [status]);

  return {
    status,
    fix,
    hk80,
    place,
    placeStatus,
    error,
    poorAccuracy: !!fix && fix.accuracy > GEO.POOR_ACCURACY_M,
    motion,
    speedKmh,
    signalLost,
    refresh,
  };
}
