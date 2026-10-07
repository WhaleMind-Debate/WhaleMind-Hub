/**
 * 比赛状态仓库（唯一状态收拢点，严禁在 View 组件内私有维护比赛状态）
 *
 * 本 store 是服务端 engine 状态的纯镜像：
 * - 只被动接收 game:state 快照，不做任何本地状态推导；
 * - 时钟：各端倒计时一律用 targetEndTime - (Date.now() + clockOffset) 反推。
 *   裸用 Date.now() 会让系统时钟不准的设备整体错位（廉价平板可能偏几分钟），
 *   所以 clockOffset 必须校正；其估计见下方 recordClockSample。
 */
import { defineStore } from 'pinia';
import {
  isClockJump,
  pickBestClockOffset,
  pruneClockSamples,
  type ClockSample,
  type GameState,
  type TimerState,
  type Side,
  type StageConfig,
} from '@/types/debate';

export const useDebateStore = defineStore('debate', {
  state: () => ({
    /** 服务端状态镜像；未连接时为 null */
    state: null as GameState | null,
    /** 服务端-本机时钟偏移（毫秒），serverTime ≈ Date.now() + offset */
    clockOffset: 0,
    /** 时钟样本窗口；带 rtt 的往返样本优先，广播样本仅作兜底 */
    clockSamples: [] as ClockSample[],
    /** 最近一次往返同步的时延与时刻（供控制台诊断展示） */
    clockRtt: null as number | null,
    clockSyncedAt: null as number | null,
    /** 连接态 */
    connected: false,
  }),

  getters: {
    status: (s) => s.state?.status ?? 'idle',
    stages: (s) => s.state?.stages ?? [],
    currentStage(): StageConfig | null {
      if (!this.state) return null;
      return this.state.stages[this.state.currentStageIndex] ?? null;
    },
    activeSpeaker: (s) => s.state?.activeSpeaker ?? null,
    config: (s) => s.state?.config ?? null,
    timers: (s) => s.state?.timers ?? {},
    /** 已公布的成绩汇总；未公布时为 null */
    published: (s) => s.state?.published ?? null,
  },

  actions: {
    /**
     * 记录一次时钟采样。
     *
     * 为什么不能只用广播里的 serverTime：广播是单向的，从服务端打戳到本机收到之间
     * 隔了一个单程网络延迟，样本会系统性偏小（各端显示比真实更多的剩余时间）。
     * 因此带 rtt 的往返样本优先，且同样本中取 RTT 最小者（见 pickBestClockOffset）。
     */
    recordClockSample(offset: number, rtt: number | null) {
      const now = Date.now();
      const previous = this.clockSamples.length > 0 ? this.clockOffset : null;
      let samples = pruneClockSamples([...this.clockSamples, { offset, rtt, at: now }], now);
      let best = pickBestClockOffset(samples);

      if (best != null && isClockJump(previous, best)) {
        // 本机或服务端时钟发生跳变：旧样本全部作废，只用本次重建
        samples = [{ offset, rtt, at: now }];
        best = offset;
      }

      this.clockSamples = samples;
      if (best != null) this.clockOffset = best;
      if (rtt != null) {
        this.clockRtt = rtt;
        this.clockSyncedAt = now;
      }
    },

    /** 断线时清空样本：重连后设备时钟可能已被 NTP 校正，旧样本不再可信 */
    resetClockSamples() {
      this.clockSamples = [];
      this.clockRtt = null;
      this.clockSyncedAt = null;
    },

    /** 接收服务端全量快照 */
    applyState(state: GameState) {
      this.state = state;
      this.connected = true;
      // 还没有任何往返样本时才用广播兜底，避免污染高精度估计
      if (this.clockSamples.every((s) => s.rtt == null)) {
        this.recordClockSample(state.serverTime - Date.now(), null);
      }
    },

    setConnected(v: boolean) {
      this.connected = v;
    },

    /**
     * 计算计时器剩余毫秒（权威时间算法，供各端调用）。
     * now 传入 useMasterClock 每帧刷新的同步时刻。
     */
    remainingOf(timer: TimerState | undefined, now: number): number {
      if (!timer) return 0;
      if (timer.status === 'running' && timer.targetEndTime != null) {
        return Math.max(0, timer.targetEndTime - now); // countdown：剩余
      }
      if (timer.status === 'running' && timer.startedAt != null) {
        return Math.max(0, now - timer.startedAt); // countUp：已耗（与服务端 timer.ts 同语义）
      }
      return timer.remainingMs;
    },

    /** 当前同步时刻：本地墙钟 + 偏移校正 */
    syncedNow(): number {
      return Date.now() + this.clockOffset;
    },

    sideLabel(side: Side): string {
      return side === 'aff' ? '正方' : '反方';
    },
  },
});
