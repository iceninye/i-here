import { describe, expect, it } from 'vitest';
import { appViewUrl, buildShareText, parseSharedLocation } from './shareText';

const fix = { lat: 22.40801, lng: 113.97312, accuracy: 12.4, timestamp: 0 };

describe('buildShareText', () => {
  it('puts the headline first and includes address, landmarks and both links', () => {
    const text = buildShareText(fix, {
      name: '興輝樓', proximity: 'near', distanceM: 40, address: '新界屯門區大興邨興輝樓',
      landmarks: [{ name: '大興體育館', x: 0, y: 0, distanceM: 90 }],
    }, new Date(2026, 0, 1, 9, 5).getTime());
    const lines = text.split('\n');
    expect(lines[0]).toBe('📍 我而家喺：興輝樓附近');
    expect(text).toContain('地址：新界屯門區大興邨興輝樓');
    expect(text).toContain('附近：大興體育館');
    expect(text).toContain('時間：09:05（誤差約 12 米）');
    expect(text).toContain('https://www.google.com/maps/search/?api=1&query=22.408010,113.973120');
    expect(text).toMatch(/at=22\.408010%2C113\.973120/);
  });
  it('still shares coordinates when no place could be resolved', () => {
    const text = buildShareText(fix, null);
    expect(text.split('\n')[0]).toBe('📍 我而家喺呢度：');
    expect(text).toContain('google.com/maps');
  });
});

describe('shared link round trip', () => {
  it('parses what appViewUrl produces', () => {
    const u = new URL(appViewUrl(22.3, 114.17, '興輝樓附近', 'https://iceninye.github.io/i-here/?at=1,1#x'));
    expect(u.pathname).toBe('/i-here/');
    expect(parseSharedLocation(u.search)).toEqual({ lat: 22.3, lng: 114.17, label: '興輝樓附近' });
  });
  it('rejects garbage', () => {
    expect(parseSharedLocation('?at=abc')).toBeNull();
    expect(parseSharedLocation('')).toBeNull();
  });
});
