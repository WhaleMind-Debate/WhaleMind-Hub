<script setup lang="ts">
/**
 * 评委打分端（移动/平板端）
 * - 入场码加入（无账号体系）；
 * - 会话持久化：judgeId 存 localStorage，刷新 / 断线重连后自动向服务端续期；
 *   配合服务端 SQLite 落盘，评委端和服务端任一侧重启都不丢已提交评分；
 * - 分环节给正反双方打分（Slider + 数字输入双通道）；
 * - 触控热区红线：所有可点控件高度 ≥ 48px。
 */
import { computed, onMounted, ref } from 'vue';
import { Message } from '@arco-design/web-vue';
import type { Judge, Score, Side } from '@/types/debate';
import { useDebateStore } from '@/stores/debateStore';
import { useSocket } from '@/composables/useSocket';
import { useMasterClock, formatMs } from '@/composables/useMasterClock';

const store = useDebateStore();
const { connect, judgeJoin, judgeResume, submitScore } = useSocket();
const { tick, remainingOf } = useMasterClock();

const joinName = ref('');
const joinCode = ref('');
const joining = ref(false);
const judge = ref<Judge | null>(null);
const scores = ref<Record<string, number>>({});

/** 本地会话记录：只存 judgeId，凭它向服务端续期（服务端才是权威） */
const SESSION_KEY = 'whalemind.judge.session.v1';

function readSession(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

function writeSession(judgeId: string): void {
  try {
    localStorage.setItem(SESSION_KEY, judgeId);
  } catch {
    /* 隐私模式等 localStorage 不可用：退化为不续期，不影响本次打分 */
  }
}

function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* 同上 */
  }
}

/** 用服务端回传的“本人评分”回填滑杆，避免刷新后显示中位值被误提交 */
function applyMyScores(list: Score[] | undefined): void {
  if (!list?.length) return;
  const next = { ...scores.value };
  for (const s of list) next[`${s.stageId}:${s.side}`] = s.value;
  scores.value = next;
}

onMounted(async () => {
  connect();
  await resumeSession();
});

/** 刷新 / 重连后尝试续期；服务端判定会话失效则清掉本地记录回到入场页 */
async function resumeSession(): Promise<void> {
  const judgeId = readSession();
  if (!judgeId) return;
  const res = await judgeResume({ judgeId });
  if (res.ok && res.judge) {
    judge.value = res.judge;
    applyMyScores(res.myScores);
    Message.success(`欢迎回来，${res.judge.name}评委`);
  } else {
    clearSession();
  }
}

async function doJoin() {
  joining.value = true;
  try {
    const res = await judgeJoin({ name: joinName.value, entryCode: joinCode.value });
    if (res.ok && res.judge) {
      judge.value = res.judge;
      writeSession(res.judge.id);
      Message.success(`欢迎，${res.judge.name}评委`);
    } else {
      Message.error(res.error ?? '加入失败');
    }
  } finally {
    joining.value = false;
  }
}

/** 换人：清掉本地会话回到入场页（服务端仍保留该评委已提交的评分） */
function doLeave(): void {
  clearSession();
  judge.value = null;
  scores.value = {};
  joinName.value = '';
  joinCode.value = '';
}

const currentStage = computed(() => store.currentStage);

function scoreKey(side: Side): string {
  return `${currentStage.value?.id ?? ''}:${side}`;
}

function scoreOf(side: Side): number {
  const scale = store.config?.scoreScale ?? { min: 0, max: 100, step: 1 };
  return scores.value[scoreKey(side)] ?? (scale.min + scale.max) / 2;
}

function setScore(side: Side, v: number) {
  scores.value = { ...scores.value, [scoreKey(side)]: v };
}

function doSubmit(side: Side) {
  if (!judge.value || !currentStage.value) return;
  submitScore({
    judgeId: judge.value.id,
    stageId: currentStage.value.id,
    side,
    value: scoreOf(side),
  });
  Message.success(`${store.sideLabel(side)}评分已提交（可继续修改）`);
}

function timerText(side: Side): string {
  void tick.value;
  const timer = store.timers[side];
  if (!timer) return '--:--';
  return formatMs(remainingOf(timer));
}
</script>

<template>
  <div class="judge">
    <!-- 入场 -->
    <div v-if="!judge" class="join">
      <h2>评委入场</h2>
      <a-form :model="{ joinName, joinCode }" layout="vertical">
        <a-form-item label="姓名">
          <a-input v-model="joinName" size="large" placeholder="请输入评委姓名" class="touch" />
        </a-form-item>
        <a-form-item label="入场码">
          <a-input v-model="joinCode" size="large" placeholder="6 位入场码" class="touch" :max-length="6" />
        </a-form-item>
        <a-button type="primary" long size="large" class="touch submit" :loading="joining" @click="doJoin">
          进入评委席
        </a-button>
      </a-form>
    </div>

    <!-- 打分面板 -->
    <div v-else class="panel">
      <div class="bar">
        <span>{{ judge.name }} 评委</span>
        <a-space>
          <a-tag :color="store.connected ? 'green' : 'red'">{{ store.connected ? '已连接' : '重连中…' }}</a-tag>
          <a-button size="small" @click="doLeave">换人</a-button>
        </a-space>
      </div>

      <a-empty v-if="!currentStage" description="等待比赛开始…" />

      <template v-else>
        <div class="stage">
          <h3>{{ currentStage.name }}</h3>
          <div class="timers">
            <span>正方 {{ timerText('aff') }}</span>
            <span>反方 {{ timerText('neg') }}</span>
          </div>
        </div>

        <div v-for="side in (['aff', 'neg'] as Side[])" :key="side" class="score-card">
          <div class="score-head">{{ store.sideLabel(side) }}</div>
          <div class="score-value">{{ scoreOf(side) }}</div>
          <a-slider
            :model-value="scoreOf(side)"
            :min="store.config?.scoreScale.min ?? 0"
            :max="store.config?.scoreScale.max ?? 100"
            :step="store.config?.scoreScale.step ?? 1"
            class="touch slider"
            @update:model-value="(v: number | [number, number]) => setScore(side, Array.isArray(v) ? v[0] : v)"
          />
          <a-input-number
            :model-value="scoreOf(side)"
            :min="store.config?.scoreScale.min ?? 0"
            :max="store.config?.scoreScale.max ?? 100"
            :step="store.config?.scoreScale.step ?? 1"
            class="touch"
            size="large"
            @update:model-value="(v: number | undefined) => v != null && setScore(side, v)"
          />
          <a-button type="primary" long size="large" class="touch submit" @click="doSubmit(side)">
            提交{{ store.sideLabel(side) }}评分
          </a-button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.judge {
  min-height: 100%;
  background: var(--color-fill-1);
  padding: 16px;
}
.join {
  max-width: 480px;
  margin: 10vh auto;
  background: #fff;
  border-radius: 8px;
  padding: 24px;
}
.bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
.stage {
  background: #fff;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
}
.stage h3 {
  margin: 0 0 8px;
}
.timers {
  display: flex;
  gap: 24px;
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}
.score-card {
  background: #fff;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
  display: grid;
  gap: 12px;
}
.score-head {
  font-size: 18px;
  font-weight: 600;
}
.score-value {
  font-size: 40px;
  font-weight: 700;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

/* 移动端触控红线：热区高度 ≥ 48px */
.touch {
  min-height: 48px;
}
.slider {
  padding: 12px 8px;
  box-sizing: content-box;
}
.submit {
  margin-top: 8px;
}
</style>
