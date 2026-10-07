<script setup lang="ts">
/**
 * 主席控制台（PC 端）
 *
 * 职责：赛制模板与环节编排、比赛信息配置、计时控制、比分监控与公布。
 *
 * 状态边界（规范三.2）：
 * - **比赛状态**（剩余时间 / 当前环节 / 发言方）一律来自 debateStore 镜像，本组件零私有维护；
 * - **赛制草稿**是本组件的局部表单态：编辑期间不动 store，点「保存赛制」才通过
 *   setStages 指令交给服务端校验并广播回来——服务端始终是唯一权威。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { Message } from '@arco-design/web-vue';
import { TEMPLATES, type MatchConfig, type PublishedScores, type SavedTemplate, type Side, type StageConfig } from '@/types/debate';
import { useDebateStore } from '@/stores/debateStore';
import { useSocket } from '@/composables/useSocket';
import { useMasterClock, formatMs } from '@/composables/useMasterClock';
import { createTemplate, deleteTemplate, fetchTemplates } from '@/api/templates';
import MatchInfoCard from '@/components/MatchInfoCard.vue';
import StageTable from '@/components/StageTable.vue';
import StageEditorDrawer from '@/components/StageEditorDrawer.vue';
import { draftFromStage, draftToInput, type StageDraft } from '@/stages/draft';

const store = useDebateStore();
const { connect, sendCommand, previewScores } = useSocket();
const { tick, remainingOf } = useMasterClock();

const lastError = ref('');
/** 赛制是否只在 idle / configured 可编辑（开赛后冻结） */
const editable = computed(() => store.status === 'idle' || store.status === 'configured');

onMounted(async () => {
  connect();
  await refreshTemplates();
});

async function run(command: Parameters<typeof sendCommand>[0], successText?: string): Promise<boolean> {
  const res = await sendCommand(command);
  if (!res.ok) {
    lastError.value = res.error ?? '指令失败';
    Message.error(lastError.value);
    return false;
  }
  lastError.value = '';
  if (successText) Message.success(successText);
  return true;
}

// ==================== 赛制模板 ====================

const customTemplates = ref<SavedTemplate[]>([]);
const selectedTemplate = ref(`builtin:${TEMPLATES[0]?.id ?? ''}`);

const templateOptions = computed(() => [
  ...TEMPLATES.map((t) => ({ value: `builtin:${t.id}`, label: `内置 · ${t.name}` })),
  ...customTemplates.value.map((t) => ({ value: `custom:${t.id}`, label: `自定义 · ${t.name}` })),
]);
const selectedIsCustom = computed(() => selectedTemplate.value.startsWith('custom:'));

async function refreshTemplates(): Promise<void> {
  const res = await fetchTemplates();
  if (res.ok && res.data) customTemplates.value = res.data.templates;
}

async function loadSelectedTemplate(): Promise<void> {
  const [kind, id] = selectedTemplate.value.split(':');
  if (kind === 'builtin') {
    await run({ type: 'loadTemplate', templateId: id }, '模板已载入');
    return;
  }
  const template = customTemplates.value.find((t) => t.id === id);
  if (!template) {
    Message.error('模板不存在，请刷新后重试');
    return;
  }
  // 自定义模板通过 setStages 落地：服务端仍会跑完整校验并分配新的环节 id
  await run({ type: 'setStages', stages: template.stages }, '模板已载入');
}

const saveTemplateVisible = ref(false);
const templateName = ref('');
const templateDesc = ref('');
const savingTemplate = ref(false);

function openSaveTemplate(): void {
  if (draft.value.length === 0) {
    Message.warning('当前没有环节，无法保存为模板');
    return;
  }
  templateName.value = `${store.config?.name ?? '赛制'}（自定义）`.slice(0, 60);
  templateDesc.value = '';
  saveTemplateVisible.value = true;
}

async function confirmSaveTemplate(): Promise<void> {
  const stages = draft.value.map(draftToInput);
  savingTemplate.value = true;
  try {
    const res = await createTemplate({ name: templateName.value, description: templateDesc.value, stages });
    if (!res.ok) {
      Message.error(res.error ?? '保存模板失败');
      return;
    }
    Message.success('模板已保存，可在列表中选择复用');
    saveTemplateVisible.value = false;
    await refreshTemplates();
    if (res.data) selectedTemplate.value = `custom:${res.data.template.id}`;
  } finally {
    savingTemplate.value = false;
  }
}

async function removeSelectedTemplate(): Promise<void> {
  const [, id] = selectedTemplate.value.split(':');
  const res = await deleteTemplate(id);
  if (!res.ok) {
    Message.error(res.error ?? '删除模板失败');
    return;
  }
  Message.success('模板已删除');
  selectedTemplate.value = `builtin:${TEMPLATES[0]?.id ?? ''}`;
  await refreshTemplates();
}

// ==================== 赛制环节草稿 ====================

const draft = ref<StageDraft[]>([]);
const dirty = ref(false);

