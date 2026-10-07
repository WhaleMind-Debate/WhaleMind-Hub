/**
 * 服务端入口：Express + Socket.io + SQLite 落盘
 * - 状态机 engine 是唯一权威；所有客户端（控制台/评委/大屏）都是它的镜像。
 * - 看门狗每 200ms tick 一次：预警判定、归零固化与自动推进（均从 targetEndTime 反推）。
 * - 落盘：engine 每次状态变更回调仓库整行写入；比赛 running 时另有 1s 心跳，
 *   把“崩溃瞬间的剩余时间”精度控制在心跳窗口内。
 * - 重启：自动恢复活跃场次；若中断时正在计时，则冻结为 paused 待主席确认。
 */
import express from 'express';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { Server } from 'socket.io';
import {
  aggregateScores,
  SOCKET_EVENTS,
  stageBreakdown,
  validateStages,
  validateTemplateMeta,
  type CommandResult,
  type GameState,
  type JudgeJoinPayload,
  type JudgeJoinResult,
  type JudgeResumePayload,
  type JudgeResumeResult,
  type MatchCommandPayload,
  type ScorePreviewResult,
  type ScoreSubmitPayload,
  type StageInput,
  type TimeSyncPayload,
  type TimeSyncResult,
  type TimerWarnPayload,
} from '@debate/shared';
import { MatchRepository } from './db/repository.js';
import { openDatabase } from './db/schema.js';
import { TemplateRepository } from './db/templateRepository.js';
import { createMonotonicClock } from './game/clock.js';
import { GameEngine } from './game/engine.js';
import { CSV_BOM, toCsv } from './report/csv.js';
import { createNtpSync } from './time/ntp.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true }, // 开发期允许任意来源；公网部署经反代收紧
});

// ==================== 时间基准 ====================

/**
 * 服务端内部统一使用单调时钟：系统时钟被 NTP 校时、用户手改或虚拟机回滚而“跳变”时，
 * 进行中的倒计时不会跟着跳（targetEndTime 是绝对墙钟戳，直接依赖 Date.now() 会出事）。
 * Date.now() 仅用于与外界对齐与诊断；NTP 校时只平移本时钟的对外读数。
 */
const clock = createMonotonicClock();

// ==================== 持久化接线 ====================

const db = openDatabase();
const repo = new MatchRepository({ db });
const templates = new TemplateRepository(db);
const restored = repo.loadActiveMatch();

const engine = new GameEngine({
  now: clock.now,
  restore: restored ?? undefined,
  onEvent: (e) => {
    switch (e.type) {
      case 'stateChanged':
        broadcastState();
        break;
      case 'warn': {
        const payload: TimerWarnPayload = {
          side: e.side,
          thresholdSec: e.thresholdSec,
          serverTime: clock.now(),
        };
        io.emit(SOCKET_EVENTS.TIMER_WARN, payload);
        break;
      }
      // 评委入场不广播（其余端无需感知），只落盘——判分行依赖它的外键
      case 'judgeJoined':
        repo.saveJudge(e.judge);
        break;
      case 'scoreSubmitted':
        repo.saveScore(e.score, e.matchId);
        break;
    }
  },
  // 落盘与广播共用 changed() 出口，二者不可能不同步
  onPersist: (payload) => repo.saveMatch(payload),
});

// 启动即确保库中存在活跃场次行（评委/评分行的外键依赖它）
engine.persistNow();

if (restored) {
  const s = engine.snapshot();
  console.log(
    `[debate-server] 已恢复场次 ${s.config.matchId}（状态 ${s.status}，环节 ${s.currentStageIndex + 1}/${s.stages.length}，` +
      `评委 ${restored.judges.length} 位 / 评分 ${restored.scores.length} 条）`,
  );
  if (restored.status === 'running') {
    console.log('[debate-server] 上次中断时比赛进行中：计时已冻结，请主席确认后点「恢复」继续');
  }
} else {
  console.log('[debate-server] 未发现历史场次，按全新比赛启动');
}

function broadcastState(): void {
  io.emit(SOCKET_EVENTS.GAME_STATE, engine.snapshot());
}

