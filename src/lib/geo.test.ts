import { describe, expect, it, vi } from 'vitest';
import { GeoError, acquireBestFix, fuseFixes, isInHongKong, rejectOutliers, type Fix } from './geo';

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

const mkFix = (lat: number, lng: number, accuracy: number, timestamp = 1): Fix =>
  ({ lat, lng, accuracy, timestamp });

describe('fuseFixes', () => {
  it('returns null for empty input and the fix itself for a single sample', () => {
    expect(fuseFixes([])).toBeNull();
    const only = mkFix(22.3, 114.1, 40);
    expect(fuseFixes([only])).toBe(only);
  });

  it('ignores junk (non-finite / zero) accuracies', () => {
    expect(fuseFixes([mkFix(22.3, 114.1, 0), mkFix(22.3, 114.1, NaN)])).toBeNull();
  });

  it('weights toward the more accurate fix and tightens the radius', () => {
    const fused = fuseFixes([
      mkFix(22.300, 114.100, 100),
      mkFix(22.301, 114.100, 10),
    ])!;
    // 10m 準確嘅 fix 應該主導緯度
    expect(fused.lat).toBeCloseTo(22.301, 4);
    expect(fused.lng).toBeCloseTo(114.100, 6);
    // 融合精度好過最準嘅單獨 fix（10m）
    expect(fused.accuracy).toBeLessThan(10);
    expect(fused.accuracy).toBeGreaterThan(0);
  });

  it('takes the latest timestamp', () => {
    const fused = fuseFixes([
      mkFix(22.3, 114.1, 30, 100),
      mkFix(22.3, 114.1, 30, 500),
    ])!;
    expect(fused.timestamp).toBe(500);
  });
});

describe('rejectOutliers', () => {
  it('leaves fewer than 3 samples untouched', () => {
    const two = [mkFix(22.3, 114.1, 20), mkFix(22.9, 114.9, 20)];
    expect(rejectOutliers(two)).toBe(two);
  });

  it('drops a far, low-accuracy fix but keeps a tight cluster', () => {
    const a = mkFix(22.30000, 114.100, 15);
    const b = mkFix(22.30005, 114.100, 15); // ~5m away
    const far = mkFix(22.31000, 114.100, 200); // ~1.1km away
    const kept = rejectOutliers([a, b, far]);
    expect(kept).toHaveLength(2);
    expect(kept).toContain(a);
    expect(kept).toContain(b);
    expect(kept).not.toContain(far);
  });

  it('never rejects everything', () => {
    // 全部一模一樣嘅準確度 —— 冇離群，全部保留
    const same = [
      mkFix(22.3, 114.1, 50),
      mkFix(22.3, 114.1, 50),
      mkFix(22.3, 114.1, 50),
    ];
    expect(rejectOutliers(same)).toHaveLength(3);
  });
});

describe('acquireBestFix fusion', () => {
  it('resolves a fused fix tighter than any single sample when the window ends', async () => {
    vi.useFakeTimers();
    const g = fakeGeo();
    const p = acquireBestFix({ geolocation: g.geo, windowMs: 1000 });
    g.pos(22.300, 114.100, 40);
    g.pos(22.300, 114.100, 45);
    g.pos(22.300, 114.100, 50);
    vi.advanceTimersByTime(1000);
    const fix = await p;
    // 三個聚集嘅樣本融合後精度應好過最準嘅單獨 fix（40m）
    expect(fix.accuracy).toBeLessThan(40);
    expect(fix.accuracy).toBeGreaterThan(0);
    vi.useRealTimers();
  });
});