/** 只比较内容而非引用：store 每次广播都会换新数组，避免无意义地重建草稿 */
function stageSignature(stages: StageConfig[]): string {
  return stages
    .map((s) =>
      [s.id, s.order, s.name, s.type, s.timerKind, s.side, s.protectedSide, s.durationMs, s.weight, s.warnThresholds.join(','), s.soundId, s.description].join('~'),
    )
    .join('|');
}
const storeSignature = computed(() => stageSignature(store.stages));

watch(
  storeSignature,
  () => {
    if (dirty.value) return; // 编辑中不覆盖用户的改动
    draft.value = store.stages.map(draftFromStage);
  },
  { immediate: true },
);

const drawerVisible = ref(false);
const editingIndex = ref(-1);
const editingStage = computed(() => (editingIndex.value >= 0 ? draft.value[editingIndex.value] ?? null : null));

function addStage(): void {
  editingIndex.value = -1;
  drawerVisible.value = true;
}

function editStage(index: number): void {
  editingIndex.value = index;
  drawerVisible.value = true;
}

function submitStage(stage: StageDraft): void {
  if (editingIndex.value >= 0) draft.value.splice(editingIndex.value, 1, stage);
  else draft.value.push(stage);
  dirty.value = true;
}

function removeStage(index: number): void {
  draft.value.splice(index, 1);
  dirty.value = true;
}

function moveStage(from: number, to: number): void {
  if (to < 0 || to >= draft.value.length || from === to) return;
  const [moved] = draft.value.splice(from, 1);
  draft.value.splice(to, 0, moved);
  dirty.value = true;
}

const savingStages = ref(false);

async function saveStages(): Promise<void> {
  savingStages.value = true;
  try {
    const stages = draft.value.map(draftToInput);
    if (await run({ type: 'setStages', stages })) {
      dirty.value = false;
      Message.success(`赛制已保存（${stages.length} 个环节）`);
    }
  } finally {
    savingStages.value = false;
  }
}

function resetDraft(): void {
  draft.value = store.stages.map(draftFromStage);
  dirty.value = false;
  Message.info('已还原为服务端保存的赛制');
}

// ==================== 比赛信息 ====================

const savingConfig = ref(false);

async function saveMatchInfo(patch: Partial<MatchConfig>): Promise<void> {
  savingConfig.value = true;
  try {
    await run({ type: 'setConfig', config: patch }, '比赛信息已保存');
  } finally {
    savingConfig.value = false;
  }
}

// ==================== 计时与比分 ====================

const currentStage = computed(() => store.currentStage);
const isDual = computed(() => currentStage.value?.type === 'dual_alternating');

/** 总分预览：只回传到本机，不进入广播，主席据此判断何时公布 */
const totals = ref<PublishedScores | null>(null);
const previewBusy = ref(false);

async function refreshTotals(): Promise<void> {
  previewBusy.value = true;
  try {
    const res = await previewScores();
    if (res.ok && res.scores) totals.value = res.scores;
  } finally {
    previewBusy.value = false;
  }
}

// 评委每次提交后自动刷新，主席无需手动点
watch(() => store.state?.scoreProgress.length ?? 0, () => void refreshTotals(), { immediate: true });

/** 时钟同步状态：让主席一眼看出本机与服务端的时基是否可信 */
const clockStatus = computed(() => {
  if (store.clockSyncedAt == null) return { color: 'gray', text: '对时中…' };
  const offset = store.clockOffset;
  const rtt = store.clockRtt ?? 0;
  const risky = rtt > 150 || Math.abs(offset) > 2_000;
  return {
    color: risky ? 'orange' : 'green',
    text: `对时 ${offset >= 0 ? '+' : ''}${Math.round(offset)}ms / RTT ${rtt}ms`,
  };
});

