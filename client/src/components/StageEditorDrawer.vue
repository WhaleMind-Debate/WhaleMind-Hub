<script setup lang="ts">
/**
 * 环节编辑抽屉（Arco Drawer + Form）
 *
 * 设计取舍：
 * - 用 Drawer 而非 Modal：本表单有 9 个字段，抽屉纵向空间充足，且不遮挡背后的环节列表；
 * - 校验以服务端为权威（validateStages），这里的 rules 只做即时体验反馈；
 * - 若所选音色不是内置音色，服务端会拒绝，因此这里用 a-select 限定在音色表内。
 */
import { computed, reactive, ref, watch } from 'vue';
import { Message } from '@arco-design/web-vue';
import { BUILTIN_SOUND_IDS, STAGE_LIMITS, type Side } from '@/types/debate';
import { useStageAudio } from '@/composables/useStageAudio';
import { blankDraft, draftToInput, formatDuration, type StageDraft } from '@/stages/draft';

const props = defineProps<{
  visible: boolean;
  /** 编辑中的草稿；null 表示新增 */
  stage: StageDraft | null;
  /** 1 起的序号，仅用于标题 */
  order: number;
}>();

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void;
  (e: 'submit', value: StageDraft): void;
}>();

const audio = useStageAudio();
const formRef = ref();

const SOUND_LABEL: Record<string, string> = {
  bell: '钟声',
  electronic: '电子提示',
  chime: '风铃',
};

/** Arco 的 a-select/a-option 不接受 null 值，用哨兵值表达“不设置”，提交时再映射回 null */
const NO_PROTECT = '__none__';
const NO_SOUND = '__none__';

const form = reactive({
  name: '',
  type: 'single' as StageDraft['type'],
  side: 'aff' as Side,
  timerKind: 'countdown' as StageDraft['timerKind'],
  durationSec: 30,
  weight: 1,
  warnThresholds: [] as string[],
  soundId: 'bell' as string,
  description: '',
  protectedSide: NO_PROTECT as string,
});

/** 当前正在编辑的草稿本体（key / id 从这里带回去） */
let editing: StageDraft | null = null;

const isDual = computed(() => form.type === 'dual_alternating');
const durationText = computed(() => formatDuration(Math.round(form.durationSec * 1000)));

const rules = {
  name: [{ required: true, message: '请填写环节名称' }],
  durationSec: [{ required: true, message: '请填写时长' }],
};

function loadFrom(stage: StageDraft | null): void {
  const source = stage ?? blankDraft();
  editing = { ...source, warnThresholds: [...source.warnThresholds] };
  form.name = source.name;
  form.type = source.type;
  form.side = (source.side ?? 'aff') as Side;
  form.timerKind = source.timerKind;
  form.durationSec = Math.max(1, Math.round(source.durationMs / 1000));
  form.weight = source.weight;
  form.warnThresholds = source.warnThresholds.map(String);
  form.soundId = source.soundId ?? NO_SOUND;
  form.description = source.description ?? '';
  form.protectedSide = source.protectedSide ?? NO_PROTECT;
}

watch(
  () => [props.visible, props.stage] as const,
  ([visible]) => {
    if (visible) {
      loadFrom(props.stage);
      formRef.value?.clearValidate?.();
    }
  },
  { immediate: true },
);

function close(): void {
  emit('update:visible', false);
}

/** 试听：按钮点击本身即用户手势，正好用来解锁 AudioContext */
async function previewSound(): Promise<void> {
  if (form.soundId === NO_SOUND) {
    Message.info('该环节设置为不提示音');
    return;
  }
  await audio.unlock();
  audio.play(form.soundId);
}

