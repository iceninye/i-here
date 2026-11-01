import { useEffect, useMemo, useRef, useState } from 'react';
import { DebugPanel } from './components/DebugPanel';
import { Icon } from './components/Icon';
import { InAppBanner } from './components/InAppBanner';
import { LiveShareBanner } from './components/LiveShareBanner';
import { LiveShareConsent } from './components/LiveShareConsent';
import { LocationCard } from './components/LocationCard';
import { MapView } from './components/MapView';
import { ShareButton } from './components/ShareButton';
import { useCurrentLocation } from './hooks/useCurrentLocation';
import { useLiveShare } from './hooks/useLiveShare';
import { useWakeLock } from './hooks/useWakeLock';
import { googleMapsUrl, parseSharedLocation } from './lib/shareText';

export default function App() {
  // 收件人打開別人分享嘅連結（?at=lat,lng）：先顯示對方位置，唔即刻彈定位權限
  const shared = useMemo(() => parseSharedLocation(location.search), []);
  const [viewingShared, setViewingShared] = useState(!!shared);
  const loc = useCurrentLocation({ enabled: !viewingShared });
  const live = useLiveShare(loc.fix);
  // opt-in 對話框（§5.4）：host = 我發起；guest 由 live.pendingJoin 驅動
  const [hostConsent, setHostConsent] = useState(false);
  // Screen Wake Lock 只喺 opt-in 時申請（§4.5）：實時分享期間，或者用戶自己開「保持螢幕著」
  const [keepAwake, setKeepAwake] = useState(false);
  const wake = useWakeLock(live.status === 'live' || keepAwake);
  const [is3D, setIs3D] = useState(false);
  // 次要功能（實時分享 / 保持螢幕著）收埋，撳「更多」先展開 —— 騰出更多地圖空間
  const [moreOpen, setMoreOpen] = useState(false);
  const bottomRef = useRef<HTMLElement>(null);

  // 底欄高度（隨字體大小 / 提示 / 安全區變）量度後放入 --bottom-h：
  // 地圖版權（© 地政總署）同「回到我的位置」掣要企喺底欄上面，唔可以被佢遮住
  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const apply = () => document.documentElement.style.setProperty('--bottom-h', `${el.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const debug = useMemo(() => new URLSearchParams(location.search).has('debug'), []);

  const backToMe = () => {
    history.replaceState(null, '', location.pathname + (debug ? '?debug=1' : ''));
    setViewingShared(false);
  };

  const showLiveStart = !viewingShared && live.available && (live.status === 'idle' || live.status === 'ended' || live.status === 'error');
  const showKeepAwake = !viewingShared && wake.supported && live.status !== 'live';

  return (
    <div className="app">
      <MapView
        fix={viewingShared ? null : loc.fix}
        is3D={is3D}
        motion={loc.motion}
        signalLost={loc.signalLost}
        sharedPin={viewingShared ? shared : null}
        livePeers={live.peers}
      />

      <header className="top">
        <LiveShareBanner live={live} keepAwake={wake.active} />
        {viewingShared && shared ? (
          <section className="card" aria-label="對方分享的位置">
            <p className="card__eyebrow">對方分享的位置</p>
            <p className="card__title">{shared.label ?? '地圖上的紅色標記'}</p>
            <a className="card__action" href={googleMapsUrl(shared.lat, shared.lng)} target="_blank" rel="noopener">
              <Icon name="navigate" /> 用 Google 地圖導航前往
            </a>
          </section>
        ) : (
          <LocationCard loc={loc} />
        )}
        <InAppBanner />
        {debug && <DebugPanel loc={loc} live={live} />}
      </header>

      <footer className="bottom" ref={bottomRef}>
        {viewingShared ? (
          <button type="button" className="share-btn share-btn--secondary" onClick={backToMe}>
            <Icon name="pin" /> 看看我自己的位置
          </button>
        ) : (
          <ShareButton fix={loc.fix} place={loc.place} failed={loc.status === 'error'} />
        )}
        {/* 全部次要掣預設收埋：撳「更多」先展開，再撳收埋。分享掣永遠見到 */}
        {(
          <button
            type="button" className="more-toggle" onClick={() => setMoreOpen(v => !v)}
            aria-expanded={moreOpen} aria-controls="more-tools"
          >
            {moreOpen ? '收埋' : '更多'} <span className="chev" aria-hidden="true">{moreOpen ? '▾' : '▴'}</span>
          </button>
        )}
        {moreOpen && (
          <div id="more-tools">
            <div className="tools">
              {!viewingShared && (
                <button type="button" className="tool-btn" onClick={loc.refresh} disabled={loc.status === 'locating'}>
                  <Icon name="refresh" /> 更新
                </button>
              )}
              <button type="button" className="tool-btn" onClick={() => setIs3D(v => !v)} aria-pressed={is3D}>
                <Icon name={is3D ? 'layers' : 'cube'} /> {is3D ? '平面' : '立體'}
              </button>
              {/* 唔支援 Wake Lock 就唔顯示呢個掣（撳咗都冇用，得返個「可能會自動熄屏」提示） */}
              {showKeepAwake && (
                <button type="button" className="tool-btn" onClick={() => setKeepAwake(v => !v)} aria-pressed={keepAwake}>
                  <Icon name="sun" /> 常亮
                </button>
              )}
              {/* Worker 未設定（VITE_LIVE_API 空）就完全唔顯示入口；分享中由頂部 banner 負責停止 */}
              {showLiveStart && (
                <button type="button" className="tool-btn" onClick={() => { setMoreOpen(false); setHostConsent(true); }}>
                  <Icon name="people" /> 實時分享
                </button>
              )}
            </div>
            {/* 版本：手機有時會跑緊舊快取，貼問題嚟嘅時候一眼睇到係邊個版本（日期時間係 UTC，香港 +8 小時） */}
            <p className="version">版本 {__BUILD_ID__}</p>
          </div>
        )}
      </footer>

      {hostConsent && !live.pendingJoin && (
        <LiveShareConsent
          mode="host"
          busy={live.status === 'starting'}
          onAccept={() => { setHostConsent(false); void live.hostStart(); }}
          onCancel={() => setHostConsent(false)}
        />
      )}
      {live.pendingJoin && (
        <LiveShareConsent
          mode="guest"
          busy={live.status === 'connecting'}
          onAccept={() => void live.joinAccept()}
          onCancel={live.joinDecline}
        />
      )}
    </div>
  );
}
