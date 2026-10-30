import { describe, expect, it, vi } from 'vitest';
import { GeoError, acquireBestFix, isInHongKong } from './geo';

type Success = (p: GeolocationPosition) => void;
type Failure = (e: GeolocationPositionError) => void;

function fakeGeo() {
  let ok: Success = () => {};
  let fail: Failure = () => {};
  const clearWatch = vi.fn();
  const geo = {
    watchPosition: (s: Success, f: Failure) => { ok = s; fail = f; return 7; },
    clearWatch,
    getCurrentPosition: () => {},
  } as unknown as Geolocation;
  const pos = (lat: number, lng: number, accuracy: number) =>
    ok({ coords: { latitude: lat, longitude: lng, accuracy }, timestamp: 1 } as GeolocationPosition);
  return { geo, pos, fail: (code: number) => fail({ code, message: 'x' } as GeolocationPositionError), clearWatch };
}

describe('acquireBestFix', () => {
  it('keeps the most accurate fix and stops early once good enough', async () => {
    const g = fakeGeo();
    const seen: number[] = [];
    const p = acquireBestFix({ geolocation: g.geo, windowMs: 10000, onFix: f => seen.push(f.accuracy) });
    g.pos(22.3, 114.1, 800);
    g.pos(22.3, 114.1, 900); // worse, ignored
    g.pos(22.31, 114.11, 20); // good -> finish
    const fix = await p;
    expect(fix.accuracy).toBe(20);
    expect(seen).toEqual([800, 20]);
    expect(g.clearWatch).toHaveBeenCalledWith(7);
  });

  it('resolves the best fix when the window ends', async () => {
    vi.useFakeTimers();
    const g = fakeGeo();
    const p = acquireBestFix({ geolocation: g.geo, windowMs: 1000 });
    g.pos(22.3, 114.1, 300);
    g.fail(3); // timeout after a fix: keep waiting
    vi.advanceTimersByTime(1000);
    expect((await p).accuracy).toBe(300);
    vi.useRealTimers();
  });

  it('rejects with denied when permission is refused', async () => {
    const g = fakeGeo();
    const p = acquireBestFix({ geolocation: g.geo });
    g.fail(1);
    await expect(p).rejects.toMatchObject({ code: 'denied' });
    await expect(p).rejects.toBeInstanceOf(GeoError);
  });

  it('ignores (0,0) junk fixes', async () => {
    vi.useFakeTimers();
    const g = fakeGeo();
    const p = acquireBestFix({ geolocation: g.geo, windowMs: 500 });
    g.pos(0, 0, 5);
    vi.advanceTimersByTime(500);
    await expect(p).rejects.toMatchObject({ code: 'timeout' });
    vi.useRealTimers();
  });
});

describe('isInHongKong', () => {
  it('accepts HK and rejects Shenzhen / Macau', () => {
    expect(isInHongKong(22.2988, 114.1722)).toBe(true); // 尖沙咀
    expect(isInHongKong(22.2, 113.9)).toBe(true); // 大嶼山南
    expect(isInHongKong(22.62, 114.06)).toBe(false); // 深圳
    expect(isInHongKong(22.19, 113.54)).toBe(false); // 澳門
  });
});
