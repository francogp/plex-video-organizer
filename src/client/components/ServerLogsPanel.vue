<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  ref,
  useId,
  watch,
  type ComponentPublicInstance
} from 'vue';

import type { SseLogEvent } from '../../domain/types.ts';
import {
  animatePanelEnter,
  animatePanelLeave,
  animateStaggerList,
  smoothScrollToBottom
} from '../composables/useGsapMotion.ts';
import { formatBuenosAiresTimestamp } from '../utils/formatters.ts';
import { getLogsAutoScrollPreference, saveLogsAutoScrollPreference } from '../utils/storage.ts';

const props = defineProps<{
  readonly logs: readonly SseLogEvent[];
}>();

const emit = defineEmits<{
  clear: [];
}>();

const autoScrollId = useId();
const autoScroll = ref(getLogsAutoScrollPreference());
const listRef = ref<ComponentPublicInstance | HTMLElement | null>(null);
const logKeys = computed<readonly string[]>(() => {
  const seen = new Map<string, number>();
  return props.logs.map((entry) => {
    const base = `${entry.timestamp}|${entry.level}|${entry.message}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return `${base}#${String(count)}`;
  });
});

function resolveListElement(): HTMLElement | null {
  const target = listRef.value;
  if (!target) {
    return null;
  }
  if (target instanceof HTMLElement) {
    return target;
  }
  return target.$el instanceof HTMLElement ? target.$el : null;
}

async function scrollLogsToLatest(): Promise<void> {
  if (!autoScroll.value || props.logs.length === 0) {
    return;
  }
  await nextTick();
  smoothScrollToBottom(resolveListElement());
}

function onLogsContainerEnter(el: Element, done: () => void): void {
  animatePanelEnter(el, done);
  if (el instanceof HTMLElement && el.classList.contains('vo-logs__list')) {
    animateStaggerList(el, '.vo-logs__item', true);
  }
}

onMounted((): void => {
  void scrollLogsToLatest().then((): void => {
    animateStaggerList(resolveListElement(), '.vo-logs__item', true);
  });
});

watch(
  (): readonly SseLogEvent[] => props.logs,
  (): void => {
    void scrollLogsToLatest();
  }
);

watch(autoScroll, (enabled: boolean): void => {
  saveLogsAutoScrollPreference(enabled);
  if (enabled) {
    void scrollLogsToLatest();
  }
});
</script>

<template>
  <section class="vo-logs vo-panel" aria-label="Server logs">
    <div class="vo-logs__header">
      <h2>
        Server Logs
        <span class="vo-badge vo-badge--compact">{{ String(props.logs.length) }}</span>
      </h2>
      <div class="vo-logs__actions">
        <label :for="autoScrollId" class="vo-logs__autoscroll">
          <input
            :id="autoScrollId"
            v-model="autoScroll"
            type="checkbox"
            class="vo-logs__checkbox"
          />
          <span>Auto-scroll</span>
        </label>
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
    </div>
    <Transition mode="out-in" :css="false" @enter="onLogsContainerEnter" @leave="animatePanelLeave">
      <div v-if="props.logs.length === 0" key="empty" class="vo-logs__empty vo-mono">
        No server logs yet. Click Scan Input or Process Queue to see activity.
      </div>
      <TransitionGroup
        v-else
        key="list"
        ref="listRef"
        tag="div"
        role="list"
        :css="false"
        class="vo-logs__list vo-mono"
        @enter="animatePanelEnter"
        @leave="animatePanelLeave"
      >
        <div
          v-for="(entry, idx) in props.logs"
          :key="logKeys[idx]"
          role="listitem"
          class="vo-logs__item"
          :data-level="entry.level"
        >
          <time class="vo-logs__time" :datetime="entry.timestamp">
            {{ formatBuenosAiresTimestamp(entry.timestamp) }}
          </time>
          <span class="vo-logs__level">[{{ entry.level.toUpperCase() }}]</span>
          <span class="vo-logs__msg">{{ entry.message }}</span>
        </div>
      </TransitionGroup>
    </Transition>
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
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: var(--vo-space-2);

  h2 {
    margin: 0;
    font-size: var(--vo-text-md);
  }
}

.vo-logs__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-3);
}

.vo-logs__autoscroll {
  display: inline-flex;
  align-items: center;
  gap: var(--vo-space-1);
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
  cursor: pointer;
  user-select: none;
}

.vo-logs__checkbox {
  margin: 0;
  cursor: pointer;
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
