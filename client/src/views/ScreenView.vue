<script setup lang="ts">
/**
 * 大屏展示端（舞台投屏）
 * 不依赖通用 UI 库：纯 Flex/Grid + 大字号高对比度，预警动效交给 GSAP。
 * - 倒计时每帧从 targetEndTime 反推（useMasterClock），多端绝对同步；
 * - 提示音由 useStageAudio 用 WebAudio 实时合成，进入时须先点击一次解锁 AudioContext
 *   （浏览器 Autoplay 策略：无用户手势不允许起播），未解锁时静默跳过、绝不硬播。
 */
import { computed, onMounted, onScopeDispose, ref } from 'vue';
import gsap from 'gsap';
import type { Side } from '@/types/debate';
import { useDebateStore } from '@/stores/debateStore';
import { useSocket } from '@/composables/useSocket';
import { useMasterClock, formatMs } from '@/composables/useMasterClock';
import { useStageAudio } from '@/composables/useStageAudio';

const store = useDebateStore();
const { connect, onTimerWarn } = useSocket();
const { tick, remainingOf } = useMasterClock();
const audio = useStageAudio();

const currentStage = computed(() => store.currentStage);
const isDual = computed(() => currentStage.value?.type === 'dual_alternating');

/** 预警脉冲的目标元素：自由辩按方取，单向计时只有一个面板 */
const panels: Partial<Record<Side, HTMLElement | null>> = {};
const singlePanel = ref<HTMLElement | null>(null);
function setPanelRef(side: Side, el: unknown): void {
  panels[side] = (el as HTMLElement | null) ?? null;
}
function panelFor(side: Side): HTMLElement | null {
  return isDual.value ? panels[side] ?? null : singlePanel.value;
}

/** 解锁遮罩：未完成一次交互前必须挡住，否则提示音永远无声 */
const gateDismissed = ref(false);
const showGate = computed(() => !gateDismissed.value && !audio.unlocked.value);

async function enterStage(): Promise<void> {
  await audio.unlock();
  gateDismissed.value = true;
}

onMounted(() => {
  connect();
  onTimerWarn((payload) => {
    // 1) 提示音：音色取自当前环节的 soundId；未解锁或已静音时静默跳过
    audio.play(currentStage.value?.soundId);
    // 2) 脉冲：只闪对应一方，避免整屏抖动
    const el = panelFor(payload.side);
    if (!el) return;
    gsap.killTweensOf(el);
    gsap.fromTo(
      el,
      { scale: 1 },
      { scale: 1.05, duration: 0.16, repeat: 3, yoyo: true, ease: 'power2.inOut', transformOrigin: '50% 50%' },
    );
  });
});

onScopeDispose(() => {
  const targets = [singlePanel.value, ...Object.values(panels)].filter((el): el is HTMLElement => el != null);
  gsap.killTweensOf(targets);
});

function timerText(side: Side): string {
  void tick.value;
  const timer = store.timers[side];
  if (!timer) return '--:--';
  return formatMs(remainingOf(timer));
}

function isWarn(side: Side): boolean {
  void tick.value;
  const stage = currentStage.value;
  const timer = store.timers[side];
  if (!stage || !timer || timer.status !== 'running') return false;
  const remainSec = remainingOf(timer) / 1000;
  return stage.warnThresholds.some((t) => remainSec <= t && remainSec > 0);
}
</script>

