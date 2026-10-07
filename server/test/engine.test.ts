/**
 * 状态机 + 权威计时核心用例
 * 覆盖：状态流转合法性、交替计时切换、归零自动推进、保护时间、非法流转拒绝。
 */
import { describe, expect, it } from 'vitest';
import type { MatchCommand } from '@debate/shared';
import { GameEngine } from '../src/game/engine.js';
import { createTimer, isDue, pauseTimer, remainingOf, startTimer } from '../src/game/timer.js';

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

function makeEngine() {
  const clock = makeClock();
  const events: unknown[] = [];
  const engine = new GameEngine({ now: clock.now, onEvent: (e) => events.push(e) });
  return { engine, clock, events };
}

describe('timer 权威计时', () => {
  it('start 生成 targetEndTime，剩余时间由目标点反推', () => {
    const clock = makeClock();
    const t = startTimer(createTimer(60_000), clock.now(), 'countdown');
    expect(t.targetEndTime).toBe(clock.now() + 60_000);
    clock.advance(10_000);
    expect(remainingOf(t, clock.now())).toBe(50_000);
  });

  it('pause 固化剩余时间，resume 重新生成目标点', () => {
    const clock = makeClock();
    let t = startTimer(createTimer(60_000), clock.now(), 'countdown');
    clock.advance(25_000);
    t = pauseTimer(t, clock.now());
    expect(t.remainingMs).toBe(35_000);
    expect(t.targetEndTime).toBeNull();
    clock.advance(999_999); // 暂停期间无论过多久都不消耗
    expect(remainingOf(t, clock.now())).toBe(35_000);
    t = startTimer(t, clock.now(), 'countdown');
    expect(t.targetEndTime).toBe(clock.now() + 35_000);
  });

  it('countdown 到点 isDue；countUp 永不到期', () => {
    const clock = makeClock();
    const down = startTimer(createTimer(1_000), clock.now(), 'countdown');
    const up = startTimer(createTimer(0), clock.now(), 'countUp');
    clock.advance(1_001);
    expect(isDue(down, clock.now())).toBe(true);
    expect(isDue(up, clock.now())).toBe(false);
  });
});

