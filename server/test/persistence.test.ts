/**
 * SQLite 落盘与崩溃恢复用例
 *
 * 覆盖：整行落盘与逐字段恢复、中断冻结语义（停机不吃比赛时间）、
 * 心跳节流与精度、换场归档、评委与评分恢复、旧场失效、预警去重恢复。
 */
import { describe, expect, it } from 'vitest';
import { MatchRepository, freezeTimers } from '../src/db/repository.js';
import { openDatabase } from '../src/db/schema.js';
import { GameEngine, type EngineEvent, type EngineRestoreData } from '../src/game/engine.js';
import { createTimer, remainingOf, startTimer } from '../src/game/timer.js';

/** 可控假时钟 */
function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

type Row = Record<string, unknown>;

/**
 * 组装「engine + 仓库 + 内存库」的测试环境，接线方式与 server/src/index.ts 一致。
 * restart() 模拟服务端重启：丢掉内存引擎，只凭库中数据重建。
 */
function makeEnv() {
  const clock = makeClock();
  const db = openDatabase(':memory:');
  const repo = new MatchRepository({ db, now: clock.now });
  const events: EngineEvent[] = [];

  const wire = (restore?: EngineRestoreData): GameEngine =>
    new GameEngine({
      now: clock.now,
      restore,
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'judgeJoined') repo.saveJudge(e.judge);
        else if (e.type === 'scoreSubmitted') repo.saveScore(e.score, e.matchId);
      },
      onPersist: (p) => repo.saveMatch(p),
    });

  const engine = wire();
  engine.persistNow(); // 启动即写入活跃场次行

  return {
    clock,
    db,
    repo,
    events,
    engine,
    /** 模拟服务端重启，返回重建后的引擎 */
    restart(): GameEngine {
      const rebuilt = wire(repo.loadActiveMatch() ?? undefined);
      rebuilt.persistNow();
      return rebuilt;
    },
    matchRow(matchId: string): Row | undefined {
      return db.prepare('SELECT * FROM matches WHERE match_id = ?').get(matchId) as Row | undefined;
    },
    scoreCount(matchId: string): number {
      const row = db.prepare('SELECT COUNT(*) AS n FROM scores WHERE match_id = ?').get(matchId) as Row;
      return Number(row.n);
    },
  };
}

describe('freezeTimers 冻结落盘', () => {
  it('running 的计时器固化为当前剩余量，且不改动传入对象', () => {
    const timer = startTimer(createTimer(30_000), 1_000_000, 'countdown');
    const frozen = freezeTimers({ aff: timer }, 1_010_000);
    expect(frozen.aff).toMatchObject({ status: 'paused', remainingMs: 20_000, targetEndTime: null });
    // 纯函数：原对象仍是 running
    expect(timer.status).toBe('running');
    expect(timer.targetEndTime).toBe(1_030_000);
  });

  it('未启动 / 已暂停的计时器原样保留', () => {
    const idle = createTimer(60_000);
    expect(freezeTimers({ aff: idle }, 1_000_000).aff).toEqual(idle);
  });
});

describe('比赛落盘与恢复', () => {
  it('首次启动：库中无活跃场次', () => {
    const env = makeEnv();
    expect(env.repo.activeMatch()).toBe(env.engine.snapshot().config.matchId);
    expect(env.matchRow(env.engine.snapshot().config.matchId)?.ended_at).toBeNull();
  });

  it('整行落盘：重启后状态、环节、配置与计时逐字段一致', () => {
    const env = makeEnv();
    env.engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
    env.engine.command({ type: 'start' });
    const before = env.engine.snapshot();
    env.clock.advance(5_000);
    env.repo.heartbeat(env.engine.persistPayload()); // 看门狗心跳

    const rebuilt = env.restart();
    const after = rebuilt.snapshot();
    expect(after.config.matchId).toBe(before.config.matchId);
    expect(after.config.entryCode).toBe(before.config.entryCode);
    expect(after.stages).toEqual(before.stages);
    expect(after.currentStageIndex).toBe(before.currentStageIndex);
    // 中断时正在跑 → 冻结为 paused，剩余量取最后一次心跳值（30s - 5s）
    expect(after.status).toBe('paused');
    expect(after.timers.aff).toMatchObject({ status: 'paused', remainingMs: 25_000, targetEndTime: null });
  });

  it('中断冻结：停机时长不计入比赛时间，主席恢复后从冻结值继续', () => {
    const env = makeEnv();
    env.engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
    env.engine.command({ type: 'start' });
    env.clock.advance(5_000);
    env.repo.heartbeat(env.engine.persistPayload());

    env.clock.advance(600_000); // 服务端宕机 10 分钟
    const rebuilt = env.restart();
    const s1 = rebuilt.snapshot();
    expect(s1.status).toBe('paused');
    expect(remainingOf(s1.timers.aff!, env.clock.now())).toBe(25_000); // 只扣掉跑过的 5s

    expect(rebuilt.command({ type: 'resume' }).ok).toBe(true);
    const s2 = rebuilt.snapshot();
    expect(s2.status).toBe('running');
    expect(s2.timers.aff!.targetEndTime).toBe(env.clock.now() + 25_000); // 从冻结值重新生成目标点
  });

  it('心跳精度：崩溃点在心跳窗口内的误差不超过窗口本身', () => {
    const env = makeEnv();
    env.engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
    env.engine.command({ type: 'start' }); // 30s 环节
    env.clock.advance(10_000);
    env.repo.heartbeat(env.engine.persistPayload()); // 心跳：固化 20s
    env.clock.advance(900); // 心跳后 0.9s 进程被强杀（真实剩余 19.1s）

    const rebuilt = env.restart();
    expect(rebuilt.snapshot().timers.aff!.remainingMs).toBe(20_000); // 误差 0.9s ≤ 心跳窗口
  });

  it('心跳节流：窗口内不重复写库，且状态变更本身即落盘', () => {
    const env = makeEnv();
    env.engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
    env.engine.command({ type: 'start' });
    const matchId = env.engine.snapshot().config.matchId;
    const writtenAt = Number(env.matchRow(matchId)!.updated_at);

    env.clock.advance(300);
    env.repo.heartbeat(env.engine.persistPayload());
    expect(Number(env.matchRow(matchId)!.updated_at)).toBe(writtenAt); // 窗口内被节流

    env.clock.advance(1_000);
    env.repo.heartbeat(env.engine.persistPayload());
    expect(Number(env.matchRow(matchId)!.updated_at)).toBeGreaterThan(writtenAt); // 超出窗口后落盘
  });

  it('非 running 状态不产生心跳写入', () => {
    const env = makeEnv();
    env.engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
    const matchId = env.engine.snapshot().config.matchId;
    const writtenAt = Number(env.matchRow(matchId)!.updated_at);
    env.clock.advance(5_000);
    env.repo.heartbeat(env.engine.persistPayload()); // configured，直接跳过
    expect(Number(env.matchRow(matchId)!.updated_at)).toBe(writtenAt);
  });

  it('预警去重集合随行落盘：重启恢复后不重复播报同一阈值', () => {
    const env = makeEnv();
    env.engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
    env.engine.command({ type: 'start' }); // 30s，阈值 [30, 10]
    env.engine.tick(env.clock.now());
    expect(env.events.filter((e) => e.type === 'warn')).toHaveLength(1); // 开局即命中 30s 阈值

    const rebuilt = env.restart();
    rebuilt.command({ type: 'resume' }); // 恢复计时，剩余仍是 30s
    rebuilt.tick(env.clock.now());
    expect(env.events.filter((e) => e.type === 'warn')).toHaveLength(1); // 不重复播报
  });
});

