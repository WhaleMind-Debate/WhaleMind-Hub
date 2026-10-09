/**
 * 内置赛制模板（前后端共享）
 * 服务端 loadTemplate 以此为权威数据源，客户端用它展示模板名称。
 */
import type { StageTemplate } from './types/debate.js';

const WARN = [30, 10];

function stage(
  order: number,
  name: string,
  side: StageTemplate['stages'][number]['side'],
  durationSec: number,
  extra: Partial<StageTemplate['stages'][number]> = {},
): StageTemplate['stages'][number] {
  return {
    order,
    name,
    type: extra.type ?? 'single',
    timerKind: extra.timerKind ?? 'countdown',
    side,
    protectedSide: extra.protectedSide ?? null,
    durationMs: durationSec * 1000,
    warnThresholds: extra.warnThresholds ?? WARN,
    weight: extra.weight ?? 1,
    soundId: extra.soundId ?? 'bell',
    description: extra.description ?? null,
    speakerName: extra.speakerName ?? null,
  };
}

export const TEMPLATES: StageTemplate[] = [
  {
    id: 'standard-3v3',
    name: '标准三人赛制（含自由辩论）',
    description: '立论 / 驳论 / 质询 / 自由辩论 / 总结，共 9 个环节',
    stages: [
      stage(1, '正方一辩立论', 'aff', 180),
      stage(2, '反方一辩立论', 'neg', 180),
      stage(3, '正方二辩驳论', 'aff', 120),
      stage(4, '反方二辩驳论', 'neg', 120),
      stage(5, '正方三辩质询', 'aff', 120, {
        description: '被质询方受保护，发言不计时',
      }),
      stage(6, '反方三辩质询', 'neg', 120, {
        description: '被质询方受保护，发言不计时',
      }),
      stage(7, '自由辩论', null, 240, {
        type: 'dual_alternating',
        description: '正反方交替计时，同一时刻仅一方消耗时间',
      }),
      stage(8, '反方四辩总结陈词', 'neg', 180),
      stage(9, '正方四辩总结陈词', 'aff', 180),
    ],
  },
  {
    id: 'quick-test',
    name: '快速测试赛制',
    description: '立论 / 自由辩论 / 总结，用于联调验证',
    stages: [
      stage(1, '正方立论', 'aff', 30),
      stage(2, '反方立论', 'neg', 30),
      stage(3, '自由辩论', null, 60, { type: 'dual_alternating' }),
      stage(4, '反方总结', 'neg', 30),
      stage(5, '正方总结', 'aff', 30),
    ],
  },
];

export function findTemplate(id: string): StageTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
