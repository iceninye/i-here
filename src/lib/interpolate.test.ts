import { describe, expect, it } from 'vitest';
import { extrapolateFix } from './interpolate';
import { haversineM } from './geo';
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

/**
 * Replay 式檢查（§4.8）：用合成軌跡逐幀外推，確認
 *  - 相鄰幀位移 ≤ 1.2 × 速度 × Δt（唔會「飛」得太遠）；
 *  - 外推上限 1.5 s（Δt 再大都唔會更遠）；
 *  - 靜止 / 訊號未知嗰啲幀完全唔郁。
 * 真實步行 / 車行 / 隧道紀錄（§4.0）要真機先錄到，錄到之後用同一個 helper 跑。
 */
describe('extrapolateFix replay bounds', () => {
  const moveM = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
    haversineM(a.lat, a.lng, b.lat, b.lng);

  /** 逐幀（1 Hz）行一段直路，每幀之間用 sub-step 外推 */
  function replay(speed: number, heading: number, frames = 20) {
    let pos = { lat: 22.3193, lng: 114.1694 };
    for (let i = 0; i < frames; i++) {
      const fix: Fix = { ...pos, accuracy: 8, timestamp: i * 1000, speed, heading };
      for (const dt of [0.25, 0.5, 0.75, 1]) {
        const p = extrapolateFix(fix, dt);
        expect(p).not.toBeNull();
        expect(moveM(pos, p!)).toBeLessThanOrEqual(1.2 * speed * dt + 1e-6);
      }
      // 超過 1.5 s 都被 clamp：唔會比 1.5 s 更遠
      const over = extrapolateFix(fix, 5);
      const capped = extrapolateFix(fix, 1.5);
      expect(moveM(pos, over!)).toBeCloseTo(moveM(pos, capped!), 6);
      // 下一個真 fix：直行 1 秒
      const next = extrapolateFix(fix, 1)!;
      pos = { lat: next.lat, lng: next.lng };
    }
    return pos;
  }

  it('walking (1.4 m/s) stays within bounds frame after frame', () => {
    const end = replay(1.4, 90);
    // 20 幀 × 1.4 m/s ≈ 28 m 向東
    expect(moveM({ lat: 22.3193, lng: 114.1694 }, end)).toBeCloseTo(28, 0);
  });

  it('driving (14 m/s) stays within bounds frame after frame', () => {
    const end = replay(14, 0);
    expect(moveM({ lat: 22.3193, lng: 114.1694 }, end)).toBeCloseTo(280, 0);
  });

  it('does not move a still frame (speed unknown) however long we wait', () => {
    const fix: Fix = { lat: 22.3193, lng: 114.1694, accuracy: 8, timestamp: 0, heading: 90 };
    expect(extrapolateFix(fix, 1)).toBeNull();
    expect(extrapolateFix(fix, 10)).toBeNull();
  });
});
