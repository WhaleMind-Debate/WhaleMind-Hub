/**
 * 最小 SNTP 客户端（UDP/123）+ 校时调度
 *
 * 定位说明（重要）：
 * - 浏览器端无法直连 NTP（没有 UDP socket），客户端只能对我们的服务端做往返校时；
 * - NTP 的作用不是“让倒计时更准”——倒计时是相对量，两端同源，绝对时钟差多少都不影响；
 * - NTP 的真实价值是：日志/导出的时间戳与现实一致，以及多实例部署时有共同基准；
 * - 真实风险在反方向：若在计时过程中平移时钟，targetEndTime 与 now() 的差值会瞬间跳变。
 *   因此本模块只在“没有任何计时器在运行”时应用校正，否则挂起等待下一次安全检查。
 *
 * 报文与算法遵循 RFC 4330（SNTP v4 的兼容子集）：
 *   offset = serverTransmit - (t1 + t4) / 2
 *   rtt    = t4 - t1
 * 多台服务器并行查询，取 RTT 最小的一条（NTP best-sample 策略）。
 */
import { createSocket } from 'node:dgram';
import type { MonotonicClock } from '../game/clock.js';

const NTP_EPOCH_OFFSET_SEC = 2_208_988_800; // 1900-01-01 到 1970-01-01 的秒数
const NTP_PACKET_BYTES = 48;
const NTP_PORT = 123;
const NTP_VERSION = 3;
const NTP_MODE_CLIENT = 3;
const NTP_TRANSMIT_OFFSET = 40;
const FRACTION_SCALE = 0x1_0000_0000;

export interface NtpSample {
  server: string;
  /** 服务端时间 - 本机中点时刻（毫秒），即应施加到本机时钟上的校正量 */
  offsetMs: number;
  rttMs: number;
  stratum: number;
  serverTimeMs: number;
}

/** 构造 SNTP 客户端请求包：LI=0, VN=3, Mode=3(client)，其余字段留空即可 */
export function buildNtpRequest(): Buffer {
  const buf = Buffer.alloc(NTP_PACKET_BYTES);
  buf[0] = (NTP_VERSION << 3) | NTP_MODE_CLIENT;
  return buf;
}

/** 解析 SNTP 响应包（纯函数，便于单测） */
export function parseNtpResponse(msg: Buffer): { serverTimeMs: number; stratum: number } {
  if (msg.length < NTP_PACKET_BYTES) {
    throw new Error(`SNTP 响应过短：${msg.length} 字节（期望 ${NTP_PACKET_BYTES}）`);
  }
  const stratum = msg[1];
  const seconds = msg.readUInt32BE(NTP_TRANSMIT_OFFSET);
  const fraction = msg.readUInt32BE(NTP_TRANSMIT_OFFSET + 4);
  const serverTimeMs = (seconds - NTP_EPOCH_OFFSET_SEC) * 1000 + Math.round((fraction / FRACTION_SCALE) * 1000);
  return { serverTimeMs, stratum };
}

/** 向单台服务器发起一次 SNTP 查询 */
export function queryNtp(host: string, timeoutMs = 3000): Promise<NtpSample> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    const packet = buildNtpRequest();
    const t1 = Date.now();
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* 已关闭 */
      }
      fn();
    };

    const timer = setTimeout(() => finish(() => reject(new Error(`NTP 超时：${host}`))), timeoutMs);

    socket.on('error', (err) => finish(() => reject(err)));
    socket.on('message', (msg) => {
      const t4 = Date.now();
      finish(() => {
        try {
          const { serverTimeMs, stratum } = parseNtpResponse(msg);
          resolve({
            server: host,
            offsetMs: serverTimeMs - (t1 + t4) / 2,
            rttMs: t4 - t1,
            stratum,
            serverTimeMs,
          });
        } catch (err) {
          reject(err);
        }
      });
    });

    socket.send(packet, 0, packet.length, NTP_PORT, host, (err) => {
      if (err) finish(() => reject(err));
    });
  });
}

/** 并行查询多台服务器，返回 RTT 最小的样本 */
export async function queryNtpBest(servers: string[], timeoutMs = 3000): Promise<NtpSample | null> {
  const results = await Promise.allSettled(servers.map((host) => queryNtp(host, timeoutMs)));
  const ok = results
    .filter((r): r is PromiseFulfilledResult<NtpSample> => r.status === 'fulfilled')
    .map((r) => r.value);
  if (ok.length === 0) return null;
  return ok.reduce((best, s) => (s.rttMs < best.rttMs ? s : best));
}

