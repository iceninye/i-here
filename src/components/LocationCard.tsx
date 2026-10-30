import type { CurrentLocation } from '../hooks/useCurrentLocation';
import { GEO } from '../lib/geo';
import { placeHeadline } from '../lib/shareText';

function accuracyLabel(acc: number): { text: string; level: 'good' | 'ok' | 'poor' } {
  if (!Number.isFinite(acc)) return { text: '準確度未知', level: 'poor' };
  const m = Math.round(acc);
  if (acc <= GEO.GOOD_ACCURACY_M * 2) return { text: `很準確（約 ${m} 米內）`, level: 'good' };
  if (acc <= GEO.POOR_ACCURACY_M) return { text: `大致準確（約 ${m} 米內）`, level: 'ok' };
  return { text: `不太準確（約 ${m} 米）`, level: 'poor' };
}

const ERROR_TEXT: Record<string, string> = {
  denied: '未有開啟定位權限',
  unsupported: '這部手機的瀏覽器不支援定位',
  timeout: '暫時找不到定位訊號',
  unavailable: '暫時找不到定位訊號',
  'outside-hk': '你似乎不在香港範圍內',
};

/** 頂部大字卡：「你現在位於：興輝樓附近」。所有變化都會被讀屏器讀出（aria-live）。 */
export function LocationCard({ loc }: { loc: CurrentLocation }) {
  const { fix, place, placeStatus, error, status } = loc;
  const headline = placeHeadline(place);
  const acc = fix ? accuracyLabel(fix.accuracy) : null;

  return (
    <section className="card" aria-live="polite" aria-atomic="true" aria-label="你的位置">
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
                <li><b>Android：</b>按網址列左邊的 🔒 → 權限 → 位置 → 允許</li>
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
              附近還有：{place.landmarks.map(l => `${l.name}（${Math.round(l.distanceM)} 米）`).join('、')}
            </p>
          )}
          {(placeStatus === 'failed' || placeStatus === 'not-found') && !place && (
            <p className="card__sub">未能查到地址，但你仍然可以分享位置給家人。</p>
          )}
          {error?.code === 'outside-hk' && <p className="card__sub">{ERROR_TEXT['outside-hk']}，未能顯示香港地址。</p>}
          {acc && (
            <p className={`badge badge--${acc.level}`}>
              <span aria-hidden="true">{acc.level === 'poor' ? '⚠️' : '📶'}</span> {acc.text}
            </p>
          )}
          {loc.poorAccuracy && <p className="card__hint">位置可能有偏差：請走到較空曠的地方，再按「重新定位」。</p>}
        </>
      )}
    </section>
  );
}
