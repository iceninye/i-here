import { useState } from 'react';
import { detectInAppBrowser, isIOS } from '../lib/inAppBrowser';

/** 由 WhatsApp / Facebook 等 App 內打開時顯示：教用戶用 Safari / Chrome 開，定位先可靠。 */
export function InAppBanner() {
  const info = detectInAppBrowser();
  const [copied, setCopied] = useState(false);
  const [hidden, setHidden] = useState(false);
  if (!info || hidden) return null;

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(location.href); setCopied(true); } catch { /* 剪貼簿唔可用就算 */ }
  };

  return (
    <div className="banner" role="note">
      <p className="banner__title">你而家用緊 {info.name} 內置瀏覽器，定位可能會被封鎖。</p>
      <p className="banner__text">
        請撳畫面{isIOS() ? '右下角' : '右上角'}嘅選單，揀「用{isIOS() ? ' Safari ' : ' Chrome 或預設瀏覽器 '}開啟」，或者複製連結再貼上去。
      </p>
      <div className="banner__buttons">
        <button type="button" className="banner__btn" onClick={copyLink}>{copied ? '已複製' : '複製連結'}</button>
        <button type="button" className="banner__btn banner__btn--ghost" onClick={() => setHidden(true)}>知道了</button>
      </div>
    </div>
  );
}
