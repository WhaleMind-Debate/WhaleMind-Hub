/**
 * Socket 连接层（useSocket）
 * - 单例 socket，三端共享连接逻辑；
 * - game:state 快照直接灌进 debateStore（含时钟偏移采样）；
 * - 控制台指令走 match:command，评委走 judge:join / score:submit。
 */
import { io, type Socket } from 'socket.io-client';
import {
  SOCKET_EVENTS,
  type CommandResult,
  type GameState,
  type JudgeJoinPayload,
  type JudgeSessionResult,
  type JudgeResumePayload,
  type MatchCommand,
  type ScorePreviewResult,
  type ScoreSubmitPayload,
  type TimeSyncResult,
  type TimerWarnPayload,
} from '@/types/debate';
import { useDebateStore } from '@/stores/debateStore';

let socket: Socket | null = null;
/** 周期时钟复测定时器（模块级单例，与 socket 同生命周期）
 *  用 ReturnType 而非 number：客户端工程同时可见 DOM 与 Node 的定时器类型 */
let clockTimer: ReturnType<typeof setInterval> | null = null;
const CLOCK_RESYNC_MS = 5_000;

export function useSocket() {
  const store = useDebateStore();

  function connect(): Socket {
    if (socket) return socket;
    // 开发期同源连接（vite proxy 转发 /socket.io 到后端）
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      store.setConnected(true);
      // 连接（含重连）后立刻同步一次，随后按周期复测
      startClockSync();
    });
    socket.on('disconnect', () => {
      store.setConnected(false);
      stopClockSync();
      // 断线期间设备时钟可能被 NTP 校正，旧样本不再可信
      store.resetClockSamples();
    });

    socket.on(SOCKET_EVENTS.GAME_STATE, (state: GameState) => {
      store.applyState(state);
    });

    return socket;
  }

  /** 主席指令（结果经回调返回；状态广播走 game:state） */
  function sendCommand(command: MatchCommand): Promise<CommandResult> {
    const s = connect();
    return new Promise((resolve) => {
      s.timeout(3000).emit(SOCKET_EVENTS.MATCH_COMMAND, { command }, (err: unknown, res?: CommandResult) => {
        resolve(err ? { ok: false, error: '指令超时' } : (res ?? { ok: false, error: '无响应' }));
      });
    });
  }

  /** 评委加入 */
  function judgeJoin(payload: JudgeJoinPayload): Promise<JudgeSessionResult> {
    const s = connect();
    return new Promise((resolve) => {
      s.timeout(3000).emit(SOCKET_EVENTS.JUDGE_JOIN, payload, (err: unknown, res?: JudgeSessionResult) => {
        resolve(err ? { ok: false, error: '连接超时' } : (res ?? { ok: false, error: '无响应' }));
      });
    });
  }

  /**
   * 评委会话续期：页面刷新 / 断线重连后凭 judgeId 找回身份与已提交评分。
   * 服务端返回 ok:false 表示会话已失效（如比赛被重置），调用方应清掉本地记录。
   */
  function judgeResume(payload: JudgeResumePayload): Promise<JudgeSessionResult> {
    const s = connect();
    return new Promise((resolve) => {
      s.timeout(3000).emit(SOCKET_EVENTS.JUDGE_RESUME, payload, (err: unknown, res?: JudgeSessionResult) => {
        resolve(err ? { ok: false, error: '连接超时' } : (res ?? { ok: false, error: '无响应' }));
      });
    });
  }

  /**
   * 时钟同步（往返测量）。
   *
   * offset = serverTime - (t0 + t1) / 2，其中 t0/t1 为本机发送/接收时刻。
   * 往返测量把单程网络延迟从偏移估计中消掉——这正是广播采样做不到的。
   */
  function syncTime(): Promise<number | null> {
    const s = connect();
    const t0 = Date.now();
    return new Promise((resolve) => {
      s.timeout(3000).emit(SOCKET_EVENTS.TIME_SYNC, { clientTime: t0 }, (err: unknown, res?: TimeSyncResult) => {
        if (err || !res) {
          resolve(null);
          return;
        }
        const t1 = Date.now();
        const rtt = t1 - t0;
        store.recordClockSample(res.serverTime - (t0 + t1) / 2, rtt);
        resolve(rtt);
      });
    });
  }

  /** 启动周期时钟同步（幂等；重复调用会先停掉旧的） */
  function startClockSync(intervalMs: number = CLOCK_RESYNC_MS): void {
    stopClockSync();
    void syncTime();
    clockTimer = setInterval(() => void syncTime(), intervalMs);
  }

  function stopClockSync(): void {
    if (clockTimer != null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  }

  /** 主席端成绩预览（结果只回传本次请求，不进入广播） */
  function previewScores(): Promise<ScorePreviewResult> {
    const s = connect();
    return new Promise((resolve) => {
      s.timeout(3000).emit(SOCKET_EVENTS.SCORE_PREVIEW, {}, (err: unknown, res?: ScorePreviewResult) => {
        resolve(err ? { ok: false, error: '预览超时' } : (res ?? { ok: false, error: '无响应' }));
      });
    });
  }

  /** 评分提交（upsert，以最后一次为准） */
  function submitScore(payload: ScoreSubmitPayload): void {
    connect().emit(SOCKET_EVENTS.SCORE_SUBMIT, payload);
  }

  /** 计时预警订阅（大屏铃声/动效用） */
  function onTimerWarn(handler: (p: TimerWarnPayload) => void): () => void {
    const s = connect();
    s.on(SOCKET_EVENTS.TIMER_WARN, handler);
    return () => s.off(SOCKET_EVENTS.TIMER_WARN, handler);
  }

  return { connect, sendCommand, judgeJoin, judgeResume, submitScore, onTimerWarn, syncTime, previewScores };
}