<template>
  <div class="screen">
    <!-- 音频解锁门：浏览器要求至少一次用户手势才允许出声，未解锁前不播任何声音 -->
    <div v-if="showGate" class="gate">
      <div class="gate-topic">{{ store.config?.topic ?? '辩论赛' }}</div>
      <button class="gate-btn" type="button" @click="enterStage">点击进入大屏</button>
      <div class="gate-hint">点击以解锁提示音（浏览器禁止无交互播放音频）</div>
    </div>

    <!-- 提示音开关 / 支持性提示 -->
    <button
      v-if="!showGate"
      class="audio-chip"
      type="button"
      :title="audio.supported ? '点击切换提示音' : '当前浏览器不支持 WebAudio'"
      @click="audio.toggleMute()"
    >
      {{ !audio.supported ? '🔇 无提示音' : audio.muted ? '🔇 已静音' : '🔔 提示音开' }}
    </button>

    <!-- 辩题 -->
    <header class="topic">
      <div class="topic-text">{{ store.config?.topic ?? '辩论赛' }}</div>
      <div class="match-name">{{ store.config?.name ?? '' }}</div>
    </header>

    <!-- 当前环节 -->
    <section class="stage">
      <template v-if="currentStage">
        <div class="stage-name">{{ currentStage.name }}</div>
        <div class="stage-desc">{{ currentStage.description ?? '' }}</div>
      </template>
      <div v-else class="stage-name">等待开始</div>
    </section>

    <!-- 计时区 -->
    <section class="timers">
      <template v-if="isDual">
        <!-- 自由辩论：正反双方计时并列，发言方高亮 -->
        <div
          v-for="side in (['aff', 'neg'] as Side[])"
          :key="side"
          class="timer-panel"
          :ref="(el) => setPanelRef(side, el)"
          :class="{ active: store.activeSpeaker === side, warn: isWarn(side) }"
          :style="{ borderColor: side === 'aff' ? store.config?.aff.color : store.config?.neg.color }"
        >
          <div class="team">{{ side === 'aff' ? store.config?.aff.teamName : store.config?.neg.teamName }}</div>
          <div class="time">{{ timerText(side) }}</div>
          <div class="speaker-tag">{{ store.activeSpeaker === side ? '发言中' : '' }}</div>
        </div>
      </template>
      <template v-else-if="currentStage && currentStage.side">
        <!-- 单向计时：大字居中 -->
        <div ref="singlePanel" class="timer-single" :class="{ warn: isWarn(currentStage.side) }">
          <div class="team">
            {{ currentStage.side === 'aff' ? store.config?.aff.teamName : store.config?.neg.teamName }}
          </div>
          <div class="time-huge">{{ timerText(currentStage.side) }}</div>
        </div>
      </template>
    </section>

    <!-- 成绩公布：主席点「公布比分」后才出现（未公布时服务端根本不下发分数） -->
    <section v-if="store.published" class="scoreboard">
      <div class="score-side" :class="{ winner: store.published.winner === 'aff' }">
        <div class="score-team">{{ store.config?.aff.teamName }}</div>
        <div class="score-value">{{ store.published.aff.weighted.toFixed(1) }}</div>
      </div>
      <div class="score-mid">
        <div class="score-label">
          {{ store.published.winner === null ? '暂时持平' : store.published.winner === 'aff' ? '正方领先' : '反方领先' }}
        </div>
        <div class="score-sub">
          {{ store.published.judgeCount }} 位评委 · 正 {{ store.published.aff.scoredStages }} / 反
          {{ store.published.neg.scoredStages }} 个环节计分
        </div>
      </div>
      <div class="score-side" :class="{ winner: store.published.winner === 'neg' }">
        <div class="score-team">{{ store.config?.neg.teamName }}</div>
        <div class="score-value">{{ store.published.neg.weighted.toFixed(1) }}</div>
      </div>
    </section>

    <!-- 底部双方对比（队名 + 称谓） -->
    <footer class="compare">
      <div class="side aff" :style="{ color: store.config?.aff.color }">
        {{ store.config?.aff.teamName }}
        <span class="title">{{ store.config?.aff.title }}</span>
      </div>
      <div class="vs">VS</div>
      <div class="side neg" :style="{ color: store.config?.neg.color }">
        {{ store.config?.neg.teamName }}
        <span class="title">{{ store.config?.neg.title }}</span>
      </div>
    </footer>
  </div>
</template>

