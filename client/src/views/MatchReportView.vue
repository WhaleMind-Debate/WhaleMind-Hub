<script setup lang="ts">
/**
 * 赛后报告页：单场成绩单
 *
 * 只读消费 GET /api/matches/:matchId（totals + breakdown + judges），
 * 不含单个评委分数——与实时广播的"分数不外泄"口径一致。
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Message } from '@arco-design/web-vue';
import { exportMatchCsvUrl, fetchMatchDetail, type MatchDetail } from '@/api/matches';

const route = useRoute();
const router = useRouter();

const detail = ref<MatchDetail | null>(null);
const loading = ref(false);
const errorText = ref('');

const matchId = computed(() => String(route.params.matchId ?? ''));
const winner = computed(() => detail.value?.totals.winner ?? null);

async function load(): Promise<void> {
  loading.value = true;
  errorText.value = '';
  const res = await fetchMatchDetail(matchId.value);
  loading.value = false;
  if (!res.ok) {
    errorText.value = res.error ?? '加载失败';
    Message.error(errorText.value);
    return;
  }
  detail.value = res.data ?? null;
}

function exportCsv(): void {
  const a = document.createElement('a');
  a.href = exportMatchCsvUrl(matchId.value);
  a.download = `${matchId.value}-scores.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function fmtNum(v: number | null): string {
  return v == null ? '—' : v.toFixed(2);
}

onMounted(load);
</script>

<template>
  <div class="report">
    <a-page-header :title="detail?.config.name ?? '赛后成绩单'" subtitle="赛后报告">
      <template #extra>
        <a-space>
          <a-button @click="router.push('/board')">返回列表</a-button>
          <a-button type="primary" :loading="loading" @click="load">刷新</a-button>
          <a-button :disabled="!detail" @click="exportCsv">导出成绩 CSV</a-button>
        </a-space>
      </template>
    </a-page-header>

    <a-layout-content class="content">
      <a-spin :loading="loading" style="width: 100%">
        <a-alert v-if="errorText" type="error" :content="errorText" />

        <template v-if="detail">
          <!-- 辩题 + 胜负总分 -->
          <a-card class="hero">
            <div class="topic">{{ detail.config.topic }}</div>
            <div class="match-name">{{ detail.config.name }}</div>

            <div class="score-row">
              <div class="score-side" :class="{ winner: winner === 'aff' }">
                <div class="side-name">{{ detail.config.aff.teamName }}</div>
                <div class="side-stance">{{ detail.config.affStance || '正方' }}</div>
                <div class="score-value">{{ detail.totals.aff.weighted.toFixed(2) }}</div>
              </div>
              <div class="score-mid">
                <div class="winner-label">
                  {{ winner === null ? '平局' : winner === 'aff' ? '正方胜' : '反方胜' }}
                </div>
                <div class="meta">
                  {{ detail.totals.judgeCount }} 位评委 ·
                  正 {{ detail.totals.aff.scoredStages }} / 反 {{ detail.totals.neg.scoredStages }} 个环节计分
                </div>
              </div>
              <div class="score-side" :class="{ winner: winner === 'neg' }">
                <div class="side-name">{{ detail.config.neg.teamName }}</div>
                <div class="side-stance">{{ detail.config.negStance || '反方' }}</div>
                <div class="score-value">{{ detail.totals.neg.weighted.toFixed(2) }}</div>
              </div>
            </div>
          </a-card>

          <!-- 分环节明细 -->
          <a-card title="分环节明细" class="section">
            <a-table :data="detail.breakdown" row-key="stageId" :pagination="false" :bordered="false">
              <template #columns>
                <a-table-column title="#" :width="60" align="center">
                  <template #cell="{ record }">{{ record.order }}</template>
                </a-table-column>
                <a-table-column title="环节" data-index="name" />
                <a-table-column title="权重" :width="80" align="center">
                  <template #cell="{ record }">{{ record.weight }}</template>
                </a-table-column>
                <a-table-column title="正方均分" :width="120" align="center">
                  <template #cell="{ record }">{{ fmtNum(record.aff) }}</template>
                </a-table-column>
                <a-table-column title="正方评分数" :width="110" align="center">
                  <template #cell="{ record }">{{ record.affJudges }}</template>
                </a-table-column>
                <a-table-column title="反方均分" :width="120" align="center">
                  <template #cell="{ record }">{{ fmtNum(record.neg) }}</template>
                </a-table-column>
                <a-table-column title="反方评分数" :width="110" align="center">
                  <template #cell="{ record }">{{ record.negJudges }}</template>
                </a-table-column>
              </template>
              <template #empty>
                <a-empty description="本场暂无评分" />
              </template>
            </a-table>
            <div class="hint">
              加权总分 = Σ(环节平均分 × 环节权重)；未评分的环节不计入，也不按 0 分惩罚。
            </div>
          </a-card>

          <!-- 评委名单 -->
          <a-card title="评委" class="section">
            <a-space wrap>
              <a-tag v-for="j in detail.judges" :key="j.id" color="arcoblue">{{ j.name }}</a-tag>
              <span v-if="detail.judges.length === 0" class="hint">本场无评委记录</span>
            </a-space>
          </a-card>
        </template>
      </a-spin>
    </a-layout-content>
  </div>
</template>

<style scoped>
.report {
  height: 100%;
  background: var(--color-fill-1);
}
.content {
  padding: 16px 24px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 1100px;
}
.topic {
  font-size: 24px;
  font-weight: 700;
  text-align: center;
  line-height: 1.4;
}
.match-name {
  text-align: center;
  color: var(--color-text-3);
  margin-top: 6px;
}
.score-row {
  display: flex;
  align-items: center;
  gap: 24px;
  margin-top: 24px;
}
.score-side {
  flex: 1;
  text-align: center;
  padding: 16px;
  border-radius: 8px;
  background: var(--color-fill-1);
  opacity: 0.7;
  transition: opacity 0.2s;
}
.score-side.winner {
  opacity: 1;
  box-shadow: 0 0 0 2px rgb(var(--primary-6));
}
.side-name {
  font-size: 18px;
  font-weight: 600;
}
.side-stance {
  font-size: 13px;
  color: var(--color-text-3);
  margin-top: 4px;
}
.score-value {
  font-size: 40px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  margin-top: 8px;
}
.score-side.winner .score-value {
  color: rgb(var(--primary-6));
}
.score-mid {
  text-align: center;
  min-width: 180px;
}
.winner-label {
  font-size: 20px;
  font-weight: 700;
}
.meta {
  font-size: 12px;
  color: var(--color-text-3);
  margin-top: 6px;
}
.hint {
  font-size: 12px;
  color: var(--color-text-3);
  margin-top: 8px;
}
</style>
