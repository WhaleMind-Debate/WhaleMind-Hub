/**
 * 主帧时钟（useMasterClock）
 *
 * 权威时间法则的客户端实现：
 * - 全应用共用一个 requestAnimationFrame 循环驱动 tick 响应式变量；
 * - 组件模板用 tick 让每帧重算 targetEndTime - now，绝不 setInterval 数字加减；
 * - 页面切后台 rAF 冻结，回前台后第一帧立即用 targetEndTime 重算，时间零漂移。
 */
import { onScopeDispose, ref, type Ref } from 'vue';
import { useDebateStore } from '@/stores/debateStore';

let rafId: number | null = null;
const listeners = new Set<() => void>();
/** 全局单例 tick：值本身只是“刷新触发器”，真实时间经 debateStore.syncedNow() 取 */
const tick: Ref<number> = ref(0);

function loop() {
  tick.value++;
  for (const fn of listeners) fn();
  rafId = requestAnimationFrame(loop);
}

function ensureLoop() {
  if (rafId == null && typeof requestAnimationFrame === 'function') {
    rafId = requestAnimationFrame(loop);
  }
}

/** 在组件作用域内订阅主帧时钟；返回当前同步时刻的响应式值 */
export function useMasterClock(): {
  tick: Ref<number>;
  now: () => number;
  remainingOf: (timer: import('@/types/debate').TimerState | undefined) => number;
} {
  const store = useDebateStore();
  ensureLoop();

  const onFrame = () => {
    /* tick.value 已触发响应式，组件重渲染时调用 now()/remainingOf() */
  };
  listeners.add(onFrame);
  onScopeDispose(() => listeners.delete(onFrame));

  return {
    tick,
    now: () => store.syncedNow(),
    remainingOf: (timer) => store.remainingOf(timer, store.syncedNow()),
  };
}

/** 毫秒格式化为 mm:ss（大屏/控制台共用） */
export function formatMs(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
