import { describe, expect, it } from 'vitest';
import { detectInAppBrowser, isIOS } from './inAppBrowser';

describe('detectInAppBrowser', () => {
  it('detects common in-app browsers', () => {
    expect(detectInAppBrowser('Mozilla/5.0 (iPhone) AppleWebKit/605 Mobile/15E148 [FBAN/FBIOS;FBAV/450.0]')?.name).toBe('Facebook');
    expect(detectInAppBrowser('Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537 Instagram 300.0')?.name).toBe('Instagram');
    expect(detectInAppBrowser('Mozilla/5.0 (Linux; Android 14) MicroMessenger/8.0')?.name).toBe('微信');
    expect(detectInAppBrowser('Mozilla/5.0 (iPhone) Mobile/15E148 Line/13.0.0')?.name).toBe('Line');
  });
  it('does not flag normal Safari / Chrome', () => {
    expect(detectInAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBeNull();
    expect(detectInAppBrowser('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36')).toBeNull();
  });
  it('detects iOS', () => {
    expect(isIOS('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(true);
    expect(isIOS('Mozilla/5.0 (Linux; Android 14)')).toBe(false);
  });
});
