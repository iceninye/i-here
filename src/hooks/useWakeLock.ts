/**
 * Screen Wake Lock（PLAN §4.5）
 *
 * 用途：live share 進行中、或用戶打開「保持螢幕著」時，阻止螢幕自動關閉
 * （PWA 冇背景定位，螢幕一熄 GPS 就停 —— 見 §3）。
 *
 * 設計：
 *  - **只喺 opt-in 時申請**（`enabled === true`），唔係一開追蹤就申請 —— 長時間著屏好食電。
 *  - 回前景時重新申請（瀏覽器喺失焦 / 熄屏時會自動釋放 lock）。
 *  - 唔支援 / 申請失敗 → 靜默降級（`supported: false` 或 `active: false`），唔 throw。
 *  - iOS Safari 對 Wake Lock 支援有限（見 §3）；唔支援就當冇事發生。
 */

import { useEffect, useRef, useState } from 'react';

type WakeLockSentinel = { released: boolean; release: () => Promise<void>; addEventListener: (t: string, h: () => void) => void };
type WakeLockApi = { request: (type: 'screen') => Promise<WakeLockSentinel> };

function getWakeLock(): WakeLockApi | null {
  if (typeof navigator === 'undefined') return null;
  return ((navigator as unknown as { wakeLock?: WakeLockApi }).wakeLock) ?? null;
}

export interface WakeLockState {
  /** 裝置 / 瀏覽器支援 Wake Lock 嗎 */
  supported: boolean;
  /** 而家係咪成功持有一個 screen lock */
  active: boolean;
}

/**
 * @param enabled 只有 true 先會申請 lock（opt-in）。轉 false 會釋放。
 */
export function useWakeLock(enabled: boolean): WakeLockState {
  const supported = useRef<boolean>(getWakeLock() !== null).current;
  const [active, setActive] = useState(false);
  const sentinel = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    const api = getWakeLock();
    if (!enabled || !api) {
      // 釋放現有 lock（如果有）
      void sentinel.current?.release().catch(() => {});
      sentinel.current = null;
      setActive(false);
      return;
    }

    let cancelled = false;

    const request = async () => {
      try {
        const s = await api.request('screen');
        if (cancelled) { void s.release().catch(() => {}); return; }
        sentinel.current = s;
        setActive(true);
        // 瀏覽器释放（熄屏 / 失焦）→ 標記唔再 active；回前景會由 visibilitychange 重新申請
        s.addEventListener('release', () => { if (!cancelled) setActive(false); });
      } catch {
        if (!cancelled) setActive(false); // 靜默降級
      }
    };

    void request();

    const onVisibility = () => {
      // 回前景而 lock 已被釋放（熄屏 / 失焦時瀏覽器會自动 release）→ 重新申請
      if (document.visibilityState === 'visible' && (!sentinel.current || sentinel.current.released)) {
        void request();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void sentinel.current?.release().catch(() => {});
      sentinel.current = null;
      setActive(false);
    };
  }, [enabled]);

  return { supported, active };
}
