<script setup lang="ts">
import type { SseLogEvent } from '../../domain/types.ts';
import { formatBuenosAiresTimestamp } from '../utils/formatters.ts';

const props = defineProps<{
  readonly logs: readonly SseLogEvent[];
}>();

const emit = defineEmits<{
  clear: [];
}>();
</script>

<template>
  <section class="vo-logs vo-panel" aria-label="Server logs">
    <div class="vo-logs__header">
      <h2>
        Server Logs
        <span class="vo-badge vo-badge--compact">{{ String(props.logs.length) }}</span>
      </h2>
      <button
        type="button"
        class="vo-btn"
        :disabled="props.logs.length === 0"
        @click="emit('clear')"
      >
        <span aria-hidden="true">🧹</span>
        Clear
      </button>
    </div>
    <div v-if="props.logs.length === 0" class="vo-logs__empty vo-mono">
      No server logs yet. Click Scan Input or Process Queue to see activity.
    </div>
    <ul v-else class="vo-logs__list vo-mono">
      <li
        v-for="(entry, idx) in props.logs"
        :key="`${entry.timestamp}-${String(idx)}`"
        class="vo-logs__item"
        :data-level="entry.level"
      >
        <time class="vo-logs__time" :datetime="entry.timestamp">
          {{ formatBuenosAiresTimestamp(entry.timestamp) }}
        </time>
        <span class="vo-logs__level">[{{ entry.level.toUpperCase() }}]</span>
        <span class="vo-logs__msg">{{ entry.message }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped lang="scss">
.vo-logs {
  display: grid;
  gap: var(--vo-space-3);
  padding: var(--vo-space-4);
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-lg);
  background: var(--vo-surface-gradient);
  box-shadow: var(--vo-shadow-panel);
}

.vo-logs__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--vo-space-2);

  h2 {
    margin: 0;
    font-size: var(--vo-text-md);
  }
}

.vo-logs__empty {
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
}

.vo-logs__list {
  display: grid;
  gap: var(--vo-space-1);
  max-height: 240px;
  margin: 0;
  padding: var(--vo-space-2);
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-sm);
  background-color: var(--vo-bg);
  font-size: var(--vo-text-xs);
  overflow-y: auto;
  list-style: none;
}

.vo-logs__item {
  display: flex;
  flex-wrap: wrap;
  gap: var(--vo-space-2);
  line-height: 1.4;

  &[data-level='error'] {
    color: var(--vo-danger);
  }

  &[data-level='warn'] {
    color: var(--vo-warning);
  }
}

.vo-logs__time {
  color: var(--vo-text-muted);
}

.vo-logs__level {
  font-weight: var(--vo-weight-semibold);
}

.vo-logs__msg {
  overflow-wrap: anywhere;
}
</style>