// 模板 CRUD 的请求体是 JSON，需要一个体积受限的解析器
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (_req, res) => {
  const s = engine.snapshot();
  res.json({
    ok: true,
    serverTime: clock.now(),
    matchId: s.config.matchId,
    status: s.status,
    clock: { ...clock.stats(), ntp: ntp ? ntp.status() : { enabled: false } },
  });
});

// ==================== 赛后查询与导出 ====================

/** 场次明细：汇总 + 分环节平均。刻意不含单个评委分数 */
function buildMatchDetail(matchId: string) {
  const loaded = repo.loadMatch(matchId);
  if (!loaded) return null;
  const rows = repo.scoresWithJudgeNames(matchId);
  return {
    match: repo.listMatchSummaries().find((m) => m.matchId === matchId) ?? null,
    config: loaded.config,
    status: loaded.status,
    stages: loaded.stages,
    totals: aggregateScores(loaded.stages, rows),
    breakdown: stageBreakdown(loaded.stages, rows),
    judges: loaded.judges.map((j) => ({ id: j.id, name: j.name })),
  };
}

/** 场次列表（含已归档） */
app.get('/api/matches', (_req, res) => {
  res.json({ ok: true, matches: repo.listMatchSummaries() });
});

/** 单场明细 */
app.get('/api/matches/:matchId', (req, res) => {
  const detail = buildMatchDetail(req.params.matchId);
  if (!detail) {
    res.status(404).json({ ok: false, error: '场次不存在' });
    return;
  }
  res.json({ ok: true, ...detail });
});

/**
 * 官方记录导出：**含单个评委分数**。
 * 这是赛后存档通道，与实时广播的“分数不外泄”约束不冲突，但它属于组织方工具：
 * 系统目前没有鉴权（ADMIN_PIN 属规划中），公网部署需配合反代限制。
 */
app.get('/api/matches/:matchId/export.csv', (req, res) => {
  const matchId = req.params.matchId;
  const loaded = repo.loadMatch(matchId);
  if (!loaded) {
    res.status(404).type('text/plain; charset=utf-8').send('场次不存在');
    return;
  }
  const stageName = new Map(loaded.stages.map((s) => [s.id, s.name]));
  const rows = repo.scoresWithJudgeNames(matchId).map((row) => [
    matchId,
    stageName.get(row.stageId) ?? row.stageId,
    row.side === 'aff' ? '正方' : '反方',
    row.judgeName,
    row.value,
    new Date(row.updatedAt).toISOString(),
  ]);
  const csv = toCsv(['场次ID', '环节', '辩方', '评委', '评分', '提交时间'], rows);
  res.type('text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${matchId}-scores.csv"`);
  res.send(CSV_BOM + csv);
});

// ==================== 自定义赛制模板 ====================

/** 解析并校验模板请求体；失败时直接告诉调用方哪里不合法 */
function readTemplateBody(
  body: unknown,
): { ok: true; name: string; description: string; stages: StageInput[] } | { ok: false; error: string } {
  const meta = validateTemplateMeta(body);
  if (!meta.ok) return meta;
  const stages = validateStages((body as { stages?: unknown } | null | undefined)?.stages);
  if (!stages.ok) return { ok: false, error: stages.error };
  return { ok: true, name: meta.name, description: meta.description, stages: stages.stages };
}

app.get('/api/templates', (_req, res) => {
  res.json({ ok: true, templates: templates.list() });
});

app.post('/api/templates', (req, res) => {
  const body = readTemplateBody(req.body);
  if (!body.ok) {
    res.status(400).json(body);
    return;
  }
  res.status(201).json({ ok: true, template: templates.upsert(body, clock.now()) });
});

app.put('/api/templates/:templateId', (req, res) => {
  const { templateId } = req.params;
  if (!templates.has(templateId)) {
    res.status(404).json({ ok: false, error: '模板不存在' });
    return;
  }
  const body = readTemplateBody(req.body);
  if (!body.ok) {
    res.status(400).json(body);
    return;
  }
  res.json({ ok: true, template: templates.upsert({ ...body, id: templateId }, clock.now()) });
});

app.delete('/api/templates/:templateId', (req, res) => {
  const removed = templates.remove(req.params.templateId);
  if (!removed) {
    res.status(404).json({ ok: false, error: '模板不存在' });
    return;
  }
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  // 新连接 / 重连一律先收全量快照
  socket.emit(SOCKET_EVENTS.GAME_STATE, engine.snapshot());

  /**
   * 时钟同步：原样回带客户端的发送时刻，客户端据此算往返时延与偏移
   * （offset = serverTime - (t0+t1)/2）。无状态、可高频调用。
   */
  socket.on(SOCKET_EVENTS.TIME_SYNC, (payload: TimeSyncPayload, ack?: (r: TimeSyncResult) => void) => {
    ack?.({ clientTime: payload?.clientTime ?? 0, serverTime: clock.now() });
  });

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
      ? { ok: true, judge: result.judge, state: engine.snapshot(), myScores: [] }
      : { ok: false, error: result.error };
    ack?.(body);
  });

  // 评委会话续期：刷新页面 / 断线重连后凭 judgeId 找回身份与已提交评分
  socket.on(SOCKET_EVENTS.JUDGE_RESUME, (payload: JudgeResumePayload, ack?: (r: JudgeResumeResult) => void) => {
    const result = engine.resumeJudge(payload?.judgeId ?? '');
    const body: JudgeResumeResult = result.ok
      ? { ok: true, judge: result.judge, state: engine.snapshot(), myScores: result.scores }
      : { ok: false, error: result.error };
    ack?.(body);
  });

  /**
   * 主席端成绩预览：结果只回传给发起请求的这一个 socket，绝不进入广播。
   * 注意：系统目前没有账号体系（ADMIN_PIN 属规划中），这条通道不是安全边界，
   * 它的意义是“不主动泄露”，而不是“无法被请求”。
   */
  socket.on(SOCKET_EVENTS.SCORE_PREVIEW, (_payload: unknown, ack?: (r: ScorePreviewResult) => void) => {
    ack?.({ ok: true, scores: engine.computeTotals() });
  });

  socket.on(SOCKET_EVENTS.SCORE_SUBMIT, (payload: ScoreSubmitPayload, ack?: (r: CommandResult) => void) => {
    const result = engine.submitScore(payload.judgeId, payload.stageId, payload.side, payload.value);
    ack?.(result);
    // 进度随状态快照统一下发（scoreProgress 字段），此处保留事件名供后续增量优化
    io.emit(SOCKET_EVENTS.SCORE_PROGRESS, {
      scoreProgress: engine.snapshot().scoreProgress,
      serverTime: clock.now(),
    });
  });
});

