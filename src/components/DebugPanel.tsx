import { useSyncExternalStore } from 'react';
import type { CurrentLocation } from '../hooks/useCurrentLocation';
import { getApiLog, subscribeApiLog } from '../lib/apiLog';

/** 網址加 ?debug=1 先出現：顯示定位同每個 API call 嘅結果，方便喺手機上排查（例如 CORS）。 */
export function DebugPanel({ loc }: { loc: CurrentLocation }) {
  const log = useSyncExternalStore(subscribeApiLog, getApiLog);
  const text = [
    `fix: ${loc.fix ? `${loc.fix.lat.toFixed(6)}, ${loc.fix.lng.toFixed(6)} ±${Math.round(loc.fix.accuracy)}m` : '-'}`,
    `hk80: ${loc.hk80 ? `${loc.hk80.x.toFixed(1)}, ${loc.hk80.y.toFixed(1)} (${loc.hk80.source})` : '-'}`,
    `place: ${loc.placeStatus}${loc.place ? ` · ${loc.place.name} · ${loc.place.source}` : ''}`,
    '',
    ...log.map(e => `[${e.status === 'pending' ? '…' : e.ok ? 'OK' : 'FAIL'}] ${e.name} · ${e.status} · ${e.ms}ms\n${e.url}\n${e.snippet}\n`),
  ].join('\n');

  return (
    <details className="debug">
      <summary>🔧 診斷資料（{log.length}）</summary>
      <button type="button" className="debug__copy" onClick={() => navigator.clipboard?.writeText(text)}>
        複製全部
      </button>
      <pre className="debug__log">{text}</pre>
    </details>
  );
}
