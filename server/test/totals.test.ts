/**
 * 加权总分与胜负判定用例
 *
 * 口径：每个环节先对**所有评委**取平均，再乘环节权重求和。
 * 这里同时守住一条硬约束——汇总里绝不能出现单个评委的分数。
 */
import { describe, expect, it } from 'vitest';
import { GameEngine } from '../src/game/engine.js';

function makeEngine() {
  let t = 1_000_000;
  const engine = new GameEngine({ now: () => t, onEvent: () => {} });
  return {
    engine,
    advance(ms: number) {
      t += ms;
    },
  };
}

/** 快速赛制第 1/2 环节权重都设为 2，便于验证“平均 × 权重” */
function setup() {
  const { engine, advance } = makeEngine();
  engine.command({ type: 'loadTemplate', templateId: 'quick-test' });
  const raw = engine as unknown as { state: { stages: { weight: number }[] } };
  raw.state.stages[0].weight = 2;
  raw.state.stages[1].weight = 2;

  const code = engine.snapshot().config.entryCode;
  const judgeA = engine.joinJudge('评委甲', code).judge!.id;
  const judgeB = engine.joinJudge('评委乙', code).judge!.id;
  const stages = engine.snapshot().stages;
  return { engine, advance, judgeA, judgeB, affStage: stages[0].id, negStage: stages[1].id };
}

describe('加权总分与胜负', () => {
  it('未公布时快照里没有任何分数内容', () => {
    const { engine, judgeA, affStage } = setup();
    engine.submitScore(judgeA, affStage, 'aff', 90);
    const snap = engine.snapshot();
    expect(snap.published).toBeNull();
    expect(JSON.stringify(snap)).not.toContain('"value"'); // 单条评分不得出现在广播里
  });

  it('公布后按「评委取平均 × 环节权重」给出总分与胜方', () => {
    const { engine, judgeA, judgeB, affStage, negStage } = setup();
    engine.submitScore(judgeA, affStage, 'aff', 80);
    engine.submitScore(judgeB, affStage, 'aff', 90); // 平均 85 × 权重 2 = 170
    engine.submitScore(judgeA, negStage, 'neg', 70); // 平均 70 × 权重 2 = 140

    engine.command({ type: 'publishScores' });
    const p = engine.snapshot().published!;
    expect(p.basis).toBe('weighted');
    expect(p.aff.weighted).toBe(170);
    expect(p.neg.weighted).toBe(140);
    expect(p.aff.scoredStages).toBe(1);
    expect(p.neg.scoredStages).toBe(1);
    expect(p.judgeCount).toBe(2);
    expect(p.winner).toBe('aff');
  });

  it('未评分的环节不计入，也不按 0 分惩罚', () => {
    const { engine, judgeA, affStage } = setup();
    engine.submitScore(judgeA, affStage, 'aff', 60);
    engine.command({ type: 'publishScores' });
    const p = engine.snapshot().published!;
    expect(p.aff.scoredStages).toBe(1); // 共 5 个环节，只有 1 个有分
    expect(p.aff.weighted).toBe(120); // 60 × 2，其余环节不吃亏
    expect(p.neg.weighted).toBe(0);
  });

  it('同一评委改分以最后一次为准（upsert）', () => {
    const { engine, judgeA, affStage } = setup();
    engine.submitScore(judgeA, affStage, 'aff', 50);
    engine.submitScore(judgeA, affStage, 'aff', 90);
    engine.command({ type: 'publishScores' });
    expect(engine.snapshot().published!.aff.weighted).toBe(180); // 90 × 2
  });

  it('双方同分时 winner 为 null（平局）', () => {
    const { engine, judgeA, judgeB, affStage, negStage } = setup();
    engine.submitScore(judgeA, affStage, 'aff', 80);
    engine.submitScore(judgeB, affStage, 'aff', 90); // 85 × 2 = 170
    engine.submitScore(judgeA, negStage, 'neg', 80);
    engine.submitScore(judgeB, negStage, 'neg', 90); // 85 × 2 = 170
    engine.command({ type: 'publishScores' });
    const p = engine.snapshot().published!;
    expect(p.aff.weighted).toBe(170);
    expect(p.neg.weighted).toBe(170);
    expect(p.winner).toBeNull();
  });

  it('汇总结构固定，且整体不含任何单个评委的分数', () => {
    const { engine, judgeA, affStage } = setup();
    engine.submitScore(judgeA, affStage, 'aff', 88);
    engine.command({ type: 'publishScores' });
    const p = engine.snapshot().published!;
    expect(Object.keys(p).sort()).toEqual(['aff', 'basis', 'judgeCount', 'neg', 'winner']);
    expect(Object.keys(p.aff).sort()).toEqual(['scoredStages', 'weighted']);
    const wire = JSON.stringify(engine.snapshot());
    expect(wire).not.toContain('judgeId');
    expect(wire).not.toContain('"value"');
  });

  it('reset 后总分清空，旧场评分不残留', () => {
    const { engine, judgeA, affStage } = setup();
    engine.submitScore(judgeA, affStage, 'aff', 88);
    engine.command({ type: 'publishScores' });
    expect(engine.computeTotals().aff.weighted).toBe(176);
    engine.command({ type: 'reset' });
    expect(engine.snapshot().published).toBeNull(); // 新场默认未公布
    expect(engine.computeTotals().aff.weighted).toBe(0);
  });
});
