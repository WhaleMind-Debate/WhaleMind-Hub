/**
 * 环节草稿模型
 *
 * 为什么要有一层草稿：编辑器需要“改到一半还能取消”，而比赛状态必须留在 Pinia（规范三.2）。
 * 因此草稿只是**表单态**，与 store 里的比赛状态严格分开：
 * 编辑 → 草稿；点保存 → setStages 指令 → 服务端权威校验 → 广播回 store。
 *
 * key 与 id 的区别：
 * - key：仅前端使用的稳定行标识，供 Arco Table 的 row-key 与拖拽排序使用；
 * - id：服务端环节 id。**修改既有环节必须原样带回 id**，否则已提交的评分会与环节脱钩；
 *   新增环节没有 id，由服务端分配。
 */
import type { Side, StageConfig, StageInput, StageType, TimerKind } from '@/types/debate';

export interface StageDraft extends StageInput {
  /** 前端行标识（稳定不变），不参与提交 */
  key: string;
}

let localSeq = 0;
export function nextDraftKey(): string {
  localSeq += 1;
  return `draft-${localSeq}`;
}

/** 由服务端环节生成草稿 */
export function draftFromStage(stage: StageConfig): StageDraft {
  return {
    key: stage.id,
    id: stage.id,
    name: stage.name,
    type: stage.type,
    timerKind: stage.timerKind,
    side: stage.side,
    protectedSide: stage.protectedSide,
    durationMs: stage.durationMs,
    warnThresholds: [...stage.warnThresholds],
    weight: stage.weight,
    soundId: stage.soundId,
    description: stage.description,
  };
}

/** 新建环节的默认值：30 秒正方立论，最常用的形态 */
export function blankDraft(): StageDraft {
  return {
    key: nextDraftKey(),
    name: '',
    type: 'single',
    timerKind: 'countdown',
    side: 'aff',
    protectedSide: null,
    durationMs: 30_000,
    warnThresholds: [10],
    weight: 1,
    soundId: 'bell',
    description: null,
  };
}

/** 提交给服务端：剥掉本地 key */
export function draftToInput(draft: StageDraft): StageInput {
  const { key: _key, ...input } = draft;
  void _key;
  return input;
}

export function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const SIDE_LABEL: Record<Side, string> = { aff: '正方', neg: '反方' };

/** 表格里的一句话类型描述 */
export function describeType(draft: Pick<StageDraft, 'type' | 'side' | 'timerKind'>): string {
  if (draft.type === 'dual_alternating') return '自由辩论（交替）';
  const side = draft.side ? SIDE_LABEL[draft.side] : '未指定';
  return `单方计时 · ${side}`;
}

export function sideLabel(side: Side | null): string {
  return side ? SIDE_LABEL[side] : '—';
}

export type { Side, StageType, TimerKind };
