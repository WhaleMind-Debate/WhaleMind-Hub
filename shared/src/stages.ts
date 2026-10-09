/**
 * 环节序列校验与归一化（纯函数）
 *
 * 服务端是唯一权威：前端表单校验只做体验优化，任何要落地的环节序列都必须先过这一关。
 * 输入来自 Socket（JSON），因此按 unknown 处理——不信任任何字段的类型与取值。
 *
 * 归一化保证的“脏值不进库”：
 * - name/description 去首尾空白，空说明归为 null；
 * - 单方环节强制 protectedSide = null（引擎对 single 忽略该字段，留着只会误导）；
 * - 自由辩论强制 side = null；
 * - 预警阈值去重、降序、限个数；
 * - 未知音色直接拒绝而不是静默回退，避免主席选了“没声音”却不知道。
 */
import { BUILTIN_SOUND_IDS } from './cues.js';
import type { Side, StageInput } from './types/debate.js';

export const STAGE_LIMITS = {
  /** 环节数上限：超长赛制在控制台已无法有效操作，也没必要 */
  maxStages: 40,
  minDurationSec: 5,
  maxDurationSec: 3600,
  minWeight: 0.1,
  maxWeight: 100,
  maxWarnThresholds: 6,
  maxNameLength: 60,
  maxDescriptionLength: 200,
  maxSpeakerNameLength: 20,
} as const;

export type StageValidationResult = { ok: true; stages: StageInput[] } | { ok: false; error: string };

const fail = (error: string): StageValidationResult => ({ ok: false, error });

function normalizeSide(value: unknown): Side | null {
  return value === 'aff' || value === 'neg' ? value : null;
}

function toFiniteNumber(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** 预警阈值：正整数、去重、降序（大阈值先触发），非法则返回 null */
function normalizeThresholds(value: unknown): number[] | null {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  const out: number[] = [];
  for (const item of value) {
    const n = toFiniteNumber(item);
    if (n == null || !Number.isInteger(n) || n <= 0) return null;
    if (!out.includes(n)) out.push(n);
  }
  if (out.length > STAGE_LIMITS.maxWarnThresholds) return null;
  return out.sort((a, b) => b - a);
}

/** 音色：空值归 null；必须是内置音色，未知返回 undefined 表示非法 */
function normalizeSoundId(value: unknown): string | null | undefined {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  return (BUILTIN_SOUND_IDS as readonly string[]).includes(value) ? value : undefined;
}

export function validateStages(input: unknown): StageValidationResult {
  if (!Array.isArray(input)) return fail('环节列表格式不正确');
  if (input.length > STAGE_LIMITS.maxStages) return fail(`环节数不能超过 ${STAGE_LIMITS.maxStages} 个`);

  const stages: StageInput[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const raw = input[index] as Record<string, unknown> | null | undefined;
    const label = `第 ${index + 1} 个环节`;
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return fail(`${label}格式不正确`);

    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) return fail(`${label}缺少名称`);
    if (name.length > STAGE_LIMITS.maxNameLength) {
      return fail(`${label}名称不能超过 ${STAGE_LIMITS.maxNameLength} 个字`);
    }

    const type = raw.type;
    if (type !== 'single' && type !== 'dual_alternating') return fail(`${label}的环节类型不合法`);
    const timerKind = raw.timerKind;
    if (timerKind !== 'countdown' && timerKind !== 'countUp') return fail(`${label}的计时方式不合法`);

    const side = normalizeSide(raw.side);
    if (type === 'single' && side == null) return fail(`${label}是单方环节，必须指定归属方`);
    if (type === 'dual_alternating' && side != null) return fail(`${label}是自由辩论，不应指定归属方`);

    const durationSec = toFiniteNumber(
      typeof raw.durationMs === 'number' ? raw.durationMs / 1000 : raw.durationMs,
    );
    if (durationSec == null) return fail(`${label}缺少时长`);
    if (
      durationSec < STAGE_LIMITS.minDurationSec ||
      durationSec > STAGE_LIMITS.maxDurationSec
    ) {
      return fail(`${label}时长需在 ${STAGE_LIMITS.minDurationSec}~${STAGE_LIMITS.maxDurationSec} 秒之间`);
    }

    const weight = toFiniteNumber(raw.weight);
    if (weight == null || weight < STAGE_LIMITS.minWeight || weight > STAGE_LIMITS.maxWeight) {
      return fail(`${label}权重需在 ${STAGE_LIMITS.minWeight}~${STAGE_LIMITS.maxWeight} 之间`);
    }

    const warnThresholds = normalizeThresholds(raw.warnThresholds);
    if (warnThresholds == null) {
      return fail(`${label}的预警阈值不合法（最多 ${STAGE_LIMITS.maxWarnThresholds} 个正整数秒数）`);
    }

    const soundId = normalizeSoundId(raw.soundId);
    if (soundId === undefined) return fail(`${label}的提示音不在内置音色表内`);

    const descriptionRaw = typeof raw.description === 'string' ? raw.description.trim() : '';
    if (descriptionRaw.length > STAGE_LIMITS.maxDescriptionLength) {
      return fail(`${label}的说明不能超过 ${STAGE_LIMITS.maxDescriptionLength} 个字`);
    }

    // 单向环节绑定发言人（自由辩恒为 null，发言人由名单轮换/手动指定实时推）
    let speakerName: string | null = null;
    if (type === 'single' && typeof raw.speakerName === 'string' && raw.speakerName.trim() !== '') {
      const sn = raw.speakerName.trim();
      if (sn.length > STAGE_LIMITS.maxSpeakerNameLength) {
        return fail(`${label}的发言人不能超过 ${STAGE_LIMITS.maxSpeakerNameLength} 个字`);
      }
      speakerName = sn;
    }

    stages.push({
      id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : undefined,
      name,
      type,
      timerKind,
      side,
      // 保护时间只在自由辩论里生效，单方环节统一归一为 null
      protectedSide: type === 'dual_alternating' ? normalizeSide(raw.protectedSide) : null,
      durationMs: Math.round(durationSec * 1000),
      warnThresholds,
      weight,
      soundId,
      description: descriptionRaw === '' ? null : descriptionRaw,
      speakerName,
    });
  }

  return { ok: true, stages };
}

/** 校验自定义模板的名称（模板库 CRUD 用） */
export function validateTemplateMeta(input: unknown): { ok: true; name: string; description: string } | { ok: false; error: string } {
  const raw = input as { name?: unknown; description?: unknown } | null | undefined;
  const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
  if (!name) return { ok: false, error: '模板名称不能为空' };
  if (name.length > STAGE_LIMITS.maxNameLength) {
    return { ok: false, error: `模板名称不能超过 ${STAGE_LIMITS.maxNameLength} 个字` };
  }
  const description = typeof raw?.description === 'string' ? raw.description.trim() : '';
  if (description.length > STAGE_LIMITS.maxDescriptionLength) {
    return { ok: false, error: `模板说明不能超过 ${STAGE_LIMITS.maxDescriptionLength} 个字` };
  }
  return { ok: true, name, description };
}
