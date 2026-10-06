/**
 * 服务端入口：Express + Socket.io
 * - 状态机 engine 是唯一权威；所有客户端（控制台/评委/大屏）都是它的镜像。
 * - 看门狗每 200ms tick 一次：预警判定、归零固化与自动推进（均从 targetEndTime 反推）。
 */
import express from 'express';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { Server } from 'socket.io';
import {
  SOCKET_EVENTS,
  type CommandResult,
  type GameState,
  type JudgeJoinPayload,
  type JudgeJoinResult,
  type MatchCommandPayload,
  type ScoreSubmitPayload,
  type TimerWarnPayload,
} from '@debate/shared';
import { GameEngine } from './game/engine.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true }, // 开发期允许任意来源；公网部署经反代收紧
});

const engine = new GameEngine({
  onEvent: (e) => {
    if (e.type === 'stateChanged') {
      broadcastState();
    } else if (e.type === 'warn') {
      const payload: TimerWarnPayload = {
        side: e.side,
        thresholdSec: e.thresholdSec,
        serverTime: Date.now(),
      };
      io.emit(SOCKET_EVENTS.TIMER_WARN, payload);
    }
  },
});

function broadcastState(): void {
  io.emit(SOCKET_EVENTS.GAME_STATE, engine.snapshot());
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, serverTime: Date.now() });
});

io.on('connection', (socket) => {
  // 新连接 / 重连一律先收全量快照
  socket.emit(SOCKET_EVENTS.GAME_STATE, engine.snapshot());

  socket.on(SOCKET_EVENTS.MATCH_COMMAND, (payload: MatchCommandPayload, ack?: (r: CommandResult) => void) => {
    const result: CommandResult = engine.command(payload.command);
    // 同时支持 ack 回调与 command:result 事件两种消费方式
    ack?.(result);
    socket.emit(SOCKET_EVENTS.COMMAND_RESULT, result);
    // 状态变化由 engine.onEvent 统一广播；失败指令不产生广播
  });

  socket.on(SOCKET_EVENTS.JUDGE_JOIN, (payload: JudgeJoinPayload, ack?: (r: JudgeJoinResult) => void) => {
    const result = engine.joinJudge(payload?.name ?? '', payload?.entryCode ?? '');
    const body: JudgeJoinResult = result.ok
      ? { ok: true, judge: result.judge, state: engine.snapshot() }
      : { ok: false, error: result.error };
    ack?.(body);
  });

  socket.on(SOCKET_EVENTS.SCORE_SUBMIT, (payload: ScoreSubmitPayload) => {
    engine.submitScore(payload.judgeId, payload.stageId, payload.side, payload.value);
    // 进度随状态快照统一下发（scoreProgress 字段），此处保留事件名供后续增量优化
    io.emit(SOCKET_EVENTS.SCORE_PROGRESS, {
      scoreProgress: engine.snapshot().scoreProgress,
      serverTime: Date.now(),
    });
  });
});

// 看门狗：预警 / 到期 / 自动推进
setInterval(() => engine.tick(), 200);

httpServer.listen(PORT, HOST, () => {
  console.log(`[debate-server] listening on http://${HOST}:${PORT}`);
  // 列出局域网访问地址，方便评委手机直连
  const nets = Object.values(networkInterfaces()).flat();
  for (const net of nets) {
    if (net && net.family === 'IPv4' && !net.internal) {
      console.log(`[debate-server] LAN: http://${net.address}:${PORT}`);
    }
  }
});
