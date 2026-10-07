/**
 * 提示音音色定义用例
 * 音色是纯数据，这里校验它的合法性——现场响不出来比响错更糟。
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_SOUND_IDS, CUES, cueDurationSec, cueFor, resolveSoundId } from '@debate/shared';

describe('提示音音色', () => {
  it('未知 / 空 soundId 回退为 bell，绝不静默失败', () => {
    expect(resolveSoundId(null)).toBe('bell');
    expect(resolveSoundId(undefined)).toBe('bell');
    expect(resolveSoundId('')).toBe('bell');
    expect(resolveSoundId('trumpet')).toBe('bell');
    expect(resolveSoundId('chime')).toBe('chime');
  });

  it('每个内置音色都有音符，且频率/时长/增益均合法', () => {
    for (const id of BUILTIN_SOUND_IDS) {
      const cue = cueFor(id);
      expect(cue.length).toBeGreaterThan(0);
      for (const tone of cue) {
        expect(tone.freq).toBeGreaterThan(0);
        expect(tone.duration).toBeGreaterThan(0);
        expect(tone.delay).toBeGreaterThanOrEqual(0);
        expect(tone.gain).toBeGreaterThan(0);
        expect(tone.gain).toBeLessThanOrEqual(1);
      }
    }
  });

  it('一次提示音不超过 2.5 秒，避免压过下一个环节', () => {
    for (const id of BUILTIN_SOUND_IDS) {
      expect(cueDurationSec(id)).toBeLessThanOrEqual(2.5);
    }
  });

  it('内置音色表与 id 列表一一对应（防止加了 id 忘了音符）', () => {
    expect(Object.keys(CUES).sort()).toEqual([...BUILTIN_SOUND_IDS].sort());
  });
});
