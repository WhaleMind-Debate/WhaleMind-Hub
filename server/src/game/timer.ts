/**
 * 权威计时模块（服务端唯一计时权威）
 *
 * 核心法则：
 * - start/resume 时生成 targetEndTime = 服务端当前时刻 + 剩余毫秒；
 * - pause 时按 targetEndTime - now 固化 remainingMs；
 * - 任何“剩余时间”都从 targetEndTime 反推，绝不累加/递减数字。
 *
 * 本模块函数全部以显式 now 参数驱动，便于 vitest 注入假时钟。
 */
import type { TimerKind, TimerState } from '@debate/shared';

/** 创建一个未启动的计时器 */
export function createTimer(totalMs: number): TimerState {
  return {
    status: 'idle',
    totalMs,
    remainingMs: totalMs,
    targetEndTime: null,
    startedAt: null,
  };
}

/**
 * 启动（或恢复）计时器：
 * - countdown：targetEndTime = now + remainingMs，剩余时间一律由目标点反推；
 * - countUp：记录 startedAt = now，已耗时间由 now - startedAt 反推，永不到期。
 */
export function startTimer(timer: TimerState, now: number, kind: TimerKind): TimerState {
  return {
    ...timer,
    status: 'running',
    targetEndTime: kind === 'countdown' ? now + timer.remainingMs : null,
    startedAt: kind === 'countUp' ? now : null,
  };
}

/** 暂停：固化剩余时间，清空目标点 */
export function pauseTimer(timer: TimerState, now: number): TimerState {
  return {
    ...timer,
    status: 'paused',
    remainingMs: remainingOf(timer, now),
    targetEndTime: null,
    startedAt: null,
  };
}

/** 到期：剩余归零 */
export function expireTimer(timer: TimerState): TimerState {
  return { ...timer, status: 'expired', remainingMs: 0, targetEndTime: null, startedAt: null };
}

/**
 * 计算剩余毫秒（countdown 语义）：targetEndTime - now，下限 0。
 * countUp 语义下返回已耗毫秒（now - startedAt），由上层按 timerKind 解读。
 */
export function remainingOf(timer: TimerState, now: number): number {
  if (timer.status === 'running' && timer.targetEndTime != null) {
    return Math.max(0, timer.targetEndTime - now);
  }
  if (timer.status === 'running' && timer.startedAt != null) {
    return Math.max(0, now - timer.startedAt);
  }
  return timer.remainingMs;
}

/** countdown 是否已到点 */
export function isDue(timer: TimerState, now: number): boolean {
  return timer.status === 'running' && timer.targetEndTime != null && timer.targetEndTime <= now;
}
