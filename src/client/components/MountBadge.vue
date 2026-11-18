<script setup lang="ts">
import { OUTPUT_CATEGORY_LABELS } from '../../domain/constants.ts';
import type { OutputCategory } from '../../domain/types.ts';

const props = defineProps<{
  readonly category: OutputCategory;
}>();
</script>

<template>
  <span
    class="vo-mount-badge vo-mono"
    :title="`Already present in ${OUTPUT_CATEGORY_LABELS[props.category]} mount on disk`"
  >
    💾 {{ OUTPUT_CATEGORY_LABELS[props.category] }}
  </span>
</template>

<style scoped lang="scss">
.vo-mount-badge {
  display: inline-flex;
  align-items: center;
  gap: calc(var(--vo-space-1) / 2);
  padding: calc(var(--vo-space-1) / 4) var(--vo-space-1);
  border: 1px solid color-mix(in oklch, var(--vo-warning) 48%, var(--vo-border));
  border-radius: var(--vo-radius-sm);
  background-color: color-mix(in oklch, var(--vo-warning) 12%, transparent);
  color: var(--vo-warning);
  font-size: var(--vo-text-2xs);
  font-weight: var(--vo-weight-medium);
  white-space: nowrap;
}
</style>
