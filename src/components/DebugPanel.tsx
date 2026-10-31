import { useSyncExternalStore } from 'react';
import type { CurrentLocation } from '../hooks/useCurrentLocation';
import { getApiLog, subscribeApiLog } from '../lib/apiLog';
import { fixLogCsv, getFixLog, subscribeFixLog } from '../lib/fixLog';

const copy = (text: string) => { void navigator.clipboard?.writeText(text); };

/** 網址加 ?debug=1 先出現：顯示定位同每個 API call 嘅結果，方便喺手機上排查，亦可以錄低真實回應做測試 fixture。 */
export function DebugPanel({ loc }: { loc: CurrentLocation }) {
  const log = useSyncExternalStore(subscribeApiLog, getApiLog);
  const fixes = useSyncExternalStore(subscribeFixLog, getFixLog);
  const summary = [
    `fix: ${loc.fix ? `${loc.fix.lat.toFixed(6)}, ${loc.fix.lng.toFixed(6)} ±${Math.round(loc.fix.accuracy)}m` : '-'}`,
    `hk80: ${loc.hk80 ? `${loc.hk80.x.toFixed(1)}, ${loc.hk80.y.toFixed(1)} (${loc.hk80.source})` : '-'}`,
    `place: ${loc.placeStatus}${loc.place ? ` · ${loc.place.name} · ${loc.place.kind} · ${loc.place.source}` : ''}`,
    '',
    ...log.map(e => `[${e.status === 'pending' ? '…' : e.ok ? 'OK' : 'FAIL'}] ${e.name} · ${e.status} · ${e.ms}ms\n${e.url}\n${e.snippet}\n`),
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
        {log.filter(e => e.body).map((e, i) => (
          <button key={`${e.url}-${i}`} type="button" className="debug__copy" onClick={() => copy(`${e.url}\n${e.body}`)}>
            原始回應：{e.name}（{e.body!.length} 字）
          </button>
        ))}
      </div>
      <pre className="debug__log">{summary}</pre>
    </details>
  );
}
