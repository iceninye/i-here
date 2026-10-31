/**
 * Inline SVG 圖示集。
 *
 * 點解唔用 emoji：emoji 喺 iOS / Android / 桌面渲染唔同（顏色、粗幼、對齊都唔一致），
 * 讀屏器亦會讀出「向上箭號」呢類無意義嘅描述。SVG 跟 currentColor，深色模式自動跟到。
 */
import type { ReactElement } from 'react';

const PATHS = {
  share: 'M12 16V4 M7 9l5-5 5 5 M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  refresh: 'M20 12a8 8 0 1 1-2.6-5.9 M20 4v5h-5',
  cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z M4 7.5l8 4.5 8-4.5 M12 12v9',
  layers: 'M12 3l9 5-9 5-9-5 9-5z M3 13l9 5 9-5',
  pin: 'M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  navigate: 'M3 11l18-8-8 18-2-8-8-2z',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z',
  mail: 'M3 6h18v12H3z M3.5 7l8.5 6 8.5-6',
  copy: 'M9 9h11v11H9z M5 15V4h11',
  signal: 'M4 20v-4 M9 20v-8 M14 20v-12 M19 20V4',
  alert: 'M12 4l9 16H3l9-16z M12 10v4.5 M12 17.6v.4',
  target: 'M12 3v3 M12 18v3 M3 12h3 M18 12h3 M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12z',
  lock: 'M6 11h12v9H6z M9 11V8a3 3 0 0 1 6 0v3',
  check: 'M5 13l4 4L19 7',
} as const;

export type IconName = keyof typeof PATHS;

/** 圖示一律 aria-hidden：文字已經喺按鈕 / 標籤入面，讀屏器唔需要重複讀 */
export function Icon({ name, className }: { name: IconName; className?: string }): ReactElement {
  return (
    <svg className={`icon ${className ?? ''}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