async function submit(): Promise<void> {
  const errors = await formRef.value?.validate?.();
  if (errors) return;

  const thresholds = form.warnThresholds
    .map((v) => Number(String(v).trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

  const base = editing ?? blankDraft();
  const draft: StageDraft = {
    ...base,
    name: form.name.trim(),
    type: form.type,
    side: form.type === 'single' ? form.side : null,
    protectedSide:
      form.type === 'dual_alternating' && form.protectedSide !== NO_PROTECT ? (form.protectedSide as Side) : null,
    timerKind: form.timerKind,
    durationMs: Math.round(form.durationSec * 1000),
    weight: form.weight,
    warnThresholds: thresholds,
    soundId: form.soundId === NO_SOUND ? null : form.soundId,
    description: form.description.trim() === '' ? null : form.description.trim(),
  };

  if (!draft.name) {
    Message.error('请填写环节名称');
    return;
  }
  emit('submit', draft);
  close();
}

defineExpose({ draftToInput });
</script>

<template>
  <a-drawer
    :visible="visible"
    :width="520"
    :title="stage ? `编辑环节 · 第 ${order} 个` : '新增环节'"
    unmount-on-close
    @cancel="close"
    @ok="submit"
  >
    <a-form ref="formRef" :model="form" :rules="rules" layout="vertical">
      <a-form-item field="name" label="环节名称">
        <a-input v-model="form.name" :max-length="STAGE_LIMITS.maxNameLength" placeholder="如：正方一辩立论" allow-clear />
      </a-form-item>

      <a-form-item field="type" label="环节类型">
        <a-radio-group v-model="form.type" type="button">
          <a-radio value="single">单方计时</a-radio>
          <a-radio value="dual_alternating">自由辩论</a-radio>
        </a-radio-group>
      </a-form-item>

      <a-form-item v-if="!isDual" field="side" label="归属方">
        <a-radio-group v-model="form.side" type="button">
          <a-radio value="aff">正方</a-radio>
          <a-radio value="neg">反方</a-radio>
        </a-radio-group>
      </a-form-item>

      <a-form-item v-else label="保护时间">
        <a-select v-model="form.protectedSide">
          <a-option :value="NO_PROTECT">不设保护（双方均计时）</a-option>
          <a-option value="aff">正方受保护（接麦不计时）</a-option>
          <a-option value="neg">反方受保护（接麦不计时）</a-option>
        </a-select>
        <template #extra>受保护方接麦时自己的计时器不启动，常用来做质询环节。</template>
      </a-form-item>

      <a-form-item field="durationSec" label="时长（秒）">
        <a-input-number
          v-model="form.durationSec"
          :min="STAGE_LIMITS.minDurationSec"
          :max="STAGE_LIMITS.maxDurationSec"
          :step="5"
          mode="button"
        />
        <template #extra>当前显示为 {{ durationText }}，范围 {{ STAGE_LIMITS.minDurationSec }}~{{ STAGE_LIMITS.maxDurationSec }} 秒</template>
      </a-form-item>

      <a-form-item field="timerKind" label="计时方式">
        <a-radio-group v-model="form.timerKind" type="button">
          <a-radio value="countdown">倒计时</a-radio>
          <a-radio value="countUp">正计时</a-radio>
        </a-radio-group>
        <template #extra>倒计时归零自动进入下一环节；正计时不自动结束，由主席手动推进。</template>
      </a-form-item>

      <a-form-item field="weight" label="权重">
        <a-input-number v-model="form.weight" :min="STAGE_LIMITS.minWeight" :max="STAGE_LIMITS.maxWeight" :step="0.5" />
        <template #extra>加权总分 = Σ(环节平均分 × 权重)，权重 1 表示常规计分。</template>
      </a-form-item>

      <a-form-item field="warnThresholds" label="预警阈值（秒）">
        <a-input-tag v-model="form.warnThresholds" :max-tag-count="STAGE_LIMITS.maxWarnThresholds" placeholder="输入秒数后回车，如 30" allow-clear />
        <template #extra>剩余时间到达阈值时大屏响铃并闪烁提示，最多 {{ STAGE_LIMITS.maxWarnThresholds }} 个。</template>
      </a-form-item>

      <a-form-item field="soundId" label="提示音">
        <a-space>
          <a-select v-model="form.soundId" style="width: 200px">
            <a-option :value="NO_SOUND">不提示</a-option>
            <a-option v-for="id in BUILTIN_SOUND_IDS" :key="id" :value="id" :label="`${SOUND_LABEL[id] ?? id}（${id}）`" />
          </a-select>
          <a-button @click="previewSound">试听</a-button>
        </a-space>
      </a-form-item>

      <a-form-item field="description" label="环节说明（大屏展示）">
        <a-textarea v-model="form.description" :max-length="STAGE_LIMITS.maxDescriptionLength" :auto-size="{ minRows: 2, maxRows: 4 }" allow-clear />
      </a-form-item>
    </a-form>
  </a-drawer>
</template>
