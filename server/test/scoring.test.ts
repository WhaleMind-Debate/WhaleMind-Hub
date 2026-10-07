/**
 * 成绩汇总口径用例（引擎与赛后导出共用这一份实现）
 */
import { describe, expect, it } from 'vitest';
import { aggregateScores, stageBreakdown, type ScorableScore, type Side, type StageConfig } from '@debate/shared';

const stage = (id: string, order: number, weight = 1): StageConfig => ({
  id,
  order,
  name: `环节${order}`,
  type: 'single',
  timerKind: 'countdown',
  side: 'aff',
  protectedSide: null,
  durationMs: 60_000,
  warnThresholds: [30, 10],
  weight,
  soundId: 'bell',
  description: null,
});

const score = (judgeId: string, stageId: string, side: Side, value: number): ScorableScore => ({
  judgeId,
  stageId,
  side,
  value,
});

describe('aggregateScores 加权总分', () => {
  it('先对评委取平均，再乘环节权重', () => {
    const stages = [stage('s1', 1, 2)];
    const scores = [score('j1', 's1', 'aff', 80), score('j2', 's1', 'aff', 90)];
    const totals = aggregateScores(stages, scores);
    expect(totals.aff.weighted).toBe(170); // (80+90)/2 × 2
    expect(totals.aff.scoredStages).toBe(1);
    expect(totals.judgeCount).toBe(2);
    expect(totals.basis).toBe('weighted');
  });

  it('未评分的环节不计入，也不按 0 分惩罚', () => {
    const stages = [stage('s1', 1, 1), stage('s2', 2, 1), stage('s3', 3, 1)];
    const totals = aggregateScores(stages, [score('j1', 's2', 'aff', 60)]);
    expect(totals.aff.weighted).toBe(60);
    expect(totals.aff.scoredStages).toBe(1); // 三个环节只有一个有分
  });

  it('只统计赛制内的环节，且正反方互不串分', () => {
    const stages = [stage('s1', 1, 1)];
    const scores = [
      score('j1', 's1', 'aff', 70),
      score('j1', 'ghost-stage', 'aff', 999), // 该环节不在赛制内（换场残留），必须忽略
      score('j1', 's1', 'neg', 888), // 另一方的分，不得串到正方
    ];
    const totals = aggregateScores(stages, scores);
    expect(totals.aff.weighted).toBe(70);
    expect(totals.neg.weighted).toBe(888);
  });

  it('多环节权重不同时分别加权后求和', () => {
    const stages = [stage('s1', 1, 2), stage('s2', 2, 0.5)];
    const scores = [score('j1', 's1', 'aff', 80), score('j1', 's2', 'aff', 80)];
    expect(aggregateScores(stages, scores).aff.weighted).toBe(200); // 80×2 + 80×0.5
  });

  it('judgeCount 按人去重（同一评委多条评分只算一位）', () => {
    const stages = [stage('s1', 1), stage('s2', 2)];
    const scores = [
      score('j1', 's1', 'aff', 80),
      score('j1', 's2', 'aff', 80),
      score('j2', 's1', 'neg', 80),
    ];
    expect(aggregateScores(stages, scores).judgeCount).toBe(2);
  });

  it('结果保留两位小数', () => {
    const stages = [stage('s1', 1, 1)];
    const scores = [score('j1', 's1', 'aff', 85), score('j2', 's1', 'aff', 86), score('j3', 's1', 'aff', 85)];
    expect(aggregateScores(stages, scores).aff.weighted).toBe(85.33); // 256/3 = 85.333…
  });

  it('双方同分为平局（winner 为 null），不为 0 时判出胜方', () => {
    const stages = [stage('s1', 1)];
    expect(aggregateScores(stages, [score('j1', 's1', 'aff', 90), score('j1', 's1', 'neg', 90)]).winner).toBeNull();
    expect(aggregateScores(stages, [score('j1', 's1', 'aff', 90), score('j1', 's1', 'neg', 80)]).winner).toBe('aff');
    expect(aggregateScores(stages, [score('j1', 's1', 'aff', 80), score('j1', 's1', 'neg', 90)]).winner).toBe('neg');
  });

  it('没有任何评分时为全 0 且平局', () => {
    const totals = aggregateScores([stage('s1', 1)], []);
    expect(totals.aff).toEqual({ weighted: 0, scoredStages: 0 });
    expect(totals.neg).toEqual({ weighted: 0, scoredStages: 0 });
    expect(totals.winner).toBeNull();
    expect(totals.judgeCount).toBe(0);
  });
});

describe('stageBreakdown 分环节明细', () => {
  it('给出双方平均分与参与评委数，未评分环节为 null', () => {
    const stages = [stage('s1', 1, 2), stage('s2', 2, 1)];
    const scores = [
      score('j1', 's1', 'aff', 80),
      score('j2', 's1', 'aff', 90),
      score('j1', 's1', 'neg', 70),
    ];
    const rows = stageBreakdown(stages, scores);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ stageId: 's1', order: 1, weight: 2, aff: 85, neg: 70, affJudges: 2, negJudges: 1 });
    expect(rows[1]).toMatchObject({ stageId: 's2', aff: null, neg: null, affJudges: 0, negJudges: 0 });
  });
});
