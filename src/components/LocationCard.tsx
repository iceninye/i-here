import type { CurrentLocation } from '../hooks/useCurrentLocation';
import { placeHeadline } from '../lib/shareText';
import { Icon } from './Icon';

function accuracyLabel(acc: number): { text: string; level: 'good' | 'ok' | 'poor' } {
  if (!Number.isFinite(acc)) return { text: '準確度未知', level: 'poor' };
  const m = Math.round(acc);
  // 實測：第一個 fix 話 ±24 m，真實誤差 ~26 m；約 17 秒後先收窄到 ±3 m。所以 ±15 m 以上唔好叫「很準確」
  if (acc <= 15) return { text: `很準確（約 ${m} 米內）`, level: 'good' };
  if (acc <= 60) return { text: `大致準確（約 ${m} 米內），仍在提升`, level: 'ok' };
  return { text: `不太準確（約 ${m} 米）`, level: 'poor' };
}

const ERROR_TEXT: Record<string, string> = {
  denied: '未有開啟定位權限',
  unsupported: '這部手機的瀏覽器不支援定位',
  timeout: '暫時找不到定位訊號',
  unavailable: '暫時找不到定位訊號',
  'outside-hk': '你似乎不在香港範圍內',
};

/** 一句會被讀屏器讀出嘅說明。只有呢一行係 live region，咁地址 / 精度更新時唔會成張卡由頭讀過。 */
function announcement(loc: CurrentLocation, headline: string | null): string {
  if (!loc.fix) {
    if (loc.status === 'error' && loc.error) return ERROR_TEXT[loc.error.code] ?? '未能定位';
    return '正在找你的位置';
  }
  if (headline) return `你現在位於${headline}`;
  return loc.placeStatus === 'loading' || loc.placeStatus === 'idle' ? '已找到你的位置，正在查詢附近地址' : '已找到你的位置，未能查到地址';
}

/** 頂部大字卡：「你現在位於：興輝樓附近」。 */
export function LocationCard({ loc }: { loc: CurrentLocation }) {
  const { fix, place, placeStatus, error, status } = loc;
  const headline = placeHeadline(place);
  const acc = fix ? accuracyLabel(fix.accuracy) : null;

  return (
    <section className="card" aria-label="你的位置">
      <p className="sr-only" role="status" aria-live="polite">{announcement(loc, headline)}</p>
      {!fix && status !== 'error' && (
        <>
          <p className="card__eyebrow">請稍等幾秒</p>
          <p className="card__title"><span className="spinner" aria-hidden="true" /> 正在找你的位置…</p>
        </>
      )}

      {!fix && status === 'error' && error && (
        <>
          <p className="card__title card__title--warn">{ERROR_TEXT[error.code]}</p>
          {error.code === 'denied' ? (
            <div className="card__help">
              <p>請允許這個網頁使用你的位置：</p>
              <ul>
                <li><b>iPhone：</b>設定 → 私隱與保安 → 定位服務 → Safari → 「使用 App 期間」</li>
                <li><b>Android：</b>按網址列左邊的 <Icon name="lock" /> → 權限 → 位置 → 允許</li>
              </ul>
              <p>然後按下面的「重新定位」。</p>
            </div>
          ) : (
            <p className="card__sub">請走到較空曠的地方，再按「重新定位」。</p>
          )}
        </>
      )}

      {fix && (
        <>
          <p className="card__eyebrow">你現在位於</p>
          {headline ? (
            <p className="card__title">{headline}</p>
          ) : (
            <p className="card__title card__title--muted">
              {placeStatus === 'loading' || placeStatus === 'idle' ? '正在查詢附近地址…' : '已找到你的位置'}
            </p>
          )}
          {place?.address && <p className="card__sub">{place.address}</p>}
          {place && place.landmarks.length > 0 && (
            <p className="card__landmarks">
              附近還有：{place.landmarks.map(l => (Math.round(l.distanceM) > 0 ? `${l.name}（${Math.round(l.distanceM)} 米）` : l.name)).join('、')}
            </p>
          )}
          {place?.source === 'osm' && <p className="card__source">地址資料來源：OpenStreetMap</p>}
          {(placeStatus === 'failed' || placeStatus === 'not-found') && !place && (
            <p className="card__sub">未能查到地址，但你仍然可以分享位置。</p>
          )}
          {error?.code === 'outside-hk' && <p className="card__sub">{ERROR_TEXT['outside-hk']}，未能顯示香港地址。</p>}
          {acc && (
            <p className={`badge badge--${acc.level}`}>
              <Icon name={acc.level === 'poor' ? 'alert' : 'signal'} /> {acc.text}
            </p>
          )}
          {loc.poorAccuracy && <p className="card__hint">位置可能有偏差：請走到較空曠的地方，再按「重新定位」。</p>}
        </>
      )}
    </section>
  );
}
