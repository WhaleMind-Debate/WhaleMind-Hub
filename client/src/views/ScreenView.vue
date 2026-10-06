<script setup lang="ts">
/**
 * 大屏展示端（舞台投屏）
 * 不依赖通用 UI 库：纯 Flex/Grid + 大字号高对比度。
 * 倒计时每帧从 targetEndTime 反推（useMasterClock），多端绝对同步。
 * 音效/动效后续接入 GSAP；预留 timer:warn 订阅入口。
 */
import { computed, onMounted } from 'vue';
import type { Side } from '@/types/debate';
import { useDebateStore } from '@/stores/debateStore';
import { useSocket } from '@/composables/useSocket';
import { useMasterClock, formatMs } from '@/composables/useMasterClock';

const store = useDebateStore();
const { connect, onTimerWarn } = useSocket();
const { tick, remainingOf } = useMasterClock();

onMounted(() => {
  connect();
  // 预警入口：铃声/GSAP 动效后续接入（须先点击解锁 AudioContext）
  onTimerWarn(() => {
    /* TODO(后续): 铃声 + 脉冲动效 */
  });
});

const currentStage = computed(() => store.currentStage);
const isDual = computed(() => currentStage.value?.type === 'dual_alternating');

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
        <div class="timer-single" :class="{ warn: isWarn(currentStage.side) }">
          <div class="team">
            {{ currentStage.side === 'aff' ? store.config?.aff.teamName : store.config?.neg.teamName }}
          </div>
          <div class="time-huge">{{ timerText(currentStage.side) }}</div>
        </div>
      </template>
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
</style>
