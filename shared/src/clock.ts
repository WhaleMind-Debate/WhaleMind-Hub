/**
 * 时钟样本的纯逻辑（前后端共享）
 *
 * 权威时间法则的客户端实现依赖一个估计量：clockOffset ≈ 服务端时间 - 本机时间。
 * 本模块只负责“从样本里挑出最可信的偏移”，不含任何 IO，便于单元测试。
 *
 * 为什么不能直接用广播里的 serverTime - Date.now()：
 * 广播是单向的，从服务端打时间戳到客户端收到之间隔了一个单程网络延迟，
 * 于是样本 = 真实偏移 - 单程延迟，估计值系统性偏小（各端会显示比真实更多的剩余时间）。
 * 正确做法是往返测量：offset = serverTime - (t0 + t1) / 2，
 * 并优先采信往返时延（RTT）最小的那条样本（NTP best-sample 策略）。
 */

/** 一次时钟采样 */
export interface ClockSample {
  /** 服务端时间 - 本机时间（毫秒） */
  offset: number;
  /** 往返时延（毫秒）；单向的广播兜底样本为 null */
  rtt: number | null;
  /** 采样时刻（本机 Date.now()） */
  at: number;
}

/** 样本最大存活时间：超过即视为不再可信（设备时钟可能已被 NTP 校正） */
export const CLOCK_SAMPLE_MAX_AGE_MS = 60_000;
/** 样本窗口上限 */
export const CLOCK_SAMPLE_LIMIT = 16;
/** 偏移突变阈值：超过则认为本机或服务端时钟发生了跳变，需要丢弃旧样本 */
export const CLOCK_JUMP_THRESHOLD_MS = 1_000;

/** 丢弃过期样本并限制窗口长度（保留最新的若干条） */
export function pruneClockSamples(
  samples: ClockSample[],
  now: number,
  maxAgeMs: number = CLOCK_SAMPLE_MAX_AGE_MS,
): ClockSample[] {
  return samples.filter((s) => now - s.at <= maxAgeMs).slice(-CLOCK_SAMPLE_LIMIT);
}

/**
 * 挑选当前最佳时钟偏移：
 * 1. 有往返样本时取 RTT 最小者（可消除单程延迟造成的系统性偏差）；
 * 2. 没有任何往返样本时，退化为全部样本的中位数（广播兜底，精度差但优于 0）。
 * 返回 null 表示无可用样本，调用方应保持上一次的偏移。
 */
export function pickBestClockOffset(samples: ClockSample[]): number | null {
  const measured = samples.filter((s) => s.rtt != null);
  if (measured.length > 0) {
    return measured.reduce((best, s) => ((s.rtt as number) < (best.rtt as number) ? s : best)).offset;
  }
  if (samples.length === 0) return null;
  const sorted = samples.map((s) => s.offset).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** 偏移是否发生了跳变（用于识别设备时钟被调整） */
export function isClockJump(previous: number | null, next: number): boolean {
  return previous != null && Math.abs(next - previous) > CLOCK_JUMP_THRESHOLD_MS;
}
