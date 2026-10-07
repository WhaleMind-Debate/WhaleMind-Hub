/**
 * 环节校验与 setStages 指令用例
 *
 * 重点守住两条不变量：
 * 1. 脏值不进库（校验在服务端，前端校验只是体验）；
 * 2. **编辑/重排既有环节必须保留 id**——评分按 stageId 关联，换了 id 分数就脱钩。
 */
import { describe, expect, it } from 'vitest';
import { STAGE_LIMITS, validateStages, type StageConfig, type StageInput } from '@debate/shared';
import { GameEngine } from '../src/game/engine.js';

const base = () => ({
  name: '正方一辩立论',
  type: 'single' as const,
  timerKind: 'countdown' as const,
  side: 'aff' as const,
  protectedSide: null,
  durationMs: 180_000,
  warnThresholds: [30, 10],
  weight: 1,
  soundId: 'bell',
  description: null,
});

const toInput = (s: StageConfig): StageInput => ({
  id: s.id,
  name: s.name,
  type: s.type,
  timerKind: s.timerKind,
  side: s.side,
  protectedSide: s.protectedSide,
  durationMs: s.durationMs,
  warnThresholds: [...s.warnThresholds],
  weight: s.weight,
  soundId: s.soundId,
  description: s.description,
});

describe('validateStages 环节校验', () => {
  it('合法输入通过并归一化（去空白、阈值去重降序）', () => {
    const result = validateStages([{ ...base(), name: '  正方一辩立论  ', warnThresholds: [10, 30, 10] }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stages[0].name).toBe('正方一辩立论');
    expect(result.stages[0].warnThresholds).toEqual([30, 10]);
  });

  it('单方环节必须指定归属方；自由辩论不得指定归属方', () => {
    expect(validateStages([{ ...base(), side: null }]).ok).toBe(false);
    expect(validateStages([{ ...base(), type: 'dual_alternating', side: 'aff' }]).ok).toBe(false);
    expect(validateStages([{ ...base(), type: 'dual_alternating', side: null }]).ok).toBe(true);
  });

  it('单方环节的保护时间被归一化为 null（引擎本就不生效，留着只会误导）', () => {
    const result = validateStages([{ ...base(), protectedSide: 'neg' }]);
    expect(result.ok && result.stages[0].protectedSide).toBeNull();
  });

  it('时长与权重越界被拒', () => {
    expect(validateStages([{ ...base(), durationMs: 1_000 }]).ok).toBe(false);
    expect(validateStages([{ ...base(), durationMs: 7_200_000 }]).ok).toBe(false);
    expect(validateStages([{ ...base(), weight: 0 }]).ok).toBe(false);
    expect(validateStages([{ ...base(), weight: 1_000 }]).ok).toBe(false);
  });

  it('未知音色被拒，而不是静默回退成没声音', () => {
    expect(validateStages([{ ...base(), soundId: 'trumpet' }]).ok).toBe(false);
    expect(validateStages([{ ...base(), soundId: null }]).ok).toBe(true);
  });

  it('预警阈值必须是正整数且不超上限，空数组合法', () => {
    expect(validateStages([{ ...base(), warnThresholds: [0] }]).ok).toBe(false);
    expect(validateStages([{ ...base(), warnThresholds: [-5] }]).ok).toBe(false);
    expect(validateStages([{ ...base(), warnThresholds: [1.5] }]).ok).toBe(false);
    expect(validateStages([{ ...base(), warnThresholds: [1, 2, 3, 4, 5, 6, 7] }]).ok).toBe(false);
    expect(validateStages([{ ...base(), warnThresholds: [] }]).ok).toBe(true);
  });

  it('非数组 / 超长序列 / 名称缺失都被拒', () => {
    expect(validateStages(null).ok).toBe(false);
    expect(validateStages('x').ok).toBe(false);
    expect(validateStages([{ ...base(), name: '   ' }]).ok).toBe(false);
    expect(validateStages(Array.from({ length: STAGE_LIMITS.maxStages + 1 }, () => base())).ok).toBe(false);
  });
});

describe('setStages 指令', () => {
  function makeEngine() {
    let t = 1_000_000;
    const engine = new GameEngine({ now: () => t, onEvent: () => {} });
    engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
    return { engine, advance: (ms: number) => { t += ms; } };
  }

  it('开赛前可整段替换，order 按位置重排', () => {
    const { engine } = makeEngine();
    const before = engine.snapshot().stages;
    const ok = engine.command({
      type: 'setStages',
      stages: [toInput(before[1]), toInput(before[0])],
    });
    expect(ok.ok).toBe(true);
    const after = engine.snapshot().stages;
    expect(after).toHaveLength(2);
    expect(after.map((s) => s.order)).toEqual([1, 2]);
    expect(after[0].name).toBe(before[1].name);
  });

  it('保留既有环节 id，新增环节分配新 id', () => {
    const { engine } = makeEngine();
    const before = engine.snapshot().stages;
    engine.command({
      type: 'setStages',
      stages: [
        toInput(before[1]),
        toInput(before[0]),
        { ...base(), name: '新增环节' } as StageInput,
      ],
    });
    const after = engine.snapshot().stages;
    expect(after[0].id).toBe(before[1].id);
    expect(after[1].id).toBe(before[0].id);
    expect(after[2].id).toMatch(/^st-/);
    expect(after[2].id).not.toBe(before[0].id);
  });

  it('重排后已提交的评分仍挂在原环节上（不脱钩）', () => {
    const { engine } = makeEngine();
    const before = engine.snapshot().stages;
    const judgeId = engine.joinJudge('张三', engine.snapshot().config.entryCode).judge!.id;
    expect(engine.submitScore(judgeId, before[0].id, 'aff', 90).ok).toBe(true);

    engine.command({ type: 'setStages', stages: [toInput(before[1]), toInput(before[0])] });
    engine.command({ type: 'publishScores' });

    const published = engine.snapshot().published!;
    expect(published.aff.weighted).toBe(90); // 环节被移到第 2 位，分数依然算在里面
    expect(published.aff.scoredStages).toBe(1);
  });

  it('删除环节后其评分不再计入总分', () => {
    const { engine } = makeEngine();
    const before = engine.snapshot().stages;
    const judgeId = engine.joinJudge('张三', engine.snapshot().config.entryCode).judge!.id;
    engine.submitScore(judgeId, before[0].id, 'aff', 90);
    engine.command({ type: 'setStages', stages: [toInput(before[1])] });
    engine.command({ type: 'publishScores' });
    expect(engine.snapshot().published!.aff.weighted).toBe(0);
  });

  it('开赛后拒绝修改赛制（赛制冻结）', () => {
    const { engine } = makeEngine();
    engine.command({ type: 'start' });
    const result = engine.command({ type: 'setStages', stages: [{ ...base() } as StageInput] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('已开始');
  });

  it('非法输入返回失败，且不改动现有赛制', () => {
    const { engine } = makeEngine();
    const before = engine.snapshot().stages;
    expect(engine.command({ type: 'setStages', stages: [{ ...base(), side: null } as unknown as StageInput] }).ok).toBe(false);
    expect(engine.command({ type: 'setStages', stages: 'nope' as unknown as StageInput[] }).ok).toBe(false);
    expect(engine.snapshot().stages).toEqual(before);
  });

  it('允许清空环节（便于推倒重来），但此时不能开赛', () => {
    const { engine } = makeEngine();
    expect(engine.command({ type: 'setStages', stages: [] }).ok).toBe(true);
    expect(engine.snapshot().stages).toHaveLength(0);
    const start = engine.command({ type: 'start' });
    expect(start.ok).toBe(false);
    expect(start.error).toContain('环节为空');
  });
});
