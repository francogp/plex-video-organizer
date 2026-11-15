<script setup lang="ts">
import type { ConflictComparison, ConflictDecision, ItemId } from '../../domain/types.ts';
import ConflictActionButton from './ConflictActionButton.vue';

defineProps<{
  readonly conflict: ConflictComparison<ItemId> | undefined;
  readonly decision?: ConflictDecision;
  readonly disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'open'): void;
}>();
</script>

<template>
  <div
    v-if="conflict"
    class="vo-cell-conflict"
    :class="{ 'vo-cell-conflict--resolved': Boolean(decision) }"
  >
    <span
      class="vo-badge vo-badge--truncate"
      :class="decision ? 'vo-badge--warn' : 'vo-badge--danger'"
      :title="conflict.displayPath ?? conflict.existingPath ?? conflict.destinationPath"
    >
      {{
        conflict.kind === 'existing-file'
          ? '⚠ Conflict: Exists in output'
          : '⚠ Conflict: Duplicate destination'
      }}
    </span>
    <ConflictActionButton :decision="decision" :disabled="disabled" @click="emit('open')" />
  </div>
</template>

<style scoped lang="scss">
.vo-cell-conflict {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: var(--vo-space-3);
  padding: var(--vo-space-2) var(--vo-space-3);
  border: 1px solid color-mix(in oklch, var(--vo-danger) 45%, var(--vo-border));
  border-radius: var(--vo-radius-sm);
  background: color-mix(in oklch, var(--vo-danger) 8%, var(--vo-surface-elevated));
  margin-block-start: var(--vo-space-2);
}

.vo-cell-conflict--resolved {
  background: color-mix(in oklch, var(--vo-warning) 8%, var(--vo-surface-elevated));
  border-color: color-mix(in oklch, var(--vo-warning) 45%, var(--vo-border));
}
</style>
