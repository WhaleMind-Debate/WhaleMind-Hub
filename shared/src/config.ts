/**
 * 比赛配置补丁的校验与白名单（纯函数）
 *
 * 为什么必须白名单：setConfig 原先直接做对象合并，客户端可以顺手改 matchId、entryCode ——
 * matchId 一变，落盘行与后续恢复就全乱了；entryCode 一变，已入场的评委就被无声踢掉。
 * 因此这里只放行 UI 真正需要编辑的字段，其余一律忽略。
 */
import type { MatchConfig, ScoreScale, SideDisplay, Speaker } from './types/debate.js';

export const CONFIG_LIMITS = {
  maxNameLength: 40,
  maxTopicLength: 120,
  maxTeamNameLength: 30,
  maxTitleLength: 10,
  maxColorLength: 32,
  maxScore: 1000,
  maxSpeakerPositionLength: 10,
  maxSpeakerNameLength: 20,
  maxSpeakers: 8,
  maxStanceLength: 80,
} as const;

export type ConfigPatchResult =
  | { ok: true; patch: Partial<MatchConfig> }
  | { ok: false; error: string };

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > max) return null;
  return trimmed;
}

/**
 * 两方观点（大屏立场条文案）：允许留空——空表示大屏回退显示辩题，
 * 因此与 text() 不同，空白串归一为 '' 而非拒绝；只有非字符串或超长才报错。
 */
function stanceValue(value: unknown, label: string): { value: string } | { error: string } {
  if (value == null) return { value: '' };
  if (typeof value !== 'string') return { error: `${label}格式不正确` };
  const trimmed = value.trim();
  if (trimmed.length > CONFIG_LIMITS.maxStanceLength) {
    return { error: `${label}不能超过 ${CONFIG_LIMITS.maxStanceLength} 个字` };
  }
  return { value: trimmed };
}

function validateSide(value: unknown, label: string): { value: SideDisplay } | { error: string } {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: `${label}信息格式不正确` };
  }
  const raw = value as Record<string, unknown>;
  const teamName = text(raw.teamName, CONFIG_LIMITS.maxTeamNameLength);
  if (!teamName) return { error: `${label}队名不能为空且不超过 ${CONFIG_LIMITS.maxTeamNameLength} 个字` };
  const title = text(raw.title, CONFIG_LIMITS.maxTitleLength);
  if (!title) return { error: `${label}称谓不能为空且不超过 ${CONFIG_LIMITS.maxTitleLength} 个字` };
  const color = text(raw.color, CONFIG_LIMITS.maxColorLength);
  if (!color) return { error: `${label}主色不能为空` };
  const logoUrl = raw.logoUrl == null || raw.logoUrl === '' ? null : String(raw.logoUrl);

  // 辩手名单（结构化「辩位+姓名」）：可空，自由辩轮换/手动指定发言时取用
  let speakers: Speaker[] = [];
  if (raw.speakers != null) {
    if (!Array.isArray(raw.speakers)) return { error: `${label}辩手名单格式不正确` };
    if (raw.speakers.length > CONFIG_LIMITS.maxSpeakers) {
      return { error: `${label}辩手不能超过 ${CONFIG_LIMITS.maxSpeakers} 位` };
    }
    for (const item of raw.speakers) {
      const entry = item as Record<string, unknown> | null | undefined;
      const position = typeof entry?.position === 'string' ? entry.position.trim() : '';
      const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
      if (!name) return { error: `${label}辩手姓名不能为空` };
      if (name.length > CONFIG_LIMITS.maxSpeakerNameLength) {
        return { error: `${label}辩手姓名不能超过 ${CONFIG_LIMITS.maxSpeakerNameLength} 个字` };
      }
      if (position.length > CONFIG_LIMITS.maxSpeakerPositionLength) {
        return { error: `${label}辩位不能超过 ${CONFIG_LIMITS.maxSpeakerPositionLength} 个字` };
      }
      speakers.push({ position, name });
    }
  }

  return { value: { teamName, title, color, logoUrl, speakers } };
}

function validateScoreScale(value: unknown): { value: ScoreScale } | { error: string } {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: '评分刻度格式不正确' };
  }
  const raw = value as Record<string, unknown>;
  const min = Number(raw.min);
  const max = Number(raw.max);
  const step = Number(raw.step);
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step)) {
    return { error: '评分刻度必须是数字' };
  }
  if (min >= max) return { error: '评分刻度的最低分必须小于最高分' };
  if (step <= 0) return { error: '评分刻度步长必须大于 0' };
  if (max > CONFIG_LIMITS.maxScore) return { error: `最高分不能超过 ${CONFIG_LIMITS.maxScore}` };
  return { value: { min, max, step } };
}

/** 校验并返回可落地的配置补丁；未出现的字段保持原值 */
export function validateConfigPatch(input: unknown): ConfigPatchResult {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '配置格式不正确' };
  }
  const raw = input as Record<string, unknown>;
  const patch: Partial<MatchConfig> = {};

  if ('name' in raw) {
    const name = text(raw.name, CONFIG_LIMITS.maxNameLength);
    if (!name) return { ok: false, error: `比赛名称不能为空且不超过 ${CONFIG_LIMITS.maxNameLength} 个字` };
    patch.name = name;
  }
  if ('topic' in raw) {
    const topic = text(raw.topic, CONFIG_LIMITS.maxTopicLength);
    if (!topic) return { ok: false, error: `辩题不能为空且不超过 ${CONFIG_LIMITS.maxTopicLength} 个字` };
    patch.topic = topic;
  }
  if ('aff' in raw) {
    const aff = validateSide(raw.aff, '正方');
    if ('error' in aff) return { ok: false, error: aff.error };
    patch.aff = aff.value;
  }
  if ('neg' in raw) {
    const neg = validateSide(raw.neg, '反方');
    if ('error' in neg) return { ok: false, error: neg.error };
    patch.neg = neg.value;
  }
  if ('scoreScale' in raw) {
    const scale = validateScoreScale(raw.scoreScale);
    if ('error' in scale) return { ok: false, error: scale.error };
    patch.scoreScale = scale.value;
  }
  if ('scoreVisibility' in raw) {
    if (raw.scoreVisibility !== 'hidden' && raw.scoreVisibility !== 'published') {
      return { ok: false, error: '比分可见性取值不合法' };
    }
    patch.scoreVisibility = raw.scoreVisibility;
  }

  if ('affStance' in raw) {
    const r = stanceValue(raw.affStance, '正方观点');
    if ('error' in r) return { ok: false, error: r.error };
    patch.affStance = r.value;
  }
  if ('negStance' in raw) {
    const r = stanceValue(raw.negStance, '反方观点');
    if ('error' in r) return { ok: false, error: r.error };
    patch.negStance = r.value;
  }

  // matchId / entryCode 刻意不在白名单内：前者决定落盘与恢复，后者是评委准入凭证
  return { ok: true, patch };
}
