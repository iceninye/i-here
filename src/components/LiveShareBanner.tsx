/**
 * 實時分享常駐 UI（PLAN §5.3「常駐 UI（必要）」、D8）。
 *
 *  - 頂部固定 banner：紅點 + 「正在分享實時位置」+ TTL 倒數 + 一鍵停止；
 *  - 對方狀態（連線中 / 已暫停 / 訊號丟失 / 已離開）來自 server 嘅 `peer` 訊息；
 *  - 房主另外見到已加入人數 + 邀請連結（複製 / 原生分享），同「踢走」；
 *  - 房散 / 錯誤 → 顯示原因，可以「知道了」關閉。
 */
import { useState, type ReactElement } from 'react';
import type { LiveShareState } from '../hooks/useLiveShare';
import type { EndReason, PeerState } from '../lib/liveShare';
import { Icon } from './Icon';

const PEER_LABEL: Record<PeerState, string> = {
  joined: '連線中',
  live: '已連線',
  paused: '已暫停',
  lost: '訊號丟失',
  left: '已離開',
};

const END_LABEL: Record<EndReason, string> = {
  stop: '實時分享已結束',
  ttl: '實時分享已結束（時間到）',
  closed: '實時分享已結束（房間已關閉）',
  kicked: '你已被移出房間',
  full: '房間已滿（上限 2 人），請叫對方重新建立',
};

/** ms → `m:ss`（倒數用；唔用 toLocaleString 免得老裝置格式唔一致） */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * @param keepAwake Screen Wake Lock 支援同申請成功（§4.5）；false 就提一句「螢幕可能會自動關閉」
 */
export function LiveShareBanner({ live, keepAwake = false }: { live: LiveShareState; keepAwake?: boolean }): ReactElement | null {
  const [copied, setCopied] = useState(false);
  const { status, role, link, peers, peerCount, remainingMs, endReason, error } = live;

  const shareLink = async () => {
    if (!link) return;
    const text = `實時分享位置（${formatRemaining(remainingMs)} 內有效，打開就會看到我嘅位置）：${link}`;
    if (navigator.share) {
      try { await navigator.share({ title: '實時分享位置', text }); return; }
      catch (e) { if ((e as DOMException)?.name === 'AbortError') return; }
    }
    await copyLink();
  };

  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // 舊瀏覽器 / 非 HTTPS
      const ta = document.createElement('textarea');
      ta.value = link;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  if (status === 'ended' || status === 'error') {
    return (
      <div className="live live--ended" role="status">
        <p className="live__text">{error ?? (endReason ? END_LABEL[endReason] : '實時分享已結束')}</p>
        <button type="button" className="live__btn live__btn--ghost" onClick={live.dismiss}>知道了</button>
      </div>
    );
  }

  if (status !== 'live' && status !== 'connecting' && status !== 'starting') return null;

  return (
    <div className="live" role="status" aria-live="polite">
      <div className="live__row">
        <Icon name="dot" className="icon--filled live__dot" />
        <span className="live__title">正在分享實時位置</span>
        <span className="live__ttl">剩 {formatRemaining(remainingMs)}</span>
        <button type="button" className="live__btn live__btn--stop" onClick={live.stop}>
          <Icon name="square" /> 停止
        </button>
      </div>

      {status !== 'live' && <p className="live__note">連線中…</p>}
      {status === 'live' && !keepAwake && (
        <p className="live__note">螢幕可能會自動關閉 —— 請保持呢個畫面開著，否則對方會睇唔到你。</p>
      )}

      {role === 'host' && link && (
        <div className="live__invite">
          <p className="live__note">
            已加入 {peerCount} / 2 人{peerCount < 2 ? ' · 傳連結俾對方先睇到你' : ''}
          </p>
          <div className="live__invite-btns">
            <button type="button" className="live__btn" onClick={shareLink}>
              <Icon name="share" /> 傳邀請連結
            </button>
            <button type="button" className="live__btn" onClick={copyLink}>
              <Icon name={copied ? 'check' : 'copy'} /> {copied ? '已複製' : '複製連結'}
            </button>
          </div>
        </div>
      )}

      {peers.length === 0
        ? <p className="live__note">{role === 'host' ? '等緊對方加入…' : '等緊對方位置…'}</p>
        : (
          <ul className="live__peers">
            {peers.map(p => (
              <li key={p.id} className="live__peer">
                <span className={`live__state live__state--${p.state}`}>{PEER_LABEL[p.state]}</span>
                <span className="live__peer-name">對方</span>
                {role === 'host' && (
                  <button type="button" className="live__btn live__btn--ghost" onClick={() => live.kick(p.id)}>
                    踢走
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
