<script setup lang="ts">
import { computed } from 'vue';

import { OUTPUT_CATEGORIES } from '../../domain/constants.ts';
import type { OutputCategory, VerifierState } from '../../domain/types.ts';
import { formatEta } from '../utils/formatters.ts';
import ParallelTasksList from './ParallelTasksList.vue';
import TableResetCount from './table/TableResetCount.vue';

const CATEGORY_LABELS: ReadonlyMap<OutputCategory, string> = new Map([
  ['movies', 'Movies'],
  ['animated-movies', 'Animated Movies'],
  ['tv-shows', 'TV Shows'],
  ['animated-series', 'Animated Series']
]);

function categoryLabel(category: OutputCategory): string {
  return CATEGORY_LABELS.get(category) ?? category;
}

const props = defineProps<{
  state: VerifierState;
  searchQuery: string;
  filterCategory: OutputCategory | 'all';
  shownCount: number;
  totalCount: number;
}>();

const emit = defineEmits<{
  'update:searchQuery': [value: string];
  'update:filterCategory': [value: OutputCategory | 'all'];
  'dismiss-error': [];
  'reset-columns': [];
}>();

const etaLabel = computed((): string =>
  props.state.progress
    ? formatEta(props.state.progress.etaSeconds, props.state.progress.etaState)
    : ''
);
</script>

<template>
  <section
    class="vo-status-bar vo-panel"
    :class="{
      'vo-status-bar--busy': props.state.scanning || props.state.fixing,
      'vo-status-bar--error': Boolean(props.state.lastFixResult?.errors.length)
    }"
    aria-live="polite"
  >
    <template v-if="props.state.scanning || props.state.fixing">
      <div class="vo-progress__stack">
        <div class="vo-progress__row">
          <div class="vo-progress__meta vo-mono">
            <template v-if="props.state.progress && props.state.progress.total > 0">
              {{ props.state.fixing ? 'Fixing' : 'Scanning' }} ·
              {{ props.state.progress.completed }}/{{ props.state.progress.total }} ({{
                props.state.progress.percent
              }}%){{ etaLabel ? ` · ${etaLabel}` : ''
              }}{{ props.state.progress.stageLabel ? ` · ${props.state.progress.stageLabel}` : '' }}
            </template>
            <template v-else>
              {{ props.state.fixing ? 'Fixing' : 'Scanning' }} ·
              {{ props.state.progress?.stageLabel || 'Discovering libraries...' }}
            </template>
          </div>
        </div>
        <ParallelTasksList v-if="props.state.progress" :tasks="props.state.progress.activeTasks" />
        <progress
          v-if="props.state.progress && props.state.progress.total > 0"
          class="vo-progress__bar"
          :value="props.state.progress.percent"
          max="100"
        />
        <progress v-else class="vo-progress__bar" />
      </div>
    </template>
    <template v-else-if="props.state.lastFixResult?.errors.length">
      <span class="vo-status-bar__error" role="alert">
        {{ props.state.lastFixResult.errors.join('; ') }}
      </span>
      <button type="button" class="vo-btn" @click="emit('dismiss-error')">
        <span aria-hidden="true">✖️</span> Dismiss
      </button>
    </template>
    <template v-else>
      <span class="vo-status-bar__idle vo-mono">
        <template v-if="props.state.summary">
          Ready · {{ props.state.summary.issueCount }} non-compliant folder(s) across
          {{ props.state.summary.librariesScanned }} libraries
        </template>
        <template v-else>Ready · Click Scan Libraries to verify Plex naming compliance</template>
      </span>
    </template>
  </section>

  <div class="vo-verifier__toolbar vo-panel">
    <div class="vo-verifier__stats">
      <template v-if="props.state.summary">
        <span class="vo-badge">
          Libraries: <strong>{{ props.state.summary.librariesScanned }}</strong>
        </span>
        <span class="vo-badge">
          Root Folders: <strong>{{ props.state.summary.totalRootsAnalyzed }}</strong>
        </span>
        <span class="vo-badge vo-badge--ok">
          Compliant: <strong>{{ props.state.summary.compliantRoots }}</strong>
        </span>
        <span class="vo-badge vo-badge--danger">
          Non-compliant: <strong>{{ props.state.summary.issueCount }}</strong>
        </span>
        <span class="vo-badge">
          Seasons: <strong>{{ props.state.summary.totalSeasonDirsAnalyzed }}</strong>
        </span>
        <span class="vo-badge">
          Files Analyzed: <strong>{{ props.state.summary.totalFilesAnalyzed }}</strong>
        </span>
      </template>
      <span v-else class="vo-muted">
        No library audit run yet. Click Scan Libraries to verify Plex naming compliance.
      </span>
    </div>

    <div class="vo-verifier__controls">
      <input
        :value="props.searchQuery"
        type="search"
        class="vo-input"
        placeholder="Filter by folder or issue..."
        aria-label="Filter non-compliant entries"
        @input="emit('update:searchQuery', ($event.target as HTMLInputElement).value)"
      />
      <select
        :value="props.filterCategory"
        class="vo-select"
        aria-label="Filter by library"
        @change="
          emit(
            'update:filterCategory',
            ($event.target as HTMLSelectElement).value as OutputCategory | 'all'
          )
        "
      >
        <option value="all">All libraries</option>
        <option v-for="cat in OUTPUT_CATEGORIES" :key="cat" :value="cat">
          {{ categoryLabel(cat) }}
        </option>
      </select>
      <TableResetCount
        :shown-count="props.shownCount"
        :total-count="props.totalCount"
        @reset="emit('reset-columns')"
      />
    </div>
  </div>
</template>

<style scoped lang="scss">
.vo-verifier__toolbar {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: var(--vo-space-3);
  padding: var(--vo-space-3);
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-md);
  background: var(--vo-surface-gradient);
  box-shadow: var(--vo-shadow-panel);
}

.vo-verifier__stats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-2);
  font-size: var(--vo-text-xs);
}

.vo-verifier__controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-2);
}

.vo-muted {
  color: var(--vo-text-muted);
}
</style>