describe('评委与评分落盘', () => {
  it('评委与评分跨重启保留，本人可续期并看到自己的分数', () => {
    const env = makeEnv();
    env.engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
    const entryCode = env.engine.snapshot().config.entryCode;
    const join = env.engine.joinJudge('张三', entryCode);
    const judgeId = join.judge!.id;
    const stageId = env.engine.snapshot().stages[0].id;
    expect(env.engine.submitScore(judgeId, stageId, 'aff', 88).ok).toBe(true);

    const rebuilt = env.restart();
    expect(rebuilt.snapshot().scoreProgress).toContain(judgeId); // 进度由评分表反推

    const resumed = rebuilt.resumeJudge(judgeId);
    expect(resumed.ok).toBe(true);
    expect(resumed.judge!.name).toBe('张三');
    expect(resumed.scores).toHaveLength(1);
    expect(resumed.scores![0]).toMatchObject({ stageId, side: 'aff', value: 88 });

    // 续期后仍可继续评分（upsert 覆盖）
    expect(rebuilt.submitScore(judgeId, stageId, 'aff', 95).ok).toBe(true);
    expect(rebuilt.resumeJudge(judgeId).scores![0].value).toBe(95);
  });

  it('入场码跨重启有效，错误入场码仍被拒', () => {
    const env = makeEnv();
    env.engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
    const entryCode = env.engine.snapshot().config.entryCode;

    const rebuilt = env.restart();
    expect(rebuilt.joinJudge('李四', entryCode).ok).toBe(true);
    expect(rebuilt.joinJudge('李四', '000000').ok).toBe(false);
  });

  it('评分刻度校验在恢复后的引擎上同样生效', () => {
    const env = makeEnv();
    env.engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
    const join = env.engine.joinJudge('王五', env.engine.snapshot().config.entryCode);
    const stageId = env.engine.snapshot().stages[0].id;

    const rebuilt = env.restart();
    expect(rebuilt.submitScore(join.judge!.id, stageId, 'aff', 500).ok).toBe(false); // 越界
    expect(rebuilt.submitScore(join.judge!.id, stageId, 'aff', 80).ok).toBe(true);
  });
});

describe('reset 换场归档', () => {
  it('旧场归档保留评分，新场成为唯一活跃场次，旧评委失效', () => {
    const env = makeEnv();
    env.engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
    const oldMatchId = env.engine.snapshot().config.matchId;
    const oldEntryCode = env.engine.snapshot().config.entryCode;
    const judgeId = env.engine.joinJudge('张三', oldEntryCode).judge!.id;
    env.engine.submitScore(judgeId, env.engine.snapshot().stages[0].id, 'aff', 90);

    expect(env.engine.command({ type: 'reset' }).ok).toBe(true);
    const newMatchId = env.engine.snapshot().config.matchId;
    expect(newMatchId).not.toBe(oldMatchId);

    // 旧场只是被标记结束，评分与评委行全部留档
    expect(Number(env.matchRow(oldMatchId)!.ended_at)).toBeGreaterThan(0);
    expect(env.scoreCount(oldMatchId)).toBe(1);
    expect(env.matchRow(newMatchId)?.ended_at).toBeNull();

    // 重启后只认新场，旧评委与会话失效
    const rebuilt = env.restart();
    expect(env.repo.activeMatch()).toBe(newMatchId);
    expect(rebuilt.snapshot().config.matchId).toBe(newMatchId);
    expect(rebuilt.snapshot().stages).toHaveLength(0);
    expect(rebuilt.snapshot().scoreProgress).toHaveLength(0);
    expect(rebuilt.resumeJudge(judgeId).ok).toBe(false);
    expect(rebuilt.joinJudge('张三', oldEntryCode).ok).toBe(false); // 旧入场码失效
  });
});
