import { describe, expect, it, vi } from 'vitest';
import { GeoError, acquireBestFix, haversineM, isInHongKong } from './geo';

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

describe('acquireBestFix does not blend fixes (real cold start at Kam Sheung Road station exit D)', () => {
  // 實測紀錄：頭 9 個 fix（±16 → ±4.3 m）。之後 60 秒穩定喺 22.4341455, 114.0637469（±2.5 m）。
  const rows: [number, number, number][] = [
    [22.4340508, 114.0635697, 16.0], [22.4340289, 114.0635782, 16.4], [22.4340446, 114.0635610, 14.7],
    [22.4341482, 114.0635971, 10.3], [22.4341832, 114.0636196, 9.1], [22.4342159, 114.0636328, 9.5],
    [22.4342253, 114.0636405, 10.5], [22.4342491, 114.0636536, 9.4], [22.4341571, 114.0637333, 4.3],
  ];
  const settled = { lat: 22.4341455, lng: 114.0637469 };

  it('resolves the single most accurate fix when the window ends, with its own accuracy (no fused ±2.9 m)', async () => {
    vi.useFakeTimers();
    const g = fakeGeo();
    const p = acquireBestFix({ geolocation: g.geo, windowMs: 10000, goodAccuracyM: 0 }); // 0：唔提早結束，睇成個窗
    rows.forEach(([la, lo, ac]) => g.pos(la, lo, ac));
    vi.advanceTimersByTime(10000);
    const fix = await p;
    expect([fix.lat, fix.lng, fix.accuracy]).toEqual([22.4341571, 114.0637333, 4.3]);
    expect(haversineM(fix.lat, fix.lng, settled.lat, settled.lng)).toBeLessThan(2.5); // 實際只差 ~1.9 m
    vi.useRealTimers();
  });

  it('with the default 30 m threshold it stops at the first fix and returns exactly that fix', async () => {
    const g = fakeGeo();
    const p = acquireBestFix({ geolocation: g.geo, windowMs: 10000 });
    rows.forEach(([la, lo, ac]) => g.pos(la, lo, ac));
    const fix = await p;
    expect([fix.lat, fix.lng, fix.accuracy]).toEqual([22.4340508, 114.0635697, 16.0]);
  });
});
