/**
 * App 內置瀏覽器（WhatsApp / Facebook / Instagram / Line / WeChat…）常常封鎖或者每次都重新詢問定位，
 * 而「分享連結」嘅主要入口正正係 WhatsApp，所以要偵測並提示用 Safari / Chrome 開。
 */
const IN_APP = /FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|WhatsApp|Snapchat|Telegram|TikTok|musical_ly|Twitter/i;

export type InAppInfo = { name: string } | null;

export function detectInAppBrowser(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): InAppInfo {
  const m = IN_APP.exec(ua);
  if (!m) return null;
  const key = m[0].toLowerCase();
  const name =
    key.startsWith('fb') ? 'Facebook'
    : key.startsWith('instagram') ? 'Instagram'
    : key.startsWith('line') ? 'Line'
    : key.startsWith('micromessenger') ? '微信'
    : key.startsWith('whatsapp') ? 'WhatsApp'
    : key.startsWith('snapchat') ? 'Snapchat'
    : key.startsWith('telegram') ? 'Telegram'
    : key.includes('tiktok') || key.startsWith('musical') ? 'TikTok'
    : 'App';
  return { name };
}

export function isIOS(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
  return /iPhone|iPad|iPod/i.test(ua);
}
