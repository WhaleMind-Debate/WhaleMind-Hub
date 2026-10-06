<script setup lang="ts">
/**
 * 主席控制台（PC 端）
 * 赛制加载、环节推进、计时启停、自由辩切换发言方、比分公布。
 * 所有比赛状态来自 debateStore 镜像，本组件零私有比赛状态。
 */
import { computed, onMounted, ref } from 'vue';
import { Message } from '@arco-design/web-vue';
import { TEMPLATES, type Side } from '@/types/debate';
import { useDebateStore } from '@/stores/debateStore';
import { useSocket } from '@/composables/useSocket';
import { useMasterClock, formatMs } from '@/composables/useMasterClock';

const store = useDebateStore();
const { connect, sendCommand } = useSocket();
const { tick, remainingOf } = useMasterClock();

const selectedTemplate = ref(TEMPLATES[0]?.id ?? '');
const lastError = ref('');

onMounted(() => connect());

async function run(command: Parameters<typeof sendCommand>[0]) {
  const res = await sendCommand(command);
  if (!res.ok) {
    lastError.value = res.error ?? '指令失败';
    Message.error(lastError.value);
  } else {
    lastError.value = '';
  }
}

const currentStage = computed(() => store.currentStage);
const isDual = computed(() => currentStage.value?.type === 'dual_alternating');

function timerOf(side: Side) {
  void tick.value; // 订阅主帧刷新
  return remainingOf(store.timers[side]);
}

function timerText(side: Side): string {
  const stage = currentStage.value;
  const timer = store.timers[side];
  if (!timer) return '--:--';
  void tick.value;
  if (stage?.timerKind === 'countUp' && timer.status === 'running') {
    const elapsed = Math.max(0, store.syncedNow() - (timer.startedAt ?? 0));
    return formatMs(elapsed);
  }
  return formatMs(remainingOf(timer));
}
</script>

<template>
  <div class="admin">
    <a-layout>
      <a-layout-header class="header">
        <h2>主席控制台</h2>
        <a-space>
          <a-tag :color="store.connected ? 'green' : 'red'">
            {{ store.connected ? '已连接' : '连接中…' }}
          </a-tag>
          <a-tag color="arcoblue">状态：{{ store.status }}</a-tag>
          <a-tag v-if="store.config">入场码：{{ store.config.entryCode }}</a-tag>
        </a-space>
      </a-layout-header>

      <a-layout-content class="content">
        <!-- 赛制加载 -->
        <a-card title="赛制模板" class="card">
          <a-space>
            <a-select v-model="selectedTemplate" style="width: 280px" :disabled="store.status !== 'idle' && store.status !== 'configured'">
              <a-option v-for="t in TEMPLATES" :key="t.id" :value="t.id" :label="t.name" />
            </a-select>
            <a-button
              type="primary"
              :disabled="store.status !== 'idle' && store.status !== 'configured'"
              @click="run({ type: 'loadTemplate', templateId: selectedTemplate })"
            >
              载入模板
            </a-button>
          </a-space>
        </a-card>

        <!-- 计时控制 -->
        <a-card title="计时控制" class="card">
          <a-space wrap>
            <a-button type="primary" size="large" @click="run({ type: 'start' })">开始 / 启动环节</a-button>
            <a-button size="large" @click="run({ type: 'pause' })">暂停</a-button>
            <a-button size="large" @click="run({ type: 'resume' })">恢复</a-button>
            <a-button size="large" @click="run({ type: 'nextStage' })">下一环节</a-button>
            <a-button
              size="large"
              status="warning"
              :disabled="!isDual"
              @click="run({ type: 'switchSpeaker' })"
            >
              切换发言方
            </a-button>
            <a-button size="large" @click="run({ type: 'publishScores' })">公布比分</a-button>
            <a-button size="large" status="danger" @click="run({ type: 'finish' })">结束比赛</a-button>
            <a-popconfirm content="将清空本场全部状态并生成新入场码，确定重置？" @ok="run({ type: 'reset' })">
              <a-button size="large" status="warning" outline>重置比赛</a-button>
            </a-popconfirm>
          </a-space>
          <a-alert v-if="lastError" type="error" :content="lastError" class="err" />
        </a-card>

        <!-- 当前环节 -->
        <a-card title="当前环节" class="card">
          <template v-if="currentStage">
            <h3>{{ currentStage.name }}</h3>
            <a-space size="large">
              <div v-for="side in (['aff', 'neg'] as Side[])" :key="side" class="timer-box">
                <span class="side-label">{{ store.sideLabel(side) }}</span>
                <span class="timer-num" :class="{ active: store.activeSpeaker === side }">
                  {{ timerText(side) }}
                </span>
                <a-tag v-if="store.activeSpeaker === side" color="green">发言中</a-tag>
              </div>
            </a-space>
          </template>
          <a-empty v-else description="尚未载入赛制" />
        </a-card>

        <!-- 环节列表 -->
        <a-card title="环节列表" class="card">
          <a-list :bordered="false" size="small">
            <a-list-item
              v-for="(s, i) in store.stages"
              :key="s.id"
              :class="{ current: i === store.state?.currentStageIndex }"
            >
              <a-list-item-meta>
                <template #title>
                  {{ s.order }}. {{ s.name }}
                  <a-tag v-if="i === store.state?.currentStageIndex" color="arcoblue" size="small">进行中</a-tag>
                </template>
                <template #description>
                  {{ s.type === 'dual_alternating' ? '自由辩论交替计时' : `${store.sideLabel(s.side!)}计时` }}
                  · {{ Math.round(s.durationMs / 1000) }}s
                  <template v-if="s.timerKind === 'countUp'"> · 正计时</template>
                </template>
              </a-list-item-meta>
            </a-list-item>
          </a-list>
        </a-card>
      </a-layout-content>
    </a-layout>
  </div>
</template>

<style scoped>
.admin {
  height: 100%;
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  border-bottom: 1px solid var(--color-border);
}
.header h2 {
  margin: 0;
}
.content {
  padding: 16px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
  gap: 16px;
  align-content: start;
}
.card {
  min-height: 120px;
}
.timer-box {
  display: flex;
  align-items: center;
  gap: 12px;
}
.timer-num {
  font-size: 40px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.timer-num.active {
  color: rgb(var(--success-6));
}
.err {
  margin-top: 12px;
}
.current {
  background: var(--color-fill-2);
}
</style>
