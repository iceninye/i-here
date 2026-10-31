/**
 * 運動狀態機 —— 由一連串 fix 判斷用戶係靜止 / 步行 / 快速移動。
 *
 * 用途：控制地名查詢策略、marker 插值、UI（見 PLAN.md §4.2）。
 *
 * 關鍵設計（PLAN §4.2 / §11）：
 *  - 速度來源：`fix.speed`（有就用）→ 否則 `derivedSpeed(prev, fix)` → 兩者都冇 = **未知，保持上一個狀態**。
 *    `speed == null` 係「未知」，**唔係靜止**（唔可以當 0）。
 *  - 進出用唔同門檻（hysteresis）+ 連續 sample 計數，避免喺邊界抖動。
 *  - 門檻係初始建議值，**要等 §4.0 真實移動紀錄 replay 先至調準**。
 */

import { derivedSpeed, type Fix } from './geo';

export type MotionState = 'still' | 'walking' | 'fast';

export interface MotionThresholds {
  /** still → walking：速度 ≥ 呢個值（m/s） */
  stillToWalking: number;
  /** walking → still：速度 < 呢個值，並持續 stillHoldMs */
  walkingToStill: number;
  /** walking → fast：速度 ≥ 呢個值（m/s） */
  walkingToFast: number;
  /** fast → walking：速度 < 呢個值（m/s） */
  fastToWalking: number;
  /** still → walking 要連續幾多個 sample 達標 */
  upToWalkingSamples: number;
  /** walking → fast 要連續幾多個 sample 達標 */
  upToFastSamples: number;
  /** fast → walking 要連續幾多個 sample 達標 */
  downToWalkingSamples: number;
  /** walking → still：低速要持續幾多毫秒 */
  stillHoldMs: number;
}

/** PLAN §4.2 初始建議門檻（待真實紀錄調） */
export const MOTION_THRESHOLDS: MotionThresholds = {
  stillToWalking: 0.8,
  walkingToStill: 0.4,
  walkingToFast: 5.5,   // ≈20 km/h
  fastToWalking: 3.5,   // ≈13 km/h
  upToWalkingSamples: 2,
  upToFastSamples: 3,
  downToWalkingSamples: 3,
  stillHoldMs: 5000,
};

export interface MotionTracker {
  /** 餵一個 fix，回目前狀態（速度未知時保持原狀態） */
  update(fix: Fix): MotionState;
  readonly state: MotionState;
  /** 目前用緊嘅速度來源值（undefined = 未知），除錯 / 測試用 */
  readonly lastSpeed: number | undefined;
}

export function createMotionTracker(thresholds: Partial<MotionThresholds> = {}): MotionTracker {
  const T: MotionThresholds = { ...MOTION_THRESHOLDS, ...thresholds };
  let state: MotionState = 'still';
  let prev: Fix | null = null;
  let lastSpeed: number | undefined;

  // 連續計數器
  let upWalk = 0;
  let upFast = 0;
  let downWalk = 0;
  // walking → still：首次低速嘅 fix 時間戳
  let lowSince: number | null = null;

  const reset = () => { upWalk = 0; upFast = 0; downWalk = 0; lowSince = null; };

  function speedOf(f: Fix): number | undefined {
    if (f.speed !== undefined) return f.speed;
    return prev ? derivedSpeed(prev, f) : undefined;
  }

  function update(f: Fix): MotionState {
    const v = speedOf(f);
    lastSpeed = v;

    // 速度未知：保持原狀態，唔郁計數器（但記住 prev 供下次推算）
    if (v === undefined) {
      prev = f;
      return state;
    }

    switch (state) {
      case 'still':
        upWalk = v >= T.stillToWalking ? upWalk + 1 : 0;
        if (upWalk >= T.upToWalkingSamples) { state = 'walking'; reset(); }
        break;

      case 'walking':
        // 加速去 fast
        upFast = v >= T.walkingToFast ? upFast + 1 : 0;
        if (upFast >= T.upToFastSamples) { state = 'fast'; reset(); break; }
        // 慢返去 still（要持續一段時）
        if (v < T.walkingToStill) {
          if (lowSince === null) lowSince = f.timestamp;
          else if (f.timestamp - lowSince >= T.stillHoldMs) { state = 'still'; reset(); }
        } else {
          lowSince = null;
        }
        break;

      case 'fast':
        downWalk = v < T.fastToWalking ? downWalk + 1 : 0;
        if (downWalk >= T.downToWalkingSamples) { state = 'walking'; reset(); }
        break;
    }

    prev = f;
    return state;
  }

  return {
    update,
    get state() { return state; },
    get lastSpeed() { return lastSpeed; },
  };
}

/** 便捷：一次過跑晒一串 fix，回最終狀態（replay 測試 / fixtures 用） */
export function classifyTrack(fixes: Fix[], thresholds?: Partial<MotionThresholds>): MotionState[] {
  const t = createMotionTracker(thresholds);
  return fixes.map(f => t.update(f));
}
