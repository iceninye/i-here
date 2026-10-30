import type { Fix } from './geo';
import type { ResolvedPlace } from './reverseGeocode';

export function googleMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

/** 本 App 嘅「睇位置」連結：收件人打開會見到地政總署地圖上嘅位置 pin */
export function appViewUrl(lat: number, lng: number, label?: string, base = typeof location !== 'undefined' ? location.href : ''): string {
  const u = new URL(base || 'https://example.invalid/');
  u.search = '';
  u.hash = '';
  u.searchParams.set('at', `${lat.toFixed(6)},${lng.toFixed(6)}`);
  if (label) u.searchParams.set('n', label.slice(0, 60));
  return u.toString();
}

export function placeHeadline(place: ResolvedPlace | null): string | null {
  if (!place) return null;
  return place.proximity === 'at' ? place.name : `${place.name}附近`;
}

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 分享訊息。設計原則：
 *  - 第一行就係重點（WhatsApp 通知預覽只見到一兩行）
 *  - 冇地址都照樣分享座標 —— 緊急時唔可以因為 API 失敗而分享唔到
 *  - 連結獨立一行，WhatsApp / SMS 會自動變成可撳
 */
export function buildShareText(fix: Fix, place: ResolvedPlace | null, now = Date.now()): string {
  const headline = placeHeadline(place);
  const lines = [headline ? `📍 我而家喺：${headline}` : '📍 我而家喺呢度：'];
  if (place?.address) lines.push(`地址：${place.address}`);
  if (place?.landmarks.length) lines.push(`附近：${place.landmarks.map(l => l.name).join('、')}`);
  const acc = Number.isFinite(fix.accuracy) ? `（誤差約 ${Math.round(fix.accuracy)} 米）` : '';
  lines.push(`時間：${hhmm(now)}${acc}`);
  lines.push('', `Google 地圖：${googleMapsUrl(fix.lat, fix.lng)}`);
  lines.push(`地圖（i-here）：${appViewUrl(fix.lat, fix.lng, headline ?? undefined)}`);
  return lines.join('\n');
}

export function whatsappUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

/** iOS 用 `sms:&body=`，Android 用 `sms:?body=`；`sms:?&body=` 兩邊都接受 */
export function smsUrl(text: string): string {
  return `sms:?&body=${encodeURIComponent(text)}`;
}

/** 解析 ?at=lat,lng&n=label（收件人打開分享連結） */
export function parseSharedLocation(search: string): { lat: number; lng: number; label?: string } | null {
  const p = new URLSearchParams(search);
  const at = p.get('at');
  if (!at) return null;
  const [lat, lng] = at.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng, label: p.get('n') ?? undefined };
}
