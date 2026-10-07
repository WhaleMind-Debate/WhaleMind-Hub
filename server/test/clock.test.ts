/**
 * 时钟基准与同步用例
 *
 * 覆盖：样本挑选（最小 RTT 优先 / 广播兜底）、样本过期与窗口、时钟跳变识别、
 * 单调时钟对系统时钟跳变的免疫、NTP 报文的构造与解析。
 */
import { describe, expect, it } from 'vitest';
import {
  CLOCK_SAMPLE_LIMIT,
  isClockJump,
  pickBestClockOffset,
  pruneClockSamples,
  type ClockSample,
} from '@debate/shared';
import { createMonotonicClock } from '../src/game/clock.js';
import { buildNtpRequest, parseNtpResponse } from '../src/time/ntp.js';

const sample = (offset: number, rtt: number | null, at: number): ClockSample => ({ offset, rtt, at });

describe('时钟样本挑选', () => {
  it('往返样本中取 RTT 最小者：消除单程延迟造成的系统性偏差', () => {
    // 真实偏移 100ms；三次往返的 RTT 不同，延迟越大估计越偏
    const samples = [
      sample(100, 200, 1_000), // 高延迟样本把偏移估歪了
      sample(100, 4, 1_000), // 最小 RTT，最可信
      sample(100, 60, 1_000),
    ];
    expect(pickBestClockOffset(samples)).toBe(100);
  });

  it('没有往返样本时退化为中位数（广播兜底）', () => {
    const samples = [sample(-6, null, 1), sample(-2, null, 1), sample(-2, null, 1), sample(-1, null, 1)];
    expect(pickBestClockOffset(samples)).toBe(-2);
  });

  it('有往返样本时完全不采信广播样本', () => {
    const samples = [sample(-50, null, 1), sample(-9, null, 1), sample(7, 12, 1)];
    expect(pickBestClockOffset(samples)).toBe(7);
  });

  it('空样本返回 null，调用方应保持上一次偏移', () => {
    expect(pickBestClockOffset([])).toBeNull();
  });

  it('过期样本被丢弃，窗口长度受限', () => {
    const now = 100_000;
    const samples = [sample(1, 5, now - 120_000), sample(2, 5, now - 1_000)];
    expect(pruneClockSamples(samples, now).map((s) => s.offset)).toEqual([2]);
    const many = Array.from({ length: CLOCK_SAMPLE_LIMIT + 8 }, (_, i) => sample(i, 5, now));
    expect(pruneClockSamples(many, now)).toHaveLength(CLOCK_SAMPLE_LIMIT);
  });

  it('识别时钟跳变，忽略正常抖动', () => {
    expect(isClockJump(null, 5_000)).toBe(false); // 首次采样不算跳变
    expect(isClockJump(0, 300)).toBe(false); // 正常抖动
    expect(isClockJump(0, 5_000)).toBe(true); // 设备时钟被改了
  });
});

describe('单调时钟', () => {
  function makeClock() {
    let wall = 1_000_000;
    let mono = 0;
    const clock = createMonotonicClock({ wallNow: () => wall, monotonicNow: () => mono });
    return {
      clock,
      advance(ms: number) {
        wall += ms;
        mono += ms;
      },
      /** 模拟系统时钟被外部调整（NTP 步进 / 用户手改），单调源不受影响 */
      stepSystemClock(ms: number) {
        wall += ms;
      },
    };
  }

  it('正常推进时与系统墙钟一致', () => {
    const t = makeClock();
    t.advance(5_000);
    expect(t.clock.now()).toBe(1_005_000);
    expect(t.clock.systemDrift()).toBe(0);
  });

  it('系统时钟被向前跳变时，权威时刻不受影响（进行中的倒计时不会凭空少时间）', () => {
    const t = makeClock();
    t.advance(5_000);
    t.stepSystemClock(60_000); // 系统时钟凭空前进 60 秒
    expect(t.clock.now()).toBe(1_005_000); // 与跳变前完全一致
    expect(t.clock.systemDrift()).toBe(60_000); // 但漂移被如实报告
  });

  it('系统时钟被向后跳变时同样不受影响', () => {
    const t = makeClock();
    t.advance(5_000);
    t.stepSystemClock(-30_000);
    expect(t.clock.now()).toBe(1_005_000);
    expect(t.clock.systemDrift()).toBe(-30_000);
  });

  it('权威时刻始终是整数毫秒（落库列是 STRICT INTEGER，小数会被 SQLite 拒绝）', () => {
    let wall = 1_000_000;
    let mono = 0.37; // 单调源带小数部分
    const clock = createMonotonicClock({ wallNow: () => wall, monotonicNow: () => mono });
    for (let i = 0; i < 5; i++) {
      expect(Number.isInteger(clock.now())).toBe(true);
      mono += 0.913;
      wall += 1;
    }
    clock.shift(-12.7); // 小数校时也不得引入小数读数
    expect(Number.isInteger(clock.now())).toBe(true);
  });

  it('NTP 校时通过 shift 平移对外读数，且只在无计时时由调用方触发', () => {
    const t = makeClock();
    t.advance(1_000);
    t.clock.shift(-250);
    expect(t.clock.now()).toBe(1_000_750);
    t.clock.shift(250);
    expect(t.clock.now()).toBe(1_001_000);
    expect(t.clock.stats().shiftMs).toBe(0);
  });
});

describe('SNTP 报文', () => {
  it('请求包为 48 字节，版本 3、模式 3（客户端）', () => {
    const req = buildNtpRequest();
    expect(req).toHaveLength(48);
    expect(req[0]).toBe(0b0001_1011);
  });

  it('解析响应中的 transmit 时间戳与 stratum', () => {
    const buf = Buffer.alloc(48);
    buf[1] = 2; // stratum
    const secondsSince1900 = 2_208_988_800 + 1_700_000_000; // 2023-11-14 前后的整秒
    buf.writeUInt32BE(secondsSince1900, 40);
    buf.writeUInt32BE(0x8000_0000, 44); // 0.5 秒
    const { serverTimeMs, stratum } = parseNtpResponse(buf);
    expect(stratum).toBe(2);
    expect(serverTimeMs).toBe(1_700_000_000_000 + 500);
  });

  it('响应过短时抛错', () => {
    expect(() => parseNtpResponse(Buffer.alloc(10))).toThrow();
  });
});