describe('GameEngine 状态流转', () => {
  it('idle → configured → running → paused → running → finished 单向流转', () => {
    const { engine, clock } = makeEngine();
    expect(engine.snapshot().status).toBe('idle');
    expect(engine.command({ type: 'start' }).ok).toBe(false); // idle 不可开始

    expect(engine.command({ type: 'loadTemplate', templateId: 'quick-test' }).ok).toBe(true);
    expect(engine.snapshot().status).toBe('configured');

    expect(engine.command({ type: 'start' }).ok).toBe(true);
    expect(engine.snapshot().status).toBe('running');
    expect(engine.snapshot().currentStageIndex).toBe(0);

    clock.advance(5_000);
    expect(engine.command({ type: 'pause' }).ok).toBe(true);
    expect(engine.snapshot().status).toBe('paused');

    expect(engine.command({ type: 'nextStage' }).ok).toBe(false); // 暂停中不允许推进
    expect(engine.command({ type: 'resume' }).ok).toBe(true);
    expect(engine.snapshot().status).toBe('running');

    expect(engine.command({ type: 'finish' }).ok).toBe(true);
    expect(engine.snapshot().status).toBe('finished');
    expect(engine.command({ type: 'resume' }).ok).toBe(false); // 终态不可逆
    expect(engine.command({ type: 'nextStage' }).ok).toBe(false);
  });

  it('开赛后禁止更换模板 / 修改配置（状态冻结）', () => {
    const { engine } = makeEngine();
    engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
    engine.command({ type: 'start' });
    expect(engine.command({ type: 'loadTemplate', templateId: 'quick-test' }).ok).toBe(false);
    expect(engine.command({ type: 'setConfig', config: { name: 'x' } }).ok).toBe(false);
  });

  it('single 环节归零自动推进到下一环节（索引只增不减），新环节待启动', () => {
    const { engine, clock } = makeEngine();
    engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
    engine.command({ type: 'start' }); // 环节0：正方立论 30s
    clock.advance(30_001);
    engine.tick(clock.now());
    const s = engine.snapshot();
    expect(s.currentStageIndex).toBe(1); // 自动进入反方立论
    expect(s.status).toBe('running');
    // 新环节计时器就绪但未启动
    expect(s.timers.neg?.status).toBe('idle');
    expect(engine.command({ type: 'start' }).ok).toBe(true); // 主席确认后启动
  });

  it('dual_alternating 切换发言方：上一方暂停、下一方立即启动，严格一停一走', () => {
    const { engine, clock } = makeEngine();
    engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
    engine.command({ type: 'start' });
    // 推进到自由辩论（环节2，60s 双向）
    engine.command({ type: 'nextStage' }); // 1
    engine.command({ type: 'nextStage' }); // 2
    let s = engine.snapshot();
    expect(s.currentStageIndex).toBe(2);
    expect(s.activeSpeaker).toBe('aff');
    expect(s.timers.aff?.status).toBe('running');
    expect(s.timers.neg?.status).toBe('idle');

    clock.advance(10_000);
    expect(engine.command({ type: 'switchSpeaker' }).ok).toBe(true);
    s = engine.snapshot();
    expect(s.activeSpeaker).toBe('neg');
    expect(s.timers.aff?.status).toBe('paused');
    expect(s.timers.aff?.remainingMs).toBe(50_000);
    expect(s.timers.neg?.status).toBe('running');

    clock.advance(20_000); // 只有反方消耗 20s
    s = engine.snapshot();
    expect(remainingOf(s.timers.neg!, clock.now())).toBe(40_000);
    expect(s.timers.aff?.remainingMs).toBe(50_000); // 正方纹丝不动

    engine.command({ type: 'switchSpeaker' });
    s = engine.snapshot();
    expect(s.timers.aff?.status).toBe('running');
    expect(s.timers.neg?.status).toBe('paused');
    expect(s.timers.neg?.remainingMs).toBe(40_000);
  });

  it('dual 环节发言方用尽后自动把发言权交给对方', () => {
    const { engine, clock } = makeEngine();
    engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
    engine.command({ type: 'start' });
    engine.command({ type: 'nextStage' });
    engine.command({ type: 'nextStage' }); // 自由辩论 60s
    engine.command({ type: 'switchSpeaker' }); // 切到反方
    clock.advance(60_001);
    engine.tick(clock.now());
    const s = engine.snapshot();
    expect(s.activeSpeaker).toBe('aff'); // 反方耗尽，正方接力
    expect(s.timers.neg?.status).toBe('expired');
    expect(s.timers.aff?.status).toBe('running');
  });

  it('受保护方接麦不计时（保护时间）', () => {
    const { engine, clock } = makeEngine();
    engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
    // 构造保护场景：自由辩论（index 2）中反方受保护
    const raw = engine as unknown as {
      state: { stages: { protectedSide: string | null }[] };
    };
    raw.state.stages[2].protectedSide = 'neg';

    engine.command({ type: 'start' });
    engine.command({ type: 'nextStage' });
    engine.command({ type: 'nextStage' }); // 自由辩论，正方先发言
    let s = engine.snapshot();
    expect(s.activeSpeaker).toBe('aff');
    expect(s.timers.aff?.status).toBe('running');

    clock.advance(10_000);
    expect(engine.command({ type: 'switchSpeaker' }).ok).toBe(true);
    s = engine.snapshot();
    expect(s.activeSpeaker).toBe('neg'); // 接麦
    expect(s.timers.neg?.status).toBe('idle'); // 但计时器不启动——发言不消耗时间

    clock.advance(30_000);
    s = engine.snapshot();
    expect(s.timers.neg?.remainingMs).toBe(60_000); // 受保护方时间纹丝不动

    expect(engine.command({ type: 'switchSpeaker' }).ok).toBe(true); // 切回正方恢复计时
    s = engine.snapshot();
    expect(s.timers.aff?.status).toBe('running');
    expect(s.timers.aff?.remainingMs).toBe(50_000);
  });

  it('暂停期间墙钟流逝不消耗剩余时间（多端同步基础）', () => {
    const { engine, clock } = makeEngine();
    engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
    engine.command({ type: 'start' });
    clock.advance(10_000);
    engine.command({ type: 'pause' });
    clock.advance(120_000); // 暂停了 2 分钟
    engine.command({ type: 'resume' });
    const s = engine.snapshot();
    expect(s.timers.aff?.targetEndTime).toBe(clock.now() + 20_000); // 30s - 10s
    expect(remainingOf(s.timers.aff!, clock.now())).toBe(20_000);
  });

  it('预警阈值只触发一次', () => {
    const { engine, clock, events } = makeEngine();
    engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
    engine.command({ type: 'start' }); // 30s 环节，阈值 [30, 10]
    // 开始瞬间 remaining=30s 即命中 30 阈值
    engine.tick(clock.now());
    clock.advance(500);
    engine.tick(clock.now());
    clock.advance(20_000);
    engine.tick(clock.now()); // 剩 ~9.5s 命中 10
    clock.advance(500);
    engine.tick(clock.now());
    const warns = events.filter((e) => (e as { type: string }).type === 'warn');
    expect(warns.length).toBe(2); // 30s 与 10s 各一次，不重复
  });

  it('switchSpeaker 在非 dual 环节被拒绝', () => {
    const { engine } = makeEngine();
    engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
    engine.command({ type: 'start' }); // single 环节
    expect(engine.command({ type: 'switchSpeaker' }).ok).toBe(false);
  });

  it('评分刻度越界拒绝，重复提交覆盖（以最后一次为准）', () => {
    const { engine } = makeEngine();
    engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
    const join = engine.joinJudge('张三', engine.snapshot().config.entryCode);
    expect(join.ok).toBe(true);
    const judgeId = join.judge!.id;
    const stageId = engine.snapshot().stages[0].id;

    expect(engine.submitScore(judgeId, stageId, 'aff', 500).ok).toBe(false); // 越界
    expect(engine.submitScore(judgeId, stageId, 'aff', 80).ok).toBe(true);
    expect(engine.submitScore(judgeId, stageId, 'aff', 95).ok).toBe(true);
    expect(engine.snapshot().scoreProgress).toContain(judgeId);
  });

  it('reset 任意状态可用，重置为全新比赛（新入场码、回到 idle）', () => {
    const { engine } = makeEngine();
    engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
    engine.command({ type: 'start' });
    engine.command({ type: 'pause' });
    const before = engine.snapshot();
    const join = engine.joinJudge('张三', before.config.entryCode);

    expect(engine.command({ type: 'reset' }).ok).toBe(true);
    const s = engine.snapshot();
    expect(s.status).toBe('idle');
    expect(s.stages).toHaveLength(0);
    expect(s.currentStageIndex).toBe(-1);
    expect(s.scoreProgress).toHaveLength(0);
    expect(s.config.entryCode).not.toBe(before.config.entryCode); // 新入场码
    expect(engine.joinJudge('张三', before.config.entryCode).ok).toBe(false); // 旧码失效
    expect(engine.submitScore(join.judge!.id, 'x', 'aff', 50).ok).toBe(false); // 旧评委失效
  });
});

