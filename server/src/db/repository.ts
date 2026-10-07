/**
 * 比赛落盘仓库（MatchRepository）
 *
 * 职责边界：
 * - 只负责「内存状态 ⇄ SQLite」的搬运与归档，不含任何比赛规则判断；
 * - engine 仍是唯一状态权威，仓库是它的持久化投影。
 *
 * 三条关键策略：
 * 1. **冻结落盘**：写入时若计时器正在跑，落盘的是当前剩余量而不是目标结束点，
 *    这样即使进程被强杀，库中记录的也是最后一次写入时刻的真实剩余时间；
 * 2. **心跳**：比赛 running 时最多每 heartbeatMs 落一次盘（默认 1s），
 *    把“崩溃瞬间的剩余时间”精度控制在心跳窗口内；
 * 3. **换场归档**：reset 会生成新 matchId，saveMatch 发现 matchId 变化即归档旧场
 *    （只置 ended_at，评分行全部保留），新场成为唯一活跃场次。
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type {
  GameStatus,
  Judge,
  MatchConfig,
  Score,
  Side,
  StageConfig,
  TimerState,
} from '@debate/shared';
import type { EnginePersistPayload, EngineRestoreData } from '../game/engine.js';
import { remainingOf } from '../game/timer.js';

export interface MatchRepositoryOptions {
  db: DatabaseSync;
  now?: () => number;
  /** 心跳节流窗口（毫秒） */
  heartbeatMs?: number;
}

/** 默认心跳窗口：1s，即崩溃后剩余时间的最大误差 */
export const DEFAULT_HEARTBEAT_MS = 1000;

type Row = Record<string, unknown>;

/** 场次概览（历史列表用） */
export interface MatchSummary {
  matchId: string;
  name: string;
  topic: string;
  status: GameStatus;
  createdAt: number;
  updatedAt: number;
  /** 归档时间；null 表示当前活跃场次 */
  endedAt: number | null;
  judgeCount: number;
  scoreCount: number;
}

/** 单条评分 + 评委姓名（仅赛后导出使用，绝不进入实时广播） */
export interface ScoreWithJudge {
  judgeId: string;
  judgeName: string;
  stageId: string;
  side: Side;
  value: number;
  updatedAt: number;
}

/** 防御式 JSON 解析：库里出现脏数据时降级而不是让服务端起不来 */
function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * 把计时器转成「落盘形态」：running 的计时器固化当前剩余毫秒。
 * 纯函数，不改动传入对象——engine 的内存状态不受影响。
 */
export function freezeTimers(
  timers: Partial<Record<Side, TimerState>>,
  now: number,
): Partial<Record<Side, TimerState>> {
  const out: Partial<Record<Side, TimerState>> = {};
  for (const [side, timer] of Object.entries(timers) as [Side, TimerState | undefined][]) {
    if (!timer) continue;
    out[side] =
      timer.status === 'running'
        ? { ...timer, status: 'paused', remainingMs: remainingOf(timer, now), targetEndTime: null, startedAt: null }
        : { ...timer };
  }
  return out;
}

export class MatchRepository {
  private db: DatabaseSync;
  private now: () => number;
  private heartbeatMs: number;
  /** 当前活跃场次 id；null 表示尚未从库中读出或写入过任何场次 */
  private activeMatchId: string | null = null;
  /** 上次整行写入的（服务端）时刻，用于心跳节流 */
  private lastWriteAt = 0;

  private upsertMatch: StatementSync;
  private upsertJudge: StatementSync;
  private upsertScore: StatementSync;
  private selectActiveMatch: StatementSync;
  private selectJudges: StatementSync;
  private selectScores: StatementSync;
  private selectMatchById: StatementSync;
  private selectAllMatches: StatementSync;
  private countJudgesByMatch: StatementSync;
  private countScoresByMatch: StatementSync;
  private selectScoresWithJudges: StatementSync;
  private archive: StatementSync;

