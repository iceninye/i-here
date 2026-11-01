import { describe, expect, it } from 'vitest';
import type { Fix } from './geo';
import { classifyTrack, createMotionTracker, MOTION_THRESHOLDS } from './motion';

// 1 度緯 ≈ 111195 m；用嚟整「移動咗 N 米」嘅座標
const M_PER_DEG_LAT = 111195;
const f = (speed: number | undefined, t: number, lat = 22.3, lng = 114.1, accuracy = 5): Fix =>
  ({ lat, lng, accuracy, timestamp: t, ...(speed === undefined ? {} : { speed }) });

describe('motion: still', () => {
  it('stays still when speed is 0', () => {
    expect(classifyTrack([f(0, 0), f(0, 1000), f(0, 2000)])).toEqual(['still', 'still', 'still']);
  });

  it('keeps the previous state when speed is unknown and there is no previous fix', () => {
    // 第一個 fix 冇 speed、冇 prev → derivedSpeed 計唔到 → 未知 → 保持 still
    expect(classifyTrack([f(undefined, 0)])[0]).toBe('still');
  });
});

describe('motion: walking', () => {
  it('needs 2 consecutive samples to leave still, and never reaches fast at walking speed', () => {
    const states = classifyTrack([f(1, 0), f(1, 1000), f(1, 2000), f(1, 3000)]);
    expect(states).toEqual(['still', 'walking', 'walking', 'walking']);
  });

  it('a single fast spike does not flip walking -> fast (needs 3 consecutive)', () => {
    const states = classifyTrack([f(1, 0), f(1, 1000), f(10, 2000), f(1, 3000), f(1, 4000)]);
    expect(states).toEqual(['still', 'walking', 'walking', 'walking', 'walking']);
  });

  it('returns to still only after low speed persists for stillHoldMs', () => {
    const states = classifyTrack([f(1, 0), f(1, 1000), f(0.2, 2000), f(0.2, 7000)]);
    expect(states).toEqual(['still', 'walking', 'walking', 'still']);
  });
});

describe('motion: fast', () => {
  it('escalates to fast after 3 consecutive high-speed samples, de-escalates after 3 slow ones', () => {
    const states = classifyTrack([
      f(1, 0), f(1, 1000),          // -> walking
      f(6, 2000), f(6, 3000), f(6, 4000), // 3 consecutive -> fast
      f(3, 5000), f(3, 6000), f(3, 7000), // 3 below fastToWalking -> walking
    ]);
    expect(states).toEqual([
      'still', 'walking',
      'walking', 'walking', 'fast',
      'fast', 'fast', 'walking',
    ]);
  });
});

describe('motion: derivedSpeed fallback (speed == null)', () => {
  it('uses position displacement when coords.speed is absent', () => {
    // 每秒向北 ~12 m（accuracy 5 m）→ derivedSpeed ~12 m/s → fast
    const step = 12 / M_PER_DEG_LAT;
    const fixes: Fix[] = [];
    for (let i = 0; i < 6; i++) fixes.push(f(undefined, i * 1000, 22.3 + step * i));
    const states = classifyTrack(fixes);
    expect(states.at(-1)).toBe('fast');
  });

  it('treats a stationary no-speed track as still (jitter under the noise floor)', () => {
    const fixes = [f(undefined, 0), f(undefined, 1000), f(undefined, 2000), f(undefined, 3000)];
    expect(classifyTrack(fixes)).toEqual(['still', 'still', 'still', 'still']);
  });
});

describe('motion: tracker API', () => {
  it('exposes the current state and last resolved speed', () => {
    const t = createMotionTracker();
    expect(t.state).toBe('still');
    t.update(f(1.2, 0));
    expect(t.lastSpeed).toBe(1.2);
    t.update(f(1.2, 1000));
    expect(t.state).toBe('walking');
  });

  it('accepts threshold overrides', () => {
    const t = createMotionTracker({ stillToWalking: 0.2, upToWalkingSamples: 1 });
    expect(t.update(f(0.3, 0))).toBe('walking');
  });

  it('ships the PLAN §4.2 initial thresholds', () => {
    expect(MOTION_THRESHOLDS).toMatchObject({
      stillToWalking: 0.8, walkingToStill: 0.4, walkingToFast: 5.5, fastToWalking: 3.5,
      upToWalkingSamples: 2, upToFastSamples: 3, downToWalkingSamples: 3, stillHoldMs: 5000,
    });
  });
});
