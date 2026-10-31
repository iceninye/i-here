import { useSyncExternalStore } from 'react';
import type { CurrentLocation } from '../hooks/useCurrentLocation';
import { getApiLog, subscribeApiLog } from '../lib/apiLog';
import { fixLogCsv, getFixLog, subscribeFixLog } from '../lib/fixLog';

const copy = (text: string) => { void navigator.clipboard?.writeText(text); };

const hhmmss = (t: number) => new Date(t).toTimeString().slice(0, 8);

/** 一個請求嘅「問咩」：identify / searchNearby 係 HK80 座標，坐標轉換係經緯度，ALS 係查詢字頭 */
function queryHint(url: string): string {
  try {
    const q = new URL(url).searchParams;
    if (q.has('x')) return `x=${q.get('x')},y=${q.get('y')}`;
    if (q.has('lat')) return `${Number(q.get('lat')).toFixed(5)},${Number(q.get('long')).toFixed(5)}`;
    if (q.has('q')) return `「${(q.get('q') ?? '').slice(0, 10)}…」`;
  } catch { /* 唔係合法 URL 就算 */ }
  return '';
}

/** 網址加 ?debug=1 先出現：顯示定位同每個 API call 嘅結果，方便喺手機上排查，亦可以錄低真實回應做測試 fixture。 */
export function DebugPanel({ loc }: { loc: CurrentLocation }) {
  const log = useSyncExternalStore(subscribeApiLog, getApiLog);
  const fixes = useSyncExternalStore(subscribeFixLog, getFixLog);
  const latestPerApi = log.filter((e, i) => e.body && log.findIndex(o => o.name === e.name && o.body) === i);
  const summary = [
    `build: ${__BUILD_ID__}`,
    `fix: ${loc.fix ? `${loc.fix.lat.toFixed(6)}, ${loc.fix.lng.toFixed(6)} ±${Math.round(loc.fix.accuracy)}m` : '-'}`,
    `hk80: ${loc.hk80 ? `${loc.hk80.x.toFixed(1)}, ${loc.hk80.y.toFixed(1)} (${loc.hk80.source})` : '-'}`,
    `place: ${loc.placeStatus}${loc.place ? ` · ${loc.place.name} · ${loc.place.kind} · ${loc.place.source}` : ''}`,
    '',
    ...log.map(e => `[${e.status === 'pending' ? '…' : e.ok ? 'OK' : 'FAIL'}] ${hhmmss(e.at)} ${e.name} · ${e.status} · ${e.ms}ms\n${e.url}\n${e.snippet}\n`),
  ].join('\n');

  return (
    <details className="debug">
      <summary>🔧 診斷資料（API {log.length} · 定位 {fixes.length}）</summary>
      <div className="debug__buttons">
        <button type="button" className="debug__copy" onClick={() => copy(summary)}>複製摘要</button>
        <button type="button" className="debug__copy" onClick={() => copy(fixLogCsv())} disabled={!fixes.length}>
          複製定位紀錄 CSV
        </button>
      </div>
      <div className="debug__buttons">
        {/* 每個 API 只列最新一次（精度改善會重新查一次，舊嘅都喺「複製摘要」入面）；附上查詢座標同時間，分得清邊次 */}
        {latestPerApi.map(e => (
          <button key={e.name} type="button" className="debug__copy" onClick={() => copy(`${e.url}\n${e.body}`)}>
            原始回應：{e.name} {hhmmss(e.at)} {queryHint(e.url)}（{e.body!.length} 字）
          </button>
        ))}
      </div>
      <pre className="debug__log">{summary}</pre>
    </details>
  );
}
