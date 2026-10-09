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
import { CONFIG_LIMITS, type MatchConfig, type Speaker } from '@/types/debate';
import { useDebateStore } from '@/stores/debateStore';

defineProps<{ disabled: boolean; saving?: boolean }>();
const emit = defineEmits<{ (e: 'submit', patch: Partial<MatchConfig>): void }>();

const store = useDebateStore();

interface SpeakerDraft {
  position: string;
  name: string;
}

const form = reactive({
  name: '',
  topic: '',
  affStance: '',
  negStance: '',
  affTeam: '',
  affTitle: '',
  affColor: '#e5484d',
  affSpeakers: [] as SpeakerDraft[],
  negTeam: '',
  negTitle: '',
  negColor: '#3b82f6',
  negSpeakers: [] as SpeakerDraft[],
  min: 0,
  max: 100,
  step: 1,
});

function load(): void {
  const config = store.config;
  if (!config) return;
  form.name = config.name;
  form.topic = config.topic;
  form.affStance = config.affStance;
  form.negStance = config.negStance;
  form.affTeam = config.aff.teamName;
  form.affTitle = config.aff.title;
  form.affColor = config.aff.color;
  form.affSpeakers = config.aff.speakers.map((s) => ({ ...s }));
  form.negTeam = config.neg.teamName;
  form.negTitle = config.neg.title;
  form.negColor = config.neg.color;
  form.negSpeakers = config.neg.speakers.map((s) => ({ ...s }));
  form.min = config.scoreScale.min;
  form.max = config.scoreScale.max;
  form.step = config.scoreScale.step;
}

watch(() => store.config?.matchId, () => load(), { immediate: true });

function addSpeaker(list: SpeakerDraft[]): void {
  if (list.length >= CONFIG_LIMITS.maxSpeakers) {
    Message.warning(`最多 ${CONFIG_LIMITS.maxSpeakers} 位辩手`);
    return;
  }
  list.push({ position: '', name: '' });
}

function removeSpeaker(list: SpeakerDraft[], index: number): void {
  list.splice(index, 1);
}

/** 清洗辩手名单：去掉姓名为空的行 */
function cleanSpeakers(list: SpeakerDraft[]): Speaker[] {
  return list
    .filter((s) => s.name.trim() !== '')
    .map((s) => ({ position: s.position.trim(), name: s.name.trim() }));
}

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
    affStance: form.affStance.trim(),
    negStance: form.negStance.trim(),
    // logoUrl 当前无上传入口，原样带回以免保存时把已有队徽清空
    aff: {
      teamName: form.affTeam.trim(),
      title: form.affTitle.trim(),
      color: form.affColor,
      logoUrl: store.config?.aff.logoUrl ?? null,
      speakers: cleanSpeakers(form.affSpeakers),
    },
    neg: {
      teamName: form.negTeam.trim(),
      title: form.negTitle.trim(),
      color: form.negColor,
      logoUrl: store.config?.neg.logoUrl ?? null,
      speakers: cleanSpeakers(form.negSpeakers),
    },
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

      <a-row :gutter="16">
        <a-col :span="12">
          <a-form-item label="正方观点（大屏红条）">
            <a-input v-model="form.affStance" :max-length="CONFIG_LIMITS.maxStanceLength" :disabled="disabled" allow-clear placeholder="空则大屏回退显示辩题" />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item label="反方观点（大屏蓝条）">
            <a-input v-model="form.negStance" :max-length="CONFIG_LIMITS.maxStanceLength" :disabled="disabled" allow-clear placeholder="空则大屏回退显示辩题" />
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
      <a-form-item label="正方辩手（辩位 + 姓名）">
        <div class="speaker-list">
          <div v-for="(sp, i) in form.affSpeakers" :key="i" class="speaker-row">
            <a-input v-model="sp.position" class="speaker-position" :max-length="CONFIG_LIMITS.maxSpeakerPositionLength" :disabled="disabled" placeholder="辩位，如一辩" />
            <a-input v-model="sp.name" class="speaker-name" :max-length="CONFIG_LIMITS.maxSpeakerNameLength" :disabled="disabled" placeholder="姓名" />
            <a-button :disabled="disabled" @click="removeSpeaker(form.affSpeakers, i)">删除</a-button>
          </div>
          <a-button :disabled="disabled" @click="addSpeaker(form.affSpeakers)">+ 添加辩手</a-button>
        </div>
      </a-form-item>

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
      <a-form-item label="反方辩手（辩位 + 姓名）">
        <div class="speaker-list">
          <div v-for="(sp, i) in form.negSpeakers" :key="i" class="speaker-row">
            <a-input v-model="sp.position" class="speaker-position" :max-length="CONFIG_LIMITS.maxSpeakerPositionLength" :disabled="disabled" placeholder="辩位，如一辩" />
            <a-input v-model="sp.name" class="speaker-name" :max-length="CONFIG_LIMITS.maxSpeakerNameLength" :disabled="disabled" placeholder="姓名" />
            <a-button :disabled="disabled" @click="removeSpeaker(form.negSpeakers, i)">删除</a-button>
          </div>
          <a-button :disabled="disabled" @click="addSpeaker(form.negSpeakers)">+ 添加辩手</a-button>
        </div>
      </a-form-item>

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
.speaker-list {
  display: block;
  width: 100%;
}
.speaker-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  align-items: center;
  /* 每个辩手行独占一行：flex 子项默认会挤成一行溢出卡片 */
  width: 100%;
  flex-wrap: wrap;
}
.speaker-position {
  width: 120px;
}
.speaker-name {
  width: 180px;
}
</style>