function timerText(side: Side): string {
  const timer = store.timers[side];
  if (!timer) return '--:--';
  void tick.value;
  // remainingOf 已按 timerKind 区分：倒计时给剩余、正计时给已耗
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
          <a-tag v-if="dirty" color="orange">赛制未保存</a-tag>
          <a-tag :color="clockStatus.color">{{ clockStatus.text }}</a-tag>
        </a-space>
      </a-layout-header>

      <a-layout-content class="content">
        <!-- 赛制模板 -->
        <a-card title="赛制模板" class="card">
          <a-space wrap>
            <a-select v-model="selectedTemplate" style="width: 280px" :disabled="!editable">
              <a-option v-for="opt in templateOptions" :key="opt.value" :value="opt.value" :label="opt.label" />
            </a-select>
            <a-button type="primary" :disabled="!editable" @click="loadSelectedTemplate">载入模板</a-button>
            <a-button :disabled="draft.length === 0" @click="openSaveTemplate">另存为模板</a-button>
            <a-popconfirm
              v-if="selectedIsCustom"
              content="删除该自定义模板？已载入的比赛不受影响。"
              @ok="removeSelectedTemplate"
            >
              <a-button status="danger" :disabled="!selectedIsCustom">删除模板</a-button>
            </a-popconfirm>
          </a-space>
          <div class="hint">
            内置模板来自代码，自定义模板存在服务端 SQLite，可跨场次复用（共 {{ customTemplates.length }} 个）。
          </div>
        </a-card>

        <!-- 比赛信息 -->
        <MatchInfoCard :disabled="!editable" :saving="savingConfig" @submit="saveMatchInfo" />

        <!-- 赛制环节 -->
        <a-card title="赛制环节" class="card wide">
          <StageTable
            :stages="draft"
            :disabled="!editable"
            :current-index="store.state?.currentStageIndex ?? -1"
            @add="addStage"
            @edit="editStage"
            @remove="removeStage"
            @move="moveStage"
            @reorder="moveStage"
          />
          <a-space class="stage-actions">
            <a-button type="primary" :disabled="!editable || !dirty" :loading="savingStages" @click="saveStages">
              保存赛制
            </a-button>
            <a-button :disabled="!dirty" @click="resetDraft">还原</a-button>
            <span v-if="dirty" class="hint">有未保存的改动</span>
          </a-space>
        </a-card>

        <!-- 计时控制 -->
        <a-card title="计时控制" class="card">
          <a-space wrap>
            <a-button type="primary" size="large" @click="run({ type: 'start' })">开始 / 启动环节</a-button>
            <a-button size="large" @click="run({ type: 'pause' })">暂停</a-button>
            <a-button size="large" @click="run({ type: 'resume' })">恢复</a-button>
            <a-button size="large" @click="run({ type: 'nextStage' })">下一环节</a-button>
            <a-button size="large" status="warning" :disabled="!isDual" @click="run({ type: 'switchSpeaker' })">
              切换发言方
            </a-button>
            <a-button size="large" @click="run({ type: 'publishScores' })">公布比分</a-button>
            <a-button size="large" status="danger" @click="run({ type: 'finish' })">结束比赛</a-button>
            <a-popconfirm content="将归档本场并生成新入场码，确定重置？" @ok="run({ type: 'reset' })">
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

        <!-- 总分预览 -->
        <a-card title="总分（预览）" class="card">
          <template v-if="totals">
            <a-space size="large">
              <div class="total-box">
                <div class="total-label">{{ store.config?.aff.teamName ?? '正方' }}</div>
                <div class="total-num" :class="{ lead: totals.winner === 'aff' }">{{ totals.aff.weighted.toFixed(1) }}</div>
              </div>
              <div class="total-box">
                <div class="total-label">{{ store.config?.neg.teamName ?? '反方' }}</div>
                <div class="total-num" :class="{ lead: totals.winner === 'neg' }">{{ totals.neg.weighted.toFixed(1) }}</div>
              </div>
            </a-space>
            <div class="total-meta">
              {{ totals.judgeCount }} 位评委 · 正 {{ totals.aff.scoredStages }} / 反 {{ totals.neg.scoredStages }} 个环节计分 ·
              {{ totals.winner === null ? '暂时持平' : totals.winner === 'aff' ? '正方领先' : '反方领先' }}
            </div>
          </template>
          <a-empty v-else description="暂无评分" />
          <a-button class="total-refresh" size="small" :loading="previewBusy" @click="refreshTotals">刷新</a-button>
        </a-card>
      </a-layout-content>
    </a-layout>

    <!-- 环节编辑抽屉 -->
    <StageEditorDrawer
      v-model:visible="drawerVisible"
      :stage="editingStage"
      :order="editingIndex >= 0 ? editingIndex + 1 : draft.length + 1"
      @submit="submitStage"
    />

    <!-- 另存为模板 -->
    <a-modal v-model:visible="saveTemplateVisible" title="另存为自定义模板" :ok-loading="savingTemplate" @ok="confirmSaveTemplate">
      <a-form :model="{ templateName, templateDesc }" layout="vertical">
        <a-form-item label="模板名称">
          <a-input v-model="templateName" :max-length="60" placeholder="如：校级联赛三人赛制" allow-clear />
        </a-form-item>
        <a-form-item label="模板说明">
          <a-input v-model="templateDesc" :max-length="200" placeholder="选填，便于日后识别" allow-clear />
        </a-form-item>
      </a-form>
      <div class="hint">将保存当前 {{ draft.length }} 个环节（含时长、权重、预警与音色）。</div>
    </a-modal>
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
/* 环节表格较宽，占满整行 */
.card.wide {
  grid-column: 1 / -1;
}
.hint {
  font-size: 13px;
  color: var(--color-text-3);
  margin-top: 8px;
}
.stage-actions {
  margin-top: 12px;
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
.total-box {
  text-align: center;
}
.total-label {
  font-size: 13px;
  color: var(--color-text-3);
}
.total-num {
  font-size: 32px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.total-num.lead {
  color: rgb(var(--success-6));
}
.total-meta {
  margin-top: 8px;
  font-size: 13px;
  color: var(--color-text-3);
}
.total-refresh {
  margin-top: 8px;
}
</style>
