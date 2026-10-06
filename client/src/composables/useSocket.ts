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
  type JudgeJoinResult,
  type MatchCommand,
  type ScoreSubmitPayload,
  type TimerWarnPayload,
} from '@/types/debate';
import { useDebateStore } from '@/stores/debateStore';

let socket: Socket | null = null;

export function useSocket() {
  const store = useDebateStore();

  function connect(): Socket {
    if (socket) return socket;
    // 开发期同源连接（vite proxy 转发 /socket.io 到后端）
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('connect', () => store.setConnected(true));
    socket.on('disconnect', () => store.setConnected(false));

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
  function judgeJoin(payload: JudgeJoinPayload): Promise<JudgeJoinResult> {
    const s = connect();
    return new Promise((resolve) => {
      s.timeout(3000).emit(SOCKET_EVENTS.JUDGE_JOIN, payload, (err: unknown, res?: JudgeJoinResult) => {
        resolve(err ? { ok: false, error: '连接超时' } : (res ?? { ok: false, error: '无响应' }));
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

  return { connect, sendCommand, judgeJoin, submitScore, onTimerWarn };
}
