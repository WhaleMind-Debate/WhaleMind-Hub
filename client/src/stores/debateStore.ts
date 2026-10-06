/**
 * 比赛状态仓库（唯一状态收拢点，严禁在 View 组件内私有维护比赛状态）
 *
 * 本 store 是服务端 engine 状态的纯镜像：
 * - 只被动接收 game:state 快照，不做任何本地状态推导；
 * - 时钟偏移 clockOffset：serverTime - Date.now() 的滚动采样中位数，
 *   多端倒计时一律用 targetEndTime - (Date.now() + clockOffset) 反推。
 */
import { defineStore } from 'pinia';
import type { GameState, TimerState, Side, StageConfig } from '@/types/debate';

const CLOCK_SAMPLE_SIZE = 9;

export const useDebateStore = defineStore('debate', {
  state: () => ({
    /** 服务端状态镜像；未连接时为 null */
    state: null as GameState | null,
    /** 服务端-本机时钟偏移（毫秒），serverTime ≈ Date.now() + offset */
    clockOffset: 0,
    clockSamples: [] as number[],
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
  },

  actions: {
    /** 接收服务端全量快照并滚动更新时钟偏移 */
    applyState(state: GameState) {
      const sample = state.serverTime - Date.now();
      this.clockSamples.push(sample);
      if (this.clockSamples.length > CLOCK_SAMPLE_SIZE) this.clockSamples.shift();
      const sorted = [...this.clockSamples].sort((a, b) => a - b);
      this.clockOffset = sorted[Math.floor(sorted.length / 2)] ?? 0;
      this.state = state;
      this.connected = true;
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
        return Math.max(0, timer.targetEndTime - now);
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
