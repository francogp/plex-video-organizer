<script setup lang="ts">
defineProps<{
  readonly shownCount: number;
  readonly totalCount: number;
}>();

const emit = defineEmits<{
  reset: [];
}>();
</script>

<template>
  <button type="button" class="vo-btn" @click="emit('reset')">
    <span aria-hidden="true">🔄</span> Reset Columns
  </button>
  <span class="vo-table-count vo-mono" aria-live="polite">
    Showing {{ shownCount }} of {{ totalCount }}
  </span>
</template>

<style scoped lang="scss">
.vo-table-count {
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
  margin-inline-start: auto;
  white-space: nowrap;
}
</style>
