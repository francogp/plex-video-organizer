<script setup lang="ts">
import { ref, watch } from 'vue';

import type { ActiveParallelTask, ItemId } from '../../domain/types.ts';

const props = defineProps<{
  readonly tasks: readonly ActiveParallelTask[];
  readonly canSkip?: boolean;
}>();

const emit = defineEmits<{
  skip: [itemId: ItemId];
}>();

const skippingIds = ref<ReadonlySet<ItemId>>(new Set());

watch(
  () => props.tasks,
  (tasks) => {
    const activeIds = new Set(tasks.map((t) => t.itemId).filter((id): id is ItemId => Boolean(id)));
    if (skippingIds.value.size === 0) {
      return;
    }
    const next = new Set<ItemId>();
    for (const id of skippingIds.value) {
      if (activeIds.has(id)) {
        next.add(id);
      }
    }
    skippingIds.value = next;
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
  <ul v-if="props.tasks.length > 0" class="vo-progress__files vo-mono">
    <li
      v-for="task in props.tasks"
      :key="task.slot"
      class="vo-progress__file"
      :class="{ 'vo-progress__file--skippable': Boolean(props.canSkip && task.itemId) }"
    >
      <span v-if="task.percent !== undefined" class="vo-progress__file-pct">
        {{ String(task.percent) }}%
      </span>
      <span class="vo-progress__file-name">{{ task.fileName }}</span>
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
  min-inline-size: 0;
  overflow-wrap: anywhere;
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