  constructor(opts: MatchRepositoryOptions) {
    this.db = opts.db;
    this.now = opts.now ?? (() => Date.now());
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

    this.upsertMatch = this.db.prepare(`
      INSERT INTO matches (
        match_id, name, topic, status, current_stage_index,
        config, stages, timers, active_speaker, fired_warns,
        created_at, updated_at, ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(match_id) DO UPDATE SET
        name = excluded.name,
        topic = excluded.topic,
        status = excluded.status,
        current_stage_index = excluded.current_stage_index,
        config = excluded.config,
        stages = excluded.stages,
        timers = excluded.timers,
        active_speaker = excluded.active_speaker,
        fired_warns = excluded.fired_warns,
        updated_at = excluded.updated_at
    `);
    this.upsertJudge = this.db.prepare(`
      INSERT INTO judges (judge_id, match_id, name, joined_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(judge_id) DO UPDATE SET name = excluded.name
    `);
    this.upsertScore = this.db.prepare(`
      INSERT INTO scores (judge_id, match_id, stage_id, side, value, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(judge_id, stage_id, side) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at,
        match_id = excluded.match_id
    `);
    this.selectActiveMatch = this.db.prepare(
      'SELECT * FROM matches WHERE ended_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1',
    );
    this.selectJudges = this.db.prepare(
      'SELECT * FROM judges WHERE match_id = ? ORDER BY joined_at ASC, judge_id ASC',
    );
    this.selectScores = this.db.prepare('SELECT * FROM scores WHERE match_id = ? ORDER BY updated_at ASC');
    this.selectMatchById = this.db.prepare('SELECT * FROM matches WHERE match_id = ?');
    this.selectAllMatches = this.db.prepare('SELECT * FROM matches ORDER BY created_at DESC, rowid DESC');
    this.countJudgesByMatch = this.db.prepare('SELECT match_id, COUNT(*) AS n FROM judges GROUP BY match_id');
    this.countScoresByMatch = this.db.prepare('SELECT match_id, COUNT(*) AS n FROM scores GROUP BY match_id');
    this.selectScoresWithJudges = this.db.prepare(
      `SELECT s.judge_id, s.stage_id, s.side, s.value, s.updated_at, j.name AS judge_name
         FROM scores s JOIN judges j ON j.judge_id = s.judge_id
        WHERE s.match_id = ?
        ORDER BY s.stage_id ASC, s.side ASC, j.name ASC`,
    );
    this.archive = this.db.prepare(
      'UPDATE matches SET ended_at = ?, updated_at = ? WHERE match_id = ? AND ended_at IS NULL',
    );
  }

  /** 当前活跃场次 id（仅在 loadActiveMatch / saveMatch 之后有效） */
  activeMatch(): string | null {
    return this.activeMatchId;
  }

  /**
   * 读出活跃场次供 engine 恢复。
   * 无活跃场次（首次启动或库被清空）返回 null，调用方按全新比赛处理。
   */
  loadActiveMatch(): EngineRestoreData | null {
    const row = this.selectActiveMatch.get() as Row | undefined;
    if (!row) return null;
    const matchId = String(row.match_id);
    this.activeMatchId = matchId;
    this.lastWriteAt = Number(row.updated_at ?? 0);
    return this.toRestoreData(row);
  }

  /** 读取任意场次（含已归档）——供赛后查询与导出使用 */
  loadMatch(matchId: string): EngineRestoreData | null {
    const row = this.selectMatchById.get(matchId) as Row | undefined;
    return row ? this.toRestoreData(row) : null;
  }

  /** 场次列表（含归档），带评委数与评分数便于概览 */
  listMatchSummaries(): MatchSummary[] {
    const judges = new Map<string, number>();
    for (const row of this.countJudgesByMatch.all() as Row[]) {
      judges.set(String(row.match_id), Number(row.n));
    }
    const scores = new Map<string, number>();
    for (const row of this.countScoresByMatch.all() as Row[]) {
      scores.set(String(row.match_id), Number(row.n));
    }
    return (this.selectAllMatches.all() as Row[]).map((row) => {
      const matchId = String(row.match_id);
      return {
        matchId,
        name: String(row.name),
        topic: String(row.topic),
        status: String(row.status) as GameStatus,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        endedAt: row.ended_at == null ? null : Number(row.ended_at),
        judgeCount: judges.get(matchId) ?? 0,
        scoreCount: scores.get(matchId) ?? 0,
      };
    });
  }