<style scoped>
/* 大屏基调：深底高对比、大字号 */
.screen {
  height: 100%;
  background: #0b1220;
  color: #f5f7fa;
  display: flex;
  flex-direction: column;
  padding: 3vh 4vw;
  box-sizing: border-box;
}
.topic {
  text-align: center;
}
.topic-text {
  font-size: 4.5vh;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.match-name {
  font-size: 2.2vh;
  color: #94a3b8;
  margin-top: 0.5vh;
}
.stage {
  text-align: center;
  margin: 3vh 0;
}
.stage-name {
  font-size: 5vh;
  font-weight: 600;
}
.stage-desc {
  font-size: 2.2vh;
  color: #94a3b8;
  margin-top: 1vh;
}
.timers {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4vw;
}
.timer-panel {
  flex: 1;
  max-width: 36vw;
  border: 0.5vh solid #334155;
  border-radius: 2vh;
  padding: 3vh;
  text-align: center;
  transition: border-color 0.3s, box-shadow 0.3s;
}
.timer-panel.active {
  box-shadow: 0 0 4vh rgba(52, 211, 153, 0.35);
  border-color: #34d399 !important;
}
.timer-panel.warn,
.timer-single.warn {
  border-color: #f59e0b !important;
  box-shadow: 0 0 4vh rgba(245, 158, 11, 0.45);
}
.team {
  font-size: 3.5vh;
  font-weight: 600;
}
.time {
  font-size: 12vh;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.time-huge {
  font-size: 22vh;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.timer-single {
  border: 0.5vh solid #334155;
  border-radius: 2vh;
  padding: 4vh 8vw;
  text-align: center;
  transition: border-color 0.3s, box-shadow 0.3s;
}
.speaker-tag {
  font-size: 2.5vh;
  color: #34d399;
  min-height: 3vh;
}
.compare {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2vh 4vw;
  border-top: 0.2vh solid #1e293b;
}
.side {
  font-size: 4vh;
  font-weight: 700;
  flex: 1;
}
.side.neg {
  text-align: right;
}
.title {
  font-size: 2vh;
  color: #94a3b8;
  margin-left: 1vw;
}
.vs {
  font-size: 3vh;
  color: #64748b;
}

/* 成绩公布区：加权总分对比，领先方高亮 */
.scoreboard {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6vw;
  padding: 2vh 4vw;
  margin-bottom: 1vh;
  border-top: 0.2vh solid #1e293b;
  border-bottom: 0.2vh solid #1e293b;
}
.score-side {
  flex: 1;
  text-align: center;
  opacity: 0.55;
  transition: opacity 0.3s;
}
.score-side.winner {
  opacity: 1;
}
.score-team {
  font-size: 3vh;
  color: #94a3b8;
}
.score-value {
  font-size: 9vh;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.score-side.winner .score-value {
  color: #34d399;
  text-shadow: 0 0 3vh rgba(52, 211, 153, 0.45);
}
.score-mid {
  text-align: center;
  min-width: 18vw;
}
.score-label {
  font-size: 3vh;
  font-weight: 700;
  color: #e2e8f0;
}
.score-sub {
  font-size: 1.8vh;
  color: #64748b;
  margin-top: 0.6vh;
}

/* 音频解锁门：铺满全屏，点击后才允许出声 */
.gate {
  position: fixed;
  inset: 0;
  z-index: 10;
  background: rgba(11, 18, 32, 0.96);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3vh;
  text-align: center;
  padding: 4vw;
  box-sizing: border-box;
}
.gate-topic {
  font-size: 6vh;
  font-weight: 700;
}
.gate-btn {
  font-size: 4vh;
  font-weight: 700;
  padding: 3vh 8vw;
  min-height: 48px;
  border: none;
  border-radius: 2vh;
  background: #34d399;
  color: #052e21;
  cursor: pointer;
}
.gate-btn:active {
  transform: scale(0.98);
}
.gate-hint {
  font-size: 2.4vh;
  color: #94a3b8;
}

/* 提示音开关：舞台工作人员临时静音用 */
.audio-chip {
  position: absolute;
  top: 2vh;
  right: 2vw;
  font-size: 2vh;
  padding: 1.2vh 2vw;
  border-radius: 999px;
  border: 0.2vh solid #334155;
  background: rgba(15, 23, 42, 0.7);
  color: #cbd5e1;
  cursor: pointer;
}
</style>
