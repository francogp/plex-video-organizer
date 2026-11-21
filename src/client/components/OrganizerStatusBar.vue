<script setup lang="ts">
import { computed } from 'vue';

import type { ActiveJobProgress, ItemId, JobPhase } from '../../domain/types.ts';
import { animatePanelEnter, animatePanelLeave } from '../composables/useGsapMotion.ts';
import ParallelTasksList from './ParallelTasksList.vue';
import UiIcon from './UiIcon.vue';

const props = withDefaults(
  defineProps<{
    readonly isBusy: boolean;
    readonly activeJob: ActiveJobProgress | null;
    readonly errorMessage: string | null;
    readonly isLockedByOther: boolean;
    readonly isCancellingJob: boolean;
    readonly isDrainingJob?: boolean;
    readonly canSkipTasks?: boolean;
    readonly canInspectEta?: boolean;
    readonly itemCount: number;
    readonly summaryText: string;
    readonly phase: JobPhase;
  }>(),
  {
    canInspectEta: undefined
  }
);

const emit = defineEmits<{
  cancel: [];
  drain: [];
  'dismiss-error': [];
  'open-eta-simulation': [];
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
    <Transition :css="false" mode="out-in" @enter="animatePanelEnter" @leave="animatePanelLeave">
      <div v-if="busy" key="busy" class="vo-progress__stack">
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
            v-if="
              !props.isLockedByOther &&
              (props.phase === 'PROCESSING' ||
                (Boolean(props.activeJob) && props.activeJob?.jobId !== 'scan'))
            "
            type="button"
            class="vo-btn vo-btn--warn vo-progress__cancel"
            :disabled="
              props.isCancellingJob ||
              props.isDrainingJob ||
              Boolean(props.activeJob?.drainRequested)
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
          <button
            v-if="props.activeJob"
            type="button"
            class="vo-btn vo-progress__eta-btn"
            title="View live ETA simulation & slot breakdown"
            @click="emit('open-eta-simulation')"
          >
            <UiIcon name="chart" />
            ETA Plan
          </button>
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

      <div v-else-if="props.errorMessage" key="error" class="vo-progress__row">
        <span class="vo-status-bar__error" role="alert">{{ props.errorMessage }}</span>
        <button type="button" class="vo-btn" @click="emit('dismiss-error')">
          <span aria-hidden="true">✖️</span>
          Dismiss
        </button>
      </div>

      <div v-else key="idle" class="vo-progress__row">
        <span class="vo-status-bar__idle vo-mono">
          Ready · {{ String(props.itemCount) }} item(s) in queue
        </span>
        <button
          v-if="props.canInspectEta ?? props.itemCount > 0"
          type="button"
          class="vo-btn vo-progress__eta-btn"
          title="Preview live ETA simulation & slot breakdown"
          @click="emit('open-eta-simulation')"
        >
          <UiIcon name="chart" />
          ETA Plan
        </button>
      </div>
    </Transition>
  </section>
</template>

<style scoped lang="scss">
.vo-progress__cancel {
  flex-shrink: 0;
}

.vo-progress__eta-btn {
  flex-shrink: 0;
  margin-inline-start: auto;
}
</style>
