<script setup lang="ts">
/**
 * 比分后台：历史场次列表
 *
 * 只读消费 GET /api/matches（含已归档场次），不参与实时广播。
 * 点击某场进入赛后报告页看分环节明细。
 */
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Message } from '@arco-design/web-vue';
import { fetchMatches, type MatchSummary } from '@/api/matches';

const router = useRouter();
const matches = ref<MatchSummary[]>([]);
const loading = ref(false);
const errorText = ref('');

const STATUS_MAP: Record<string, { text: string; color: string }> = {
  idle: { text: '未开始', color: 'gray' },
  configured: { text: '已配置', color: 'arcoblue' },
  running: { text: '进行中', color: 'green' },
  paused: { text: '已暂停', color: 'orange' },
  finished: { text: '已结束', color: 'purple' },
};

function statusOf(s: MatchSummary) {
  // 已归档（ended_at 非空）优先显示为「已归档」
  if (s.endedAt != null) return { text: '已归档', color: 'gray' };
  return STATUS_MAP[s.status] ?? { text: s.status, color: 'gray' };
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function load(): Promise<void> {
  loading.value = true;
  errorText.value = '';
  const res = await fetchMatches();
  loading.value = false;
  if (!res.ok) {
    errorText.value = res.error ?? '加载失败';
    Message.error(errorText.value);
    return;
  }
  matches.value = res.data ?? [];
}

function openReport(matchId: string): void {
  router.push(`/board/${matchId}`);
}

onMounted(load);
</script>

<template>
  <div class="board">
    <a-page-header title="比分后台" subtitle="历史场次查询与赛后成绩单">
      <template #extra>
        <a-space>
          <a-button @click="router.push('/admin')">返回控制台</a-button>
          <a-button type="primary" :loading="loading" @click="load">刷新</a-button>
        </a-space>
      </template>
    </a-page-header>

    <a-layout-content class="content">
      <a-card>
        <a-table
          :data="matches"
          :loading="loading"
          row-key="matchId"
          :pagination="{ pageSize: 10, showTotal: true }"
          :bordered="false"
        >
          <template #columns>
            <a-table-column title="比赛名称" data-index="name" :width="200" ellipsis tooltip />
            <a-table-column title="辩题" data-index="topic" ellipsis tooltip />
            <a-table-column title="状态" :width="100">
              <template #cell="{ record }">
                <a-tag :color="statusOf(record).color">{{ statusOf(record).text }}</a-tag>
              </template>
            </a-table-column>
            <a-table-column title="评委数" :width="90" align="center">
              <template #cell="{ record }">{{ record.judgeCount }}</template>
            </a-table-column>
            <a-table-column title="评分数" :width="90" align="center">
              <template #cell="{ record }">{{ record.scoreCount }}</template>
            </a-table-column>
            <a-table-column title="创建时间" :width="160">
              <template #cell="{ record }">{{ fmtTime(record.createdAt) }}</template>
            </a-table-column>
            <a-table-column title="操作" :width="110" align="center">
              <template #cell="{ record }">
                <a-button type="text" @click="openReport(record.matchId)">查看成绩</a-button>
              </template>
            </a-table-column>
          </template>
          <template #empty>
            <a-empty description="暂无历史场次（每场比赛结束后会归档到这里）" />
          </template>
        </a-table>
        <a-alert v-if="errorText" type="error" :content="errorText" class="err" />
      </a-card>
    </a-layout-content>
  </div>
</template>

<style scoped>
.board {
  height: 100%;
  background: var(--color-fill-1);
}
.content {
  padding: 16px 24px 24px;
}
.err {
  margin-top: 12px;
}
</style>