// ==================== NTP 校时（可选） ====================

/**
 * NTP 只负责让“对外时间”与现实一致（日志/导出时间戳、多实例基准），
 * 对倒计时精度没有影响——倒计时两端同源，是相对量。
 * 真正的保护是上面的单调时钟 + 这里的 canAdjust：计时进行中绝不平移时钟。
 * 默认开启（NTP_SERVER=off 可整体关闭）；外网不通时只记一条告警，不影响比赛。
 */
const NTP_SERVERS = (process.env.NTP_SERVER ?? 'ntp.aliyun.com,pool.ntp.org')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ntp =
  NTP_SERVERS.length === 0 || NTP_SERVERS[0] === 'off'
    ? null
    : createNtpSync({
        clock,
        servers: NTP_SERVERS,
        canAdjust: () => !Object.values(engine.snapshot().timers).some((t) => t?.status === 'running'),
        onAdjust: (deltaMs, sample) =>
          console.log(
            `[debate-server] NTP 校时：${sample.server} 偏移 ${deltaMs.toFixed(1)}ms（rtt ${sample.rttMs}ms）已应用`,
          ),
        onError: (message) => console.warn(`[debate-server] ${message}`),
      });
ntp?.start();

// 看门狗：预警 / 到期 / 自动推进 + 心跳落盘（heartbeat 内部按 running 与窗口自行节流）
setInterval(() => {
  engine.tick();
  repo.heartbeat(engine.persistPayload());
}, 200);

// 优雅退出：落盘最后一次状态（不归档，重启后继续同一场）
function shutdown(signal: string): void {
  console.log(`[debate-server] 收到 ${signal}，落盘后退出`);
  try {
    ntp?.stop();
    engine.persistNow();
    repo.close();
  } catch (err) {
    console.error('[debate-server] 退出落盘失败：', err);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

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
