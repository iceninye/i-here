import { useState } from 'react';
import type { Fix } from '../lib/geo';
import type { ResolvedPlace } from '../lib/reverseGeocode';
import { buildShareText, smsUrl, whatsappUrl } from '../lib/shareText';

interface Props {
  fix: Fix | null;
  place: ResolvedPlace | null;
  /** 定位失敗（例如未俾權限），唔好再顯示「正在定位…」誤導 */
  failed?: boolean;
}

type Result = 'shared' | 'copied' | null;

/**
 * 一鍵分享：
 *  - 有 Web Share API（iOS Safari、Android Chrome）→ 直接彈原生分享選單（WhatsApp / Telegram / SMS…）
 *  - 冇（桌面 Firefox、部分 in-app browser）或者分享失敗 → 顯示大按鈕後備選單
 *  - 未查到地址都可以分享座標：緊急情況唔應該等 API
 */
export function ShareButton({ fix, place, failed }: Props) {
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [result, setResult] = useState<Result>(null);

  const text = fix ? buildShareText(fix, place) : '';

  const onShare = async () => {
    if (!fix) return;
    if (navigator.vibrate) navigator.vibrate(30);
    // 只傳 text（連結已經喺入面）：同時傳 url 嘅話，部分 Android App 會只收 url 或者重複
    const data: ShareData = { title: '我的位置', text };
    if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
      try {
        await navigator.share(data);
        setResult('shared');
        return;
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return; // 用戶自己取消
      }
    }
    setFallbackOpen(true);
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 舊瀏覽器 / 非 HTTPS
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setResult('copied');
  };

  return (
    <>
      <button
        type="button"
        className="share-btn"
        onClick={onShare}
        disabled={!fix}
        aria-describedby="share-hint"
      >
        <span aria-hidden="true" className="share-btn__icon">📤</span>
        <span>{fix ? '分享我的位置' : failed ? '未能取得位置' : '正在定位…'}</span>
      </button>
      <p id="share-hint" className="sr-only">
        會打開分享選單，可以用 WhatsApp、短訊或其他程式將你的位置傳送給家人
      </p>
      <p className="share-result" role="status" aria-live="polite">
        {result === 'shared' && '✅ 已分享'}
        {result === 'copied' && '✅ 已複製，可以貼上傳送'}
      </p>

      {fallbackOpen && (
        <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
          <div className="sheet__panel">
            <h2 id="sheet-title" className="sheet__title">傳送位置給家人</h2>
            <a className="sheet__btn sheet__btn--wa" href={whatsappUrl(text)} target="_blank" rel="noopener">
              <span aria-hidden="true">💬</span> WhatsApp
            </a>
            <a className="sheet__btn sheet__btn--sms" href={smsUrl(text)}>
              <span aria-hidden="true">✉️</span> 短訊 SMS
            </a>
            <button type="button" className="sheet__btn" onClick={onCopy}>
              <span aria-hidden="true">📋</span> 複製文字
            </button>
            <pre className="sheet__preview" aria-label="將會傳送的內容">{text}</pre>
            <button type="button" className="sheet__close" onClick={() => setFallbackOpen(false)}>
              關閉
            </button>
          </div>
        </div>
      )}
    </>
  );
}
