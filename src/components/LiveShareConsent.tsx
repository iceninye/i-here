/**
 * 實時分享 opt-in 說明（PLAN §5.4 第 1 項，D8）。
 *
 * 開始前一定要講明三件事：
 *  1. 座標以**加密**方式經 i-here server 中轉，server 睇唔到內容；
 *  2. TTL（30 分鐘）自動結束，隨時可以停止；
 *  3. **有完整 link 嘅人都睇到你嘅位置**（link 係 bearer secret）。
 * 另外提一句：PWA 冇背景定位，雙方都要保持畫面開著前景（§3），會耗電。
 */
import type { ReactElement } from 'react';
import { Icon } from './Icon';
import { LIVE_TTL_MINUTES } from '../hooks/useLiveShare';

interface Props {
  /** host = 我發起分享；guest = 對方邀請我 */
  mode: 'host' | 'guest';
  busy?: boolean;
  onAccept: () => void;
  onCancel: () => void;
}

export function LiveShareConsent({ mode, busy, onAccept, onCancel }: Props): ReactElement {
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="live-consent-title">
      <div className="sheet__panel">
        <h2 id="live-consent-title" className="sheet__title">
          {mode === 'host' ? '開始實時分享位置' : '對方邀請你實時分享位置'}
        </h2>

        <p className="live-consent__lead">
          {mode === 'host'
            ? '你同對方會即時看到彼此嘅位置，直到你停止或者時間到。'
            : '接受之後，你會看到對方嘅實時位置，對方同時會看到你嘅實時位置。'}
        </p>

        <ul className="live-consent__list">
          <li>
            <Icon name="lock" />
            <span>位置以<b>加密</b>方式經 i-here server 中轉，<b>server 睇唔到你嘅座標</b>，亦唔會儲存。</span>
          </li>
          <li>
            <Icon name="alert" />
            <span><b>有完整 link 嘅人都睇到你嘅位置</b>。請只傳給你信任嘅人；傳錯咗就即刻撳「停止」。</span>
          </li>
          <li>
            <Icon name="refresh" />
            <span>{LIVE_TTL_MINUTES} 分鐘後自動結束，期間你隨時可以一鍵停止或者踢走對方。</span>
          </li>
          <li>
            <Icon name="signal" />
            <span>瀏覽網頁嘅 App 冇辦法喺背景定位：<b>雙方都要保持呢個畫面開著</b>（螢幕會盡量保持亮著），會比較耗電。</span>
          </li>
        </ul>

        <button type="button" className="sheet__btn sheet__btn--live" onClick={onAccept} disabled={busy}>
          <Icon name="people" /> {busy ? '連線中…' : mode === 'host' ? '我明白，開始分享' : '我明白，接受邀請'}
        </button>
        <button type="button" className="sheet__close" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </div>
    </div>
  );
}