describe('countUp 正计时', () => {
  /** 把快速赛制的第 1 个环节改成正计时 */
  function asCountUp(engine: GameEngine): void {
    const raw = engine as unknown as { state: { stages: { timerKind: string }[] } };
    raw.state.stages[0].timerKind = 'countUp';
  }

  it('未启动时不显示总时长；运行中按已耗递增且不自动结束', () => {
    const { engine, clock } = makeEngine();
    engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
    asCountUp(engine);
    engine.command({ type: 'start' }); // 环节 0 改成 30s 正计时
    let s = engine.snapshot();
    expect(s.timers.aff?.remainingMs).toBe(0); // 已耗从 0 起，而不是总时长
    expect(s.timers.aff?.startedAt).toBe(clock.now());

    clock.advance(45_000); // 超过原定 30s
    s = engine.snapshot();
    expect(remainingOf(s.timers.aff!, clock.now())).toBe(45_000);
    engine.tick(clock.now());
    expect(engine.snapshot().currentStageIndex).toBe(0); // 正计时不自动推进
  });

  it('暂停后恢复从已耗处接着走，绝不把已计时的时间清零', () => {
    const { engine, clock } = makeEngine();
    engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
    asCountUp(engine);
    engine.command({ type: 'start' });
    clock.advance(40_000);
    expect(engine.command({ type: 'pause' }).ok).toBe(true);

    let s = engine.snapshot();
    expect(s.timers.aff?.remainingMs).toBe(40_000); // 固化的是已耗
    expect(s.timers.aff?.startedAt).toBeNull();

    clock.advance(10_000); // 暂停期间不增长
    expect(engine.command({ type: 'resume' }).ok).toBe(true);
    s = engine.snapshot();
    expect(s.timers.aff?.startedAt).toBe(clock.now() - 40_000); // 续跑锚点
    expect(remainingOf(s.timers.aff!, clock.now())).toBe(40_000);

    clock.advance(5_000);
    expect(remainingOf(engine.snapshot().timers.aff!, clock.now())).toBe(45_000); // 40s + 5s，而非归零
  });
});

describe('指令入口兜底', () => {
  it('未知指令返回失败，而不是抛异常或返回 undefined', () => {
    const { engine } = makeEngine();
    const result = engine.command({ type: 'nope' } as unknown as MatchCommand);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('未知指令');
  });

  it('畸形 payload（null / undefined / 缺 type）同样返回失败', () => {
    const { engine } = makeEngine();
    expect(engine.command(null as unknown as MatchCommand).ok).toBe(false);
    expect(engine.command(undefined as unknown as MatchCommand).ok).toBe(false);
    expect(engine.command({} as unknown as MatchCommand).ok).toBe(false);
  });
});
