/**
 * 大屏提示音（WebAudio 实时合成，音色定义见 shared/src/cues.ts）
 *
 * 为什么必须先交互：浏览器 Autoplay 策略禁止在无用户手势时启动 AudioContext，
 * 直接 new AudioContext() 会停在 suspended、播放无声。因此大屏进入时有一层
 * “点击进入”遮罩：点击即创建/恢复 AudioContext 并起播一个静音脉冲完成解封。
 * 未解锁时 play() 静默跳过，绝不硬播。
 */
import { onScopeDispose, ref, type Ref } from 'vue';
import { cueFor, type ToneSpec } from '@/types/debate';

/** 在给定时刻排布一组音符（抽出来便于替换/扩展发声实现） */
export function scheduleCue(ctx: AudioContext, soundId: string | null | undefined, when = ctx.currentTime): void {
  for (const spec of cueFor(soundId) as ToneSpec[]) {
    const start = when + spec.delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = spec.type;
    osc.frequency.setValueAtTime(spec.freq, start);
    if (spec.sweepTo != null) {
      osc.frequency.exponentialRampToValueAtTime(spec.sweepTo, start + spec.duration);
    }
    // 指数包络：快速起音 + 自然衰减，避免爆音
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(spec.gain, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + spec.duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + spec.duration + 0.05);
  }
}

export interface StageAudio {
  /** 是否已解锁（用户已完成一次交互） */
  unlocked: Ref<boolean>;
  /** 浏览器是否支持 WebAudio */
  supported: Ref<boolean>;
  muted: Ref<boolean>;
  /** 必须在用户手势中调用 */
  unlock: () => Promise<boolean>;
  /** 播放提示音；未解锁或静音时静默跳过 */
  play: (soundId: string | null | undefined) => void;
  toggleMute: () => void;
}

let sharedCtx: AudioContext | null = null;

function ensureContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new Ctor();
  return sharedCtx;
}

export function useStageAudio(): StageAudio {
  const unlocked = ref(false);
  const supported = ref(typeof window !== 'undefined' && ensureContext() != null);
  const muted = ref(false);

  async function unlock(): Promise<boolean> {
    const ctx = ensureContext();
    if (!ctx) {
      supported.value = false;
      return false;
    }
    try {
      if (ctx.state === 'suspended') await ctx.resume();
      // 起播一个听不见的脉冲：部分移动端只有在手势中真正出过声才认为已解封
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      const osc = ctx.createOscillator();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.02);
      unlocked.value = ctx.state === 'running';
      return unlocked.value;
    } catch {
      unlocked.value = false;
      return false;
    }
  }

  function play(soundId: string | null | undefined): void {
    if (muted.value) return;
    const ctx = ensureContext();
    if (!ctx || ctx.state !== 'running') return; // 未解锁：静默跳过
    scheduleCue(ctx, soundId);
  }

  // 页面切后台会被浏览器挂起 AudioContext，回前台需恢复（已有过交互，无需再次手势）
  const onVisibility = (): void => {
    if (document.visibilityState !== 'visible' || !unlocked.value) return;
    const ctx = ensureContext();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }
  onScopeDispose(() => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
  });

  return {
    unlocked,
    supported,
    muted,
    unlock,
    play,
    toggleMute: () => {
      muted.value = !muted.value;
    },
  };
}