export interface NtpStatus {
  enabled: boolean;
  servers: string[];
  /** 上次成功同步的时刻（权威时钟读数） */
  lastSyncAt: number | null;
  lastServer: string | null;
  lastOffsetMs: number | null;
  lastRttMs: number | null;
  /** 已应用的校正次数 */
  appliedCount: number;
  /** 已测出但因计时进行中而挂起的校正量（毫秒），null 表示无挂起 */
  pendingMs: number | null;
}

export interface NtpSyncOptions {
  clock: Pick<MonotonicClock, 'now' | 'shift'>;
  servers: string[];
  /** 复测周期，默认 6 小时 */
  intervalMs?: number;
  /** 单次查询超时，默认 3 秒 */
  timeoutMs?: number;
  /** 是否允许此刻平移时钟：仅在没有任何计时器运行时返回 true */
  canAdjust: () => boolean;
  /** 检查挂起校正的周期，默认 30 秒 */
  pendingCheckMs?: number;
  onAdjust?: (deltaMs: number, sample: NtpSample) => void;
  onError?: (message: string) => void;
}

export interface NtpSync {
  /** 立即同步一次（不等定时器） */
  syncOnce(): Promise<NtpStatus>;
  start(): void;
  stop(): void;
  status(): NtpStatus;
}

export function createNtpSync(opts: NtpSyncOptions): NtpSync {
  const intervalMs = opts.intervalMs ?? 6 * 60 * 60 * 1000;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const pendingCheckMs = opts.pendingCheckMs ?? 30_000;

  let lastSyncAt: number | null = null;
  let lastServer: string | null = null;
  let lastOffsetMs: number | null = null;
  let lastRttMs: number | null = null;
  let appliedCount = 0;
  let pendingMs: number | null = null;
  let syncTimer: NodeJS.Timeout | null = null;
  let pendingTimer: NodeJS.Timeout | null = null;
  let stopped = true;

  const status = (): NtpStatus => ({
    enabled: true,
    servers: opts.servers,
    lastSyncAt,
    lastServer,
    lastOffsetMs,
    lastRttMs,
    appliedCount,
    pendingMs,
  });

  /** 在安全检查通过时应用挂起的校正 */
  const flushPending = (): void => {
    if (pendingMs == null || !opts.canAdjust()) return;
    const delta = pendingMs;
    pendingMs = null;
    opts.clock.shift(delta);
    appliedCount += 1;
  };

  const syncOnce = async (): Promise<NtpStatus> => {
    try {
      const best = await queryNtpBest(opts.servers, timeoutMs);
      if (!best) {
        opts.onError?.('所有 NTP 服务器均无响应');
        return status();
      }
      lastSyncAt = opts.clock.now();
      lastServer = best.server;
      lastOffsetMs = best.offsetMs;
      lastRttMs = best.rttMs;
      if (opts.canAdjust()) {
        pendingMs = null;
        opts.clock.shift(best.offsetMs);
        appliedCount += 1;
        opts.onAdjust?.(best.offsetMs, best);
      } else {
        // 计时进行中：挂起，等比赛停下来再对齐，绝不打断倒计时
        pendingMs = best.offsetMs;
        opts.onError?.(`检测到 ${best.offsetMs.toFixed(1)}ms 时钟偏差，但当前正在计时，已挂起待安全时刻应用`);
      }
    } catch (err) {
      opts.onError?.(`NTP 同步失败：${err instanceof Error ? err.message : String(err)}`);
    }
    return status();
  };

  return {
    syncOnce,
    status,
    start(): void {
      if (!stopped) return;
      stopped = false;
      void syncOnce();
      syncTimer = setInterval(() => void syncOnce(), intervalMs);
      pendingTimer = setInterval(flushPending, pendingCheckMs);
      // 定时器不应阻止进程退出
      syncTimer.unref?.();
      pendingTimer.unref?.();
    },
    stop(): void {
      stopped = true;
      if (syncTimer) clearInterval(syncTimer);
      if (pendingTimer) clearInterval(pendingTimer);
      syncTimer = null;
      pendingTimer = null;
    },
  };
}
