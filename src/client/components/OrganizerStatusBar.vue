<script setup lang="ts">
import { computed } from 'vue';

import type { ActiveJobProgress, ItemId, JobPhase } from '../../domain/types.ts';
import ParallelTasksList from './ParallelTasksList.vue';

const props = defineProps<{
  readonly isBusy: boolean;
  readonly activeJob: ActiveJobProgress | null;
  readonly errorMessage: string | null;
  readonly isLockedByOther: boolean;
  readonly isCancellingJob: boolean;
  readonly isDrainingJob?: boolean;
  readonly canSkipTasks?: boolean;
  readonly itemCount: number;
  readonly summaryText: string;
  readonly phase: JobPhase;
}>();

const emit = defineEmits<{
  cancel: [];
  drain: [];
  'dismiss-error': [];
  'skip-task': [itemId: ItemId];
}>();

const busy = computed(() => props.isBusy || Boolean(props.activeJob));
</script>

<template>
  <section
    class="vo-status-bar vo-panel"
    :class="{
      'vo-status-bar--busy': busy,
      'vo-status-bar--error': Boolean(props.errorMessage)
    }"
    :data-phase="props.phase"
    aria-live="polite"
  >
    <div v-if="busy" class="vo-progress__stack">
      <div class="vo-progress__row">
        <button
          v-if="!props.isLockedByOther"
          type="button"
          class="vo-btn vo-btn--danger vo-progress__cancel"
          :disabled="props.isCancellingJob"
          @click="emit('cancel')"
        >
          <span aria-hidden="true">🛑</span>
          {{ props.isCancellingJob ? ' Cancelling...' : ' Cancel Job' }}
        </button>
        <button
          v-if="!props.isLockedByOther && props.phase === 'PROCESSING'"
          type="button"
          class="vo-btn vo-btn--warn vo-progress__cancel"
          :disabled="
            props.isCancellingJob || props.isDrainingJob || Boolean(props.activeJob?.drainRequested)
          "
          @click="emit('drain')"
        >
          <span aria-hidden="true">⏸️</span>
          {{
            props.isDrainingJob || props.activeJob?.drainRequested
              ? ' Stopping After Current...'
              : ' Stop After Current'
          }}
        </button>
        <div class="vo-progress__meta vo-mono">{{ props.summaryText }}</div>
      </div>
      <ParallelTasksList
        v-if="props.activeJob"
        :tasks="props.activeJob.activeTasks"
        :can-skip="props.canSkipTasks"
        @skip="emit('skip-task', $event)"
      />
      <progress
        v-if="props.activeJob && props.activeJob.totalItems > 0"
        class="vo-progress__bar"
        :value="props.activeJob.currentPercent"
        max="100"
      />
      <progress v-else class="vo-progress__bar" />
    </div>

    <div v-else-if="props.errorMessage" class="vo-progress__row">
      <span class="vo-status-bar__error" role="alert">{{ props.errorMessage }}</span>
      <button type="button" class="vo-btn" @click="emit('dismiss-error')">
        <span aria-hidden="true">✖️</span>
        Dismiss
      </button>
    </div>

    <span v-else class="vo-status-bar__idle vo-mono">
      Ready · {{ String(props.itemCount) }} item(s) in queue
    </span>
  </section>
</template>

<style scoped lang="scss">
.vo-progress__cancel {
  flex-shrink: 0;
}
</style>