  /** 场次全部评分（带评委姓名）——只有赛后导出会用到，绝不进入实时广播 */
  scoresWithJudgeNames(matchId: string): ScoreWithJudge[] {
    return (this.selectScoresWithJudges.all(matchId) as Row[]).map((r) => ({
      judgeId: String(r.judge_id),
      judgeName: String(r.judge_name),
      stageId: String(r.stage_id),
      side: String(r.side) as Side,
      value: Number(r.value),
      updatedAt: Number(r.updated_at),
    }));
  }

  private toRestoreData(row: Row): EngineRestoreData {
    const matchId = String(row.match_id);
    const judges = (this.selectJudges.all(matchId) as Row[]).map(
      (r): Judge => ({ id: String(r.judge_id), matchId: String(r.match_id), name: String(r.name) }),
    );
    const scores = (this.selectScores.all(matchId) as Row[]).map(
      (r): Score => ({
        judgeId: String(r.judge_id),
        stageId: String(r.stage_id),
        side: String(r.side) as Side,
        value: Number(r.value),
        updatedAt: Number(r.updated_at),
      }),
    );

    return {
      config: parseJson<MatchConfig>(row.config, {} as MatchConfig),
      status: String(row.status) as GameStatus,
      stages: parseJson<StageConfig[]>(row.stages, []),
      currentStageIndex: Number(row.current_stage_index ?? -1),
      timers: parseJson<Partial<Record<Side, TimerState>>>(row.timers, {}),
      activeSpeaker: (row.active_speaker == null ? null : String(row.active_speaker)) as Side | null,
      firedWarns: parseJson<string[]>(row.fired_warns, []),
      judges,
      scores,
    };
  }

  /** 整行落盘（每次状态变更 + 心跳都走这里）；换场时顺带归档旧场 */
  saveMatch(payload: EnginePersistPayload): void {
    const { state } = payload;
    const now = state.serverTime;
    const matchId = state.config.matchId;

    if (this.activeMatchId !== null && this.activeMatchId !== matchId) {
      this.archiveMatch(this.activeMatchId, now);
    }
    this.activeMatchId = matchId;

    const timers = freezeTimers(state.timers, now);
    this.db.exec('BEGIN');
    try {
      this.upsertMatch.run(
        matchId,
        state.config.name,
        state.config.topic,
        state.status,
        state.currentStageIndex,
        JSON.stringify(state.config),
        JSON.stringify(state.stages),
        JSON.stringify(timers),
        state.activeSpeaker,
        JSON.stringify(payload.firedWarns),
        now,
        now,
      );
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.lastWriteAt = now;
  }

  /**
   * 心跳：仅在比赛 running 且距上次写入超过心跳窗口时落盘。
   * 状态变更本身已经落过盘，因此这里被节流跳过并不丢信息。
   */
  heartbeat(payload: EnginePersistPayload): void {
    if (payload.state.status !== 'running') return;
    if (payload.state.serverTime - this.lastWriteAt < this.heartbeatMs) return;
    this.saveMatch(payload);
  }

  /** 评委入场落盘（判分行的外键依赖） */
  saveJudge(judge: Judge): void {
    this.upsertJudge.run(judge.id, judge.matchId, judge.name, this.now());
  }

  /** 单条评分 upsert（以最后一次为准，与内存语义一致） */
  saveScore(score: Score, matchId: string): void {
    this.upsertScore.run(score.judgeId, matchId, score.stageId, score.side, score.value, score.updatedAt);
  }

  /** 归档场次：只标记结束时间，评分与评委行全部保留 */
  archiveMatch(matchId: string, at: number): void {
    this.archive.run(at, at, matchId);
  }

  close(): void {
    this.db.close();
  }
}
