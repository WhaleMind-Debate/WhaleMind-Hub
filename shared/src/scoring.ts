/**
 * 成绩汇总（纯函数，前后端与服务端导出共用）
 *
 * 口径（唯一权威，引擎与赛后导出都走这里，避免两套算法算出差值）：
 *   weighted(side) = Σ_环节( avg_该环节该方所有评委分数 × 环节权重 )
 * - 只统计至少有一份评分的环节；未评分环节不计入，也不按 0 分惩罚；
 * - 返回值永远是汇总，**不含任何单个评委的分数**；
 * - 平局（两侧加权总分相等）时 winner 为 null。
 */
import type { PublishedScores, Side, SideTotals, StageConfig } from './types/debate.js';

/** 参与汇总的最小评分形状（Score 结构上满足它） */
export interface ScorableScore {
  judgeId: string;
  stageId: string;
  side: Side;
  value: number;
}

const SIDES: Side[] = ['aff', 'neg'];
const round2 = (v: number): number => Math.round(v * 100) / 100;

export function aggregateScores(stages: StageConfig[], scores: ScorableScore[]): PublishedScores {
  const perSide: Record<Side, SideTotals> = {
    aff: { weighted: 0, scoredStages: 0 },
    neg: { weighted: 0, scoredStages: 0 },
  };

  for (const side of SIDES) {
    let weighted = 0;
    let scoredStages = 0;
    for (const stage of stages) {
      const values: number[] = [];
      for (const score of scores) {
        if (score.stageId === stage.id && score.side === side) values.push(score.value);
      }
      if (values.length === 0) continue;
      const average = values.reduce((a, b) => a + b, 0) / values.length;
      weighted += average * stage.weight;
      scoredStages += 1;
    }
    perSide[side] = { weighted: round2(weighted), scoredStages };
  }

  const judgeCount = new Set(scores.map((s) => s.judgeId)).size;
  let winner: Side | null = null;
  if (perSide.aff.weighted !== perSide.neg.weighted) {
    winner = perSide.aff.weighted > perSide.neg.weighted ? 'aff' : 'neg';
  }
  return { aff: perSide.aff, neg: perSide.neg, judgeCount, winner, basis: 'weighted' };
}

/** 单个环节的双方平均分（赛后报告的分环节明细用） */
export interface StageBreakdownRow {
  stageId: string;
  order: number;
  name: string;
  weight: number;
  aff: number | null;
  neg: number | null;
  affJudges: number;
  negJudges: number;
}

export function stageBreakdown(stages: StageConfig[], scores: ScorableScore[]): StageBreakdownRow[] {
  return stages.map((stage) => {
    const avgOf = (side: Side): { avg: number | null; judges: number } => {
      const values = scores.filter((s) => s.stageId === stage.id && s.side === side).map((s) => s.value);
      if (values.length === 0) return { avg: null, judges: 0 };
      return { avg: round2(values.reduce((a, b) => a + b, 0) / values.length), judges: values.length };
    };
    const aff = avgOf('aff');
    const neg = avgOf('neg');
    return {
      stageId: stage.id,
      order: stage.order,
      name: stage.name,
      weight: stage.weight,
      aff: aff.avg,
      neg: neg.avg,
      affJudges: aff.judges,
      negJudges: neg.judges,
    };
  });
}
