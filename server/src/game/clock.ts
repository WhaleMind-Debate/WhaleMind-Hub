/**
 * 单调墙钟（服务端内部时间基准）
 *
 * 为什么不直接用 Date.now()：
 * - 系统时钟会被 NTP 校时、用户手动修改、虚拟机快照回滚而“跳变”；
 * - targetEndTime 是绝对墙钟戳，系统时钟一跳，所有端的倒计时会瞬间跳变
 *   （时钟前跳 2 秒 = 全场凭空少 2 秒）；
 * - 因此服务端内部统一使用本模块的时钟：它由单调计时源（process.hrtime）推导，
 *   只前进、不跳变，Date.now() 仅用于与外界对齐与诊断。
 *
 * 与 NTP 的分工：NTP 校时只平移本时钟的“对外读数”（shift），
 * 且必须由调用方保证在没有任何计时器运行时执行（见 time/ntp.ts 的 canAdjust）。
 */
export interface MonotonicClock {
  /**
   * 当前权威时刻（毫秒，**整数**）：单调推导 + 已应用的校时平移。
   * 必须取整：底层单调源是纳秒精度，而落库的 created_at/updated_at 是 STRICT 表的
   * INTEGER 列，SQLite 会直接拒绝 REAL（"cannot store REAL value in INTEGER column"）。
   */
  now(): number;
  /** 系统墙钟读数，仅用于诊断与对外对齐 */
  systemNow(): number;
  /** 系统时钟相对单调基准的漂移（毫秒）；正数表示系统时钟被向前调整过 */
  systemDrift(): number;
  /** 平移对外读数（NTP 校时用）。调用方必须在无计时器运行时调用 */
  shift(deltaMs: number): void;
  stats(): { startedAt: number; shiftMs: number; driftMs: number; uptimeMs: number };
}

export interface MonotonicClockOptions {
  /** 注入系统墙钟（测试用） */
  wallNow?: () => number;
  /** 注入单调计时源，单位毫秒（测试用） */
  monotonicNow?: () => number;
}

const defaultMonotonicNow = (): number => Number(process.hrtime.bigint()) / 1e6;

export function createMonotonicClock(opts: MonotonicClockOptions = {}): MonotonicClock {
  const wallNow = opts.wallNow ?? (() => Date.now());
  const monotonicNow = opts.monotonicNow ?? defaultMonotonicNow;
  const monoBase = monotonicNow();
  const wallBase = wallNow();
  let shiftMs = 0;

  const elapsed = (): number => monotonicNow() - monoBase;
  const monoWall = (): number => wallBase + elapsed();

  return {
    now: () => Math.floor(monoWall() + shiftMs),
    systemNow: wallNow,
    systemDrift: () => wallNow() - monoWall(),
    shift: (deltaMs: number) => {
      shiftMs += deltaMs;
    },
    stats: () => ({
      startedAt: wallBase,
      shiftMs,
      driftMs: wallNow() - monoWall(),
      uptimeMs: elapsed(),
    }),
  };
}
