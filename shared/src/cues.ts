/**
 * 提示音音色定义（纯数据，前后端共享）
 *
 * 这里只描述“响什么”，不含任何发声实现——真正的合成在客户端 useStageAudio 里
 * 用 WebAudio 振荡器完成。这样拆分是为了：数据可单测、音色可被服务端/文档复用。
 *
 * 全部音色由振荡器实时合成，不依赖任何音频文件：离线可用、零体积、无版权问题。
 */

export const BUILTIN_SOUND_IDS = ['bell', 'electronic', 'chime'] as const;
export type BuiltinSoundId = (typeof BUILTIN_SOUND_IDS)[number];

/** 一个音符：相对触发时刻的延迟、频率、包络与波形 */
export interface ToneSpec {
  /** 起始频率（Hz） */
  freq: number;
  /** 频率滑到（Hz），省略则不滑动 */
  sweepTo?: number;
  /** 波形 */
  type: 'sine' | 'square' | 'sawtooth' | 'triangle';
  /** 相对当前时刻的延迟（秒） */
  delay: number;
  /** 持续时长（秒） */
  duration: number;
  /** 峰值增益（0~1） */
  gain: number;
}

/** 内置音色表：与环节配置 StageConfig.soundId 对应 */
export const CUES: Record<BuiltinSoundId, ToneSpec[]> = {
  // 钟声：基频 + 五度泛音 + 低频体感，长衰减
  bell: [
    { freq: 880, type: 'sine', delay: 0, duration: 1.4, gain: 0.5 },
    { freq: 1320, type: 'sine', delay: 0.005, duration: 1.1, gain: 0.22 },
    { freq: 440, type: 'sine', delay: 0, duration: 1.6, gain: 0.16 },
  ],
  // 电子提示：两声短促方波，穿透现场噪音
  electronic: [
    { freq: 1046, type: 'square', delay: 0, duration: 0.14, gain: 0.28 },
    { freq: 1318, type: 'square', delay: 0.18, duration: 0.16, gain: 0.28 },
  ],
  // 风铃：三角波上行琶音，收尾柔和
  chime: [
    { freq: 659, type: 'triangle', delay: 0, duration: 0.5, gain: 0.3 },
    { freq: 880, type: 'triangle', delay: 0.12, duration: 0.5, gain: 0.3 },
    { freq: 1318, type: 'triangle', delay: 0.24, duration: 0.7, gain: 0.26 },
  ],
};

/** 未知或空的 soundId 一律回退为 bell，绝不静默失败 */
export function resolveSoundId(soundId: string | null | undefined): BuiltinSoundId {
  return (BUILTIN_SOUND_IDS as readonly string[]).includes(soundId ?? '')
    ? (soundId as BuiltinSoundId)
    : 'bell';
}

/** 取某个 soundId 对应的音符序列 */
export function cueFor(soundId: string | null | undefined): ToneSpec[] {
  return CUES[resolveSoundId(soundId)];
}

/** 一次提示音的总时长（秒），用于校验它不会压过下一个环节 */
export function cueDurationSec(soundId: string | null | undefined): number {
  return cueFor(soundId).reduce((max, t) => Math.max(max, t.delay + t.duration), 0);
}
