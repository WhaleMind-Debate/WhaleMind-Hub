<script setup lang="ts">
/**
 * 环节序列表格（Arco Table + Sortable 拖拽排序）
 *
 * 组件职责单一：只负责展示与交互，不持有任何赛制数据——草稿由父组件（AdminView）持有，
 * 这里通过事件把“想做什么”上报（新增 / 编辑 / 删除 / 上移下移 / 拖拽重排）。
 *
 * 拖拽实现要点：
 * - Sortable 直接挂在 Arco Table 的 tbody 上，只允许通过 .drag-handle 手柄拖动，
 *   避免与行内按钮、横向滚动冲突；
 * - Table 必须提供稳定的 row-key（草稿的 key），否则 Vue 的 DOM diff 会与 Sortable
 *   已经移动过的 DOM 打架；
 * - 数据变化后重新初始化，防止 Arco 重渲染后 Sortable 实例指向旧 DOM。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Sortable from 'sortablejs';
import { describeType, formatDuration, type StageDraft } from '@/stages/draft';

const props = defineProps<{
  stages: StageDraft[];
  /** 比赛已开始：赛制冻结，禁掉所有编辑入口 */
  disabled: boolean;
  /** 当前进行中的环节下标（-1 表示未开始），仅用于高亮 */
  currentIndex?: number;
}>();

const emit = defineEmits<{
  (e: 'add'): void;
  (e: 'edit', index: number): void;
  (e: 'remove', index: number): void;
  (e: 'move', from: number, to: number): void;
  (e: 'reorder', from: number, to: number): void;
}>();

const wrapper = ref<HTMLElement | null>(null);
let sortable: Sortable | null = null;

const rowKey = (record: StageDraft): string => record.key;
const rowClass = (_record: StageDraft, index: number): string =>
  index === props.currentIndex ? 'stage-row-current' : '';

const totalText = computed(() => formatDuration(props.stages.reduce((sum, s) => sum + s.durationMs, 0)));
const weightTotal = computed(() => {
  const total = props.stages.reduce((sum, s) => sum + s.weight, 0);
  return Math.round(total * 100) / 100;
});

function destroySortable(): void {
  sortable?.destroy();
  sortable = null;
}

function initSortable(): void {
  destroySortable();
  if (props.disabled) return;
  const tbody = wrapper.value?.querySelector('.arco-table-tbody');
  if (!tbody) return;
  sortable = Sortable.create(tbody as HTMLElement, {
    handle: '.drag-handle',
    animation: 150,
    ghostClass: 'stage-drag-ghost',
    onEnd: (event) => {
      const { oldIndex, newIndex } = event;
      if (oldIndex == null || newIndex == null || oldIndex === newIndex) return;
      emit('reorder', oldIndex, newIndex);
    },
  });
}

onMounted(() => {
  void nextTick(initSortable);
});

watch(
  () => [props.stages, props.disabled],
  () => {
    void nextTick(initSortable);
  },
  { deep: true },
);

onBeforeUnmount(destroySortable);
</script>

<template>
  <div ref="wrapper" class="stage-table">
    <div class="stage-toolbar">
      <a-space>
        <a-button type="primary" :disabled="disabled" @click="emit('add')">添加环节</a-button>
        <a-tag v-if="disabled" color="orange">比赛进行中，赛制已冻结</a-tag>
      </a-space>
      <span class="stage-summary">
        共 {{ stages.length }} 个环节 · 计时总长 {{ totalText }} · 权重合计 {{ weightTotal }}
      </span>
    </div>

    <a-table
      :data="stages"
      :row-key="rowKey"
      :row-class="rowClass"
      :pagination="false"
      :bordered="{ cell: true }"
      :scroll="{ x: 920 }"
      size="medium"
    >
      <template #columns>
        <a-table-column title="#" :width="56" align="center">
          <template #cell="{ rowIndex }">{{ rowIndex + 1 }}</template>
        </a-table-column>
        <a-table-column title="" :width="44" align="center">
          <template #cell>
            <span class="drag-handle" :class="{ 'is-disabled': disabled }" title="按住拖动排序">⠿</span>
          </template>
        </a-table-column>
        <a-table-column title="环节名称" data-index="name" :width="200" />
        <a-table-column title="类型" :width="150">
          <template #cell="{ record }">{{ describeType(record) }}</template>
        </a-table-column>
        <a-table-column title="时长" :width="90" align="right">
          <template #cell="{ record }">{{ formatDuration(record.durationMs) }}</template>
        </a-table-column>
        <a-table-column title="权重" :width="80" align="right">
          <template #cell="{ record }">{{ record.weight }}</template>
        </a-table-column>
        <a-table-column title="预警" :width="110">
          <template #cell="{ record }">
            <span v-if="!record.warnThresholds || record.warnThresholds.length === 0">—</span>
            <span v-else>{{ record.warnThresholds.map((t: number) => `${t}s`).join(' / ') }}</span>
          </template>
        </a-table-column>
        <a-table-column title="操作" :width="170" align="center" fixed="right">
          <template #cell="{ rowIndex }">
            <a-space :size="4">
              <a-button type="text" size="small" :disabled="disabled" @click="emit('edit', rowIndex)">编辑</a-button>
              <a-button
                type="text"
                size="small"
                :disabled="disabled || rowIndex === 0"
                title="上移"
                @click="emit('move', rowIndex, rowIndex - 1)"
              >
                上移
              </a-button>
              <a-button
                type="text"
                size="small"
                :disabled="disabled || rowIndex === stages.length - 1"
                title="下移"
                @click="emit('move', rowIndex, rowIndex + 1)"
              >
                下移
              </a-button>
              <a-popconfirm content="删除该环节？已提交的相关评分将不再计入总分。" @ok="emit('remove', rowIndex)">
                <a-button type="text" size="small" status="danger" :disabled="disabled">删除</a-button>
              </a-popconfirm>
            </a-space>
          </template>
        </a-table-column>
      </template>
      <template #empty>
        <a-empty description="还没有环节，点「添加环节」开始搭建赛制" />
      </template>
    </a-table>
  </div>
</template>

<style scoped>
.stage-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.stage-summary {
  font-size: 13px;
  color: var(--color-text-3);
}
.drag-handle {
  cursor: grab;
  color: var(--color-text-3);
  font-size: 16px;
  user-select: none;
}
.drag-handle:active {
  cursor: grabbing;
}
.drag-handle.is-disabled {
  cursor: not-allowed;
  opacity: 0.4;
}
</style>

<style>
/* Sortable 拖拽时的高亮行（不能写在 scoped 里：类名由 Sortable 与 Table 在运行时添加） */
.stage-drag-ghost > td {
  background-color: var(--color-primary-light-1) !important;
}
.stage-row-current > td {
  background-color: var(--color-fill-2);
}
</style>
