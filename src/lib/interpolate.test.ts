import { describe, expect, it } from 'vitest';
import { extrapolateFix } from './interpolate';
import type { Fix } from './geo';

const base: Fix = { lat: 22.3193, lng: 114.1694, accuracy: 10, timestamp: 0 };

describe('extrapolateFix', () => {
  it('returns null when speed unknown', () => {
    expect(extrapolateFix({ ...base, heading: 0 }, 1)).toBeNull();
  });

  it('returns null when heading unknown', () => {
    expect(extrapolateFix({ ...base, speed: 5 }, 1)).toBeNull();
  });

  it('returns null when accuracy too poor', () => {
    expect(extrapolateFix({ ...base, speed: 5, heading: 0, accuracy: 31 }, 1)).toBeNull();
    expect(extrapolateFix({ ...base, speed: 5, heading: 0, accuracy: Infinity }, 1)).toBeNull();
  });

  it('returns null for non-positive dt', () => {
    expect(extrapolateFix({ ...base, speed: 5, heading: 0 }, 0)).toBeNull();
    expect(extrapolateFix({ ...base, speed: 5, heading: 0 }, -1)).toBeNull();
  });

  it('moves north when heading 0', () => {
    const p = extrapolateFix({ ...base, speed: 10, heading: 0 }, 1)!;
    expect(p).not.toBeNull();
    expect(p.lat).toBeGreaterThan(base.lat);
    expect(p.lng).toBeCloseTo(base.lng, 6);
    // 10 m north ≈ 10/111320 deg
    expect((p.lat - base.lat) * 111320).toBeCloseTo(10, 3);
  });

  it('moves east when heading 90', () => {
    const p = extrapolateFix({ ...base, speed: 10, heading: 90 }, 1)!;
    expect(p.lng).toBeGreaterThan(base.lng);
    expect(p.lat).toBeCloseTo(base.lat, 6);
  });

  it('caps extrapolation at maxSeconds (default 1.5)', () => {
    const capped = extrapolateFix({ ...base, speed: 10, heading: 0 }, 5)!;
    const at15 = extrapolateFix({ ...base, speed: 10, heading: 0 }, 1.5)!;
    expect(capped.lat).toBeCloseTo(at15.lat, 9);
  });

  it('respects custom maxSeconds', () => {
    const p = extrapolateFix({ ...base, speed: 10, heading: 0 }, 5, { maxSeconds: 2 })!;
    expect((p.lat - base.lat) * 111320).toBeCloseTo(20, 3);
  });

  it('respects custom maxAccuracyM', () => {
    expect(extrapolateFix({ ...base, speed: 5, heading: 0, accuracy: 40 }, 1, { maxAccuracyM: 50 })).not.toBeNull();
    expect(extrapolateFix({ ...base, speed: 5, heading: 0, accuracy: 40 }, 1, { maxAccuracyM: 30 })).toBeNull();
  });
});
