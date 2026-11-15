<script setup lang="ts">
import type { ConflictDecision } from '../../domain/types.ts';

withDefaults(
  defineProps<{
    readonly decision?: ConflictDecision;
    readonly disabled?: boolean;
    readonly title?: string;
  }>(),
  {
    decision: undefined,
    disabled: false,
    title: 'Compare files and choose Overwrite or Ignore'
  }
);

const emit = defineEmits<{
  (e: 'click'): void;
}>();
</script>

<template>
  <button
    type="button"
    class="vo-btn vo-btn--xs vo-conflict-action-btn"
    :class="{
      'vo-btn--primary': decision === 'overwrite',
      'vo-btn--warn': !decision
    }"
    :disabled="disabled"
    :title="title"
    @click="emit('click')"
  >
    <template v-if="decision === 'overwrite'">
      <span aria-hidden="true">✅</span> Overwrite
    </template>
    <template v-else-if="decision === 'ignore'">
      <span aria-hidden="true">⏭️</span> Ignore
    </template>
    <template v-else> <span aria-hidden="true">⚖️</span> Resolve conflict </template>
  </button>
</template>

<style scoped lang="scss">
.vo-conflict-action-btn {
  white-space: nowrap;
}
</style>
