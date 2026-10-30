import { useMemo, useState } from 'react';
import { LocationCard } from './components/LocationCard';
import { MapView } from './components/MapView';
import { ShareButton } from './components/ShareButton';
import { useCurrentLocation } from './hooks/useCurrentLocation';
import { googleMapsUrl, parseSharedLocation } from './lib/shareText';

export default function App() {
  // 收件人打開家人分享嘅連結（?at=lat,lng）：先顯示對方位置，唔即刻彈定位權限嚇親人
  const shared = useMemo(() => parseSharedLocation(location.search), []);
  const [viewingShared, setViewingShared] = useState(!!shared);
  const loc = useCurrentLocation({ enabled: !viewingShared });
  const [is3D, setIs3D] = useState(false);

  const backToMe = () => {
    history.replaceState(null, '', location.pathname);
    setViewingShared(false);
  };

  return (
    <div className="app">
      <MapView fix={viewingShared ? null : loc.fix} is3D={is3D} sharedPin={viewingShared ? shared : null} />

      <header className="top">
        {viewingShared && shared ? (
          <section className="card" aria-label="家人分享的位置">
            <p className="card__eyebrow">家人分享的位置</p>
            <p className="card__title">{shared.label ?? '地圖上的紅色標記'}</p>
            <a className="card__action" href={googleMapsUrl(shared.lat, shared.lng)} target="_blank" rel="noopener">
              🧭 用 Google 地圖導航前往
            </a>
          </section>
        ) : (
          <LocationCard loc={loc} />
        )}
      </header>

      <footer className="bottom">
        {viewingShared ? (
          <button type="button" className="share-btn share-btn--secondary" onClick={backToMe}>
            📍 看看我自己的位置
          </button>
        ) : (
          <ShareButton fix={loc.fix} place={loc.place} failed={loc.status === 'error'} />
        )}
        <div className="tools">
          {!viewingShared && (
            <button type="button" className="tool-btn" onClick={loc.refresh} disabled={loc.status === 'locating'}>
              <span aria-hidden="true">🔄</span> 重新定位
            </button>
          )}
          <button type="button" className="tool-btn" onClick={() => setIs3D(v => !v)} aria-pressed={is3D}>
            <span aria-hidden="true">{is3D ? '🗺️' : '🏢'}</span> {is3D ? '平面地圖' : '立體圖'}
          </button>
        </div>
      </footer>
    </div>
  );
}
