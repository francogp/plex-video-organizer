<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { ActiveParallelTask, ItemId } from '../../domain/types.ts';

const props = defineProps<{
  readonly tasks: readonly ActiveParallelTask[];
  readonly canSkip?: boolean;
}>();

const emit = defineEmits<{
  skip: [itemId: ItemId];
}>();

const skippingIds = ref<ReadonlySet<ItemId>>(new Set());
const listRef = ref<HTMLUListElement | null>(null);
const minHeightPx = ref(0);
let resizeObserver: ResizeObserver | null = null;

function updateMinHeight(): void {
  const el = listRef.value;
  if (!el) {
    return;
  }
  const nextHeight = Math.ceil(el.getBoundingClientRect().height);
  if (nextHeight > minHeightPx.value) {
    minHeightPx.value = nextHeight;
  }
}

onMounted((): void => {
  updateMinHeight();
  if (typeof ResizeObserver !== 'undefined' && listRef.value) {
    resizeObserver = new ResizeObserver((): void => {
      updateMinHeight();
    });
    resizeObserver.observe(listRef.value);
  }
});

onBeforeUnmount((): void => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});

watch(
  () => props.tasks,
  async (tasks) => {
    const activeIds = new Set(tasks.map((t) => t.itemId).filter((id): id is ItemId => Boolean(id)));
    if (skippingIds.value.size > 0) {
      const next = new Set<ItemId>();
      for (const id of skippingIds.value) {
        if (activeIds.has(id)) {
          next.add(id);
        }
      }
      skippingIds.value = next;
    }
    await nextTick();
    updateMinHeight();
  }
);

function handleSkip(itemId: ItemId): void {
  const next = new Set(skippingIds.value);
  next.add(itemId);
  skippingIds.value = next;
  emit('skip', itemId);
}
</script>

<template>
  <ul
    v-if="props.tasks.length > 0 || minHeightPx > 0"
    ref="listRef"
    class="vo-progress__files vo-mono"
    :style="minHeightPx > 0 ? { minBlockSize: `${String(minHeightPx)}px` } : undefined"
  >
    <li
      v-for="task in props.tasks"
      :key="task.slot"
      class="vo-progress__file"
      :class="{ 'vo-progress__file--skippable': Boolean(props.canSkip && task.itemId) }"
    >
      <span v-if="task.percent !== undefined" class="vo-progress__file-pct">
        {{ String(task.percent) }}%
      </span>
      <span class="vo-progress__file-name" :title="task.fileName">{{ task.fileName }}</span>
      <button
        v-if="props.canSkip && task.itemId"
        type="button"
        class="vo-btn vo-progress__skip"
        :disabled="skippingIds.has(task.itemId)"
        @click="handleSkip(task.itemId)"
      >
        {{ skippingIds.has(task.itemId) ? 'Skipping...' : 'Skip' }}
      </button>
    </li>
  </ul>
</template>

<style scoped lang="scss">
.vo-progress__files {
  display: grid;
  gap: var(--vo-space-1);
  inline-size: 100%;
  min-inline-size: 0;
  margin-block: 0;
  padding-inline-start: 0;
  list-style: none;
}

.vo-progress__file {
  display: grid;
  align-items: baseline;
  gap: var(--vo-space-2);
  grid-template-columns: 4ch minmax(0, 1fr);
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
  min-inline-size: 0;
}

.vo-progress__file--skippable {
  align-items: center;
  grid-template-columns: 4ch minmax(0, 1fr) auto;
}

.vo-progress__file-name {
  grid-column: 2;
  overflow: hidden;
  min-inline-size: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vo-progress__file-pct {
  color: var(--vo-accent);
  text-align: end;
  grid-column: 1;
  font-variant-numeric: tabular-nums;
}

.vo-progress__skip {
  font-size: var(--vo-text-xs);
  padding-block: var(--vo-space-1);
  padding-inline: var(--vo-space-2);
  grid-column: 3;
}
</style>
