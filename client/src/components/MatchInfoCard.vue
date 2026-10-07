<script setup lang="ts">
/**
 * 比赛信息卡片（Arco Card + Form）
 *
 * 状态边界：只读 store.config 做初始化，提交时把**补丁**交给父组件走 setConfig 指令——
 * 服务端会做白名单校验（matchId / entryCode 刻意不可改），这里的前置校验仅为体验优化。
 *
 * 重新载入的时机刻意收窄为「进场 + 换场（matchId 变化）」：
 * 每次广播都刷新表单会覆盖主席正在输入的内容。
 */
import { reactive, watch } from 'vue';
import { Message } from '@arco-design/web-vue';
import { CONFIG_LIMITS, type MatchConfig } from '@/types/debate';
import { useDebateStore } from '@/stores/debateStore';

defineProps<{ disabled: boolean; saving?: boolean }>();
const emit = defineEmits<{ (e: 'submit', patch: Partial<MatchConfig>): void }>();

const store = useDebateStore();

const form = reactive({
  name: '',
  topic: '',
  affTeam: '',
  affTitle: '',
  affColor: '#e5484d',
  negTeam: '',
  negTitle: '',
  negColor: '#3b82f6',
  min: 0,
  max: 100,
  step: 1,
});

function load(): void {
  const config = store.config;
  if (!config) return;
  form.name = config.name;
  form.topic = config.topic;
  form.affTeam = config.aff.teamName;
  form.affTitle = config.aff.title;
  form.affColor = config.aff.color;
  form.negTeam = config.neg.teamName;
  form.negTitle = config.neg.title;
  form.negColor = config.neg.color;
  form.min = config.scoreScale.min;
  form.max = config.scoreScale.max;
  form.step = config.scoreScale.step;
}

watch(() => store.config?.matchId, () => load(), { immediate: true });

function submit(): void {
  if (!form.name.trim()) {
    Message.error('比赛名称不能为空');
    return;
  }
  if (!form.topic.trim()) {
    Message.error('辩题不能为空');
    return;
  }
  if (!(Number(form.min) < Number(form.max))) {
    Message.error('评分刻度的最低分必须小于最高分');
    return;
  }
  if (!(Number(form.step) > 0)) {
    Message.error('评分刻度步长必须大于 0');
    return;
  }
  emit('submit', {
    name: form.name.trim(),
    topic: form.topic.trim(),
    // logoUrl 当前无上传入口，原样带回以免保存时把已有队徽清空
    aff: { teamName: form.affTeam.trim(), title: form.affTitle.trim(), color: form.affColor, logoUrl: store.config?.aff.logoUrl ?? null },
    neg: { teamName: form.negTeam.trim(), title: form.negTitle.trim(), color: form.negColor, logoUrl: store.config?.neg.logoUrl ?? null },
    scoreScale: { min: Number(form.min), max: Number(form.max), step: Number(form.step) },
  });
}
</script>

<template>
  <a-card title="比赛信息" class="card">
    <a-form :model="form" layout="vertical">
      <a-row :gutter="16">
        <a-col :span="14">
          <a-form-item label="辩题">
            <a-input v-model="form.topic" :max-length="CONFIG_LIMITS.maxTopicLength" :disabled="disabled" allow-clear />
          </a-form-item>
        </a-col>
        <a-col :span="10">
          <a-form-item label="比赛名称">
            <a-input v-model="form.name" :max-length="CONFIG_LIMITS.maxNameLength" :disabled="disabled" allow-clear />
          </a-form-item>
        </a-col>
      </a-row>

      <a-divider orientation="left">正方</a-divider>
      <a-row :gutter="16">
        <a-col :span="8">
          <a-form-item label="队名">
            <a-input v-model="form.affTeam" :max-length="CONFIG_LIMITS.maxTeamNameLength" :disabled="disabled" />
          </a-form-item>
        </a-col>
        <a-col :span="8">
          <a-form-item label="称谓">
            <a-input v-model="form.affTitle" :max-length="CONFIG_LIMITS.maxTitleLength" :disabled="disabled" />
          </a-form-item>
        </a-col>
        <a-col :span="8">
          <a-form-item label="主色">
            <a-color-picker v-model="form.affColor" :disabled="disabled" />
          </a-form-item>
        </a-col>
      </a-row>

      <a-divider orientation="left">反方</a-divider>
      <a-row :gutter="16">
        <a-col :span="8">
          <a-form-item label="队名">
            <a-input v-model="form.negTeam" :max-length="CONFIG_LIMITS.maxTeamNameLength" :disabled="disabled" />
          </a-form-item>
        </a-col>
        <a-col :span="8">
          <a-form-item label="称谓">
            <a-input v-model="form.negTitle" :max-length="CONFIG_LIMITS.maxTitleLength" :disabled="disabled" />
          </a-form-item>
        </a-col>
        <a-col :span="8">
          <a-form-item label="主色">
            <a-color-picker v-model="form.negColor" :disabled="disabled" />
          </a-form-item>
        </a-col>
      </a-row>

      <a-divider orientation="left">评分刻度</a-divider>
      <a-row :gutter="16">
        <a-col :span="6">
          <a-form-item label="最低分">
            <a-input-number v-model="form.min" :disabled="disabled" :max="CONFIG_LIMITS.maxScore" />
          </a-form-item>
        </a-col>
        <a-col :span="6">
          <a-form-item label="最高分">
            <a-input-number v-model="form.max" :disabled="disabled" :max="CONFIG_LIMITS.maxScore" />
          </a-form-item>
        </a-col>
        <a-col :span="6">
          <a-form-item label="步长">
            <a-input-number v-model="form.step" :disabled="disabled" :min="0.1" :step="0.5" />
          </a-form-item>
        </a-col>
      </a-row>

      <a-space>
        <a-button type="primary" :disabled="disabled" :loading="saving" @click="submit">保存比赛信息</a-button>
        <a-button :disabled="disabled" @click="load">还原</a-button>
        <a-tag v-if="store.config">入场码：{{ store.config.entryCode }}</a-tag>
      </a-space>
    </a-form>
  </a-card>
</template>

<style scoped>
.card {
  min-height: 120px;
}
</style>
