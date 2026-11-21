<script setup lang="ts">
import {
  AUDIO_NORMALIZATION_MODES,
  MEDIA_KINDS,
  OUTPUT_CATEGORIES,
  type AudioNormalizationMode
} from '../../domain/constants.ts';
import type { ConflictDecision, MediaKind, OutputCategory } from '../../domain/types.ts';
import { animatePanelEnter, animatePanelLeave } from '../composables/useGsapMotion.ts';
import TableResetCount from './table/TableResetCount.vue';
import UiIcon from './UiIcon.vue';

export interface FolderOption {
  readonly prefix: string;
  readonly count: number;
}

const CATEGORY_LABELS: Readonly<Record<OutputCategory, string>> = {
  movies: 'Movies',
  'animated-movies': 'Animated Movies',
  'tv-shows': 'Series',
  'animated-series': 'Animated Series'
};

const AUDIO_MODE_LABELS: Readonly<Record<AudioNormalizationMode, string>> = {
  copy: 'Copy (original)',
  peak: 'Peak Gain',
  loudnorm: 'Loudnorm (2-pass)'
};

const props = defineProps<{
  searchQuery: string;
  kindFilter: MediaKind | 'all';
  categoryFilter: OutputCategory | 'all';
  availableFolders: readonly FolderOption[];
  shownCount: number;
  totalCount: number;
  selectedCount: number;
  conflictCount: number;
  disabled: boolean;
}>();

const emit = defineEmits<{
  'update:searchQuery': [value: string];
  'update:kindFilter': [value: MediaKind | 'all'];
  'update:categoryFilter': [value: OutputCategory | 'all'];
  'select-folder': [prefix: string];
  'reset-columns': [];
  'bulk-media-kind': [kind: MediaKind];
  'bulk-category': [category: OutputCategory];
  'bulk-audio-normalization': [mode: AudioNormalizationMode];
  'search-metadata-bulk': [];
  'edit-tracks-bulk': [];
  'clear-selection': [];
  'resolve-all-conflicts': [decision: ConflictDecision];
}>();

function onSelectFolderChange(event: Event): void {
  const select = event.target as HTMLSelectElement;
  if (!select.value) {
    return;
  }
  emit('select-folder', select.value);
  select.value = '';
}

function onBulkKindChange(event: Event): void {
  const select = event.target as HTMLSelectElement;
  if (!select.value) {
    return;
  }
  emit('bulk-media-kind', select.value as MediaKind);
  select.value = '';
}

function onBulkCategoryChange(event: Event): void {
  const select = event.target as HTMLSelectElement;
  if (!select.value) {
    return;
  }
  emit('bulk-category', select.value as OutputCategory);
  select.value = '';
}

function onBulkAudioChange(event: Event): void {
  const select = event.target as HTMLSelectElement;
  if (!select.value) {
    return;
  }
  emit('bulk-audio-normalization', select.value as AudioNormalizationMode);
  select.value = '';
}
</script>

<template>
  <div class="vo-table-toolbar">
    <input
      :value="props.searchQuery"
      type="search"
      class="vo-input vo-table-search"
      placeholder="Filter by title or file..."
      aria-label="Filter queue items"
      @input="emit('update:searchQuery', ($event.target as HTMLInputElement).value)"
    />
    <select
      :value="props.kindFilter"
      class="vo-select"
      aria-label="Filter by media type"
      @change="
        emit('update:kindFilter', ($event.target as HTMLSelectElement).value as MediaKind | 'all')
      "
    >
      <option value="all">All types</option>
      <option v-for="kind in MEDIA_KINDS" :key="kind" :value="kind">
        {{ kind === 'tv' ? 'Series' : 'Movie' }}
      </option>
    </select>
    <select
      :value="props.categoryFilter"
      class="vo-select"
      aria-label="Filter by library"
      @change="
        emit(
          'update:categoryFilter',
          ($event.target as HTMLSelectElement).value as OutputCategory | 'all'
        )
      "
    >
      <option value="all">All libraries</option>
      <option v-for="cat in OUTPUT_CATEGORIES" :key="cat" :value="cat">
        {{ CATEGORY_LABELS[cat] }}
      </option>
    </select>
    <template v-if="props.availableFolders.length > 0">
      <label for="vo-select-folder" class="vo-sr-only">Select folder</label>
      <select
        id="vo-select-folder"
        class="vo-select"
        :disabled="props.disabled"
        @change="onSelectFolderChange"
      >
        <option value="">Select folder...</option>
        <option
          v-for="folder in props.availableFolders"
          :key="folder.prefix"
          :value="folder.prefix"
        >
          {{ folder.prefix }} ({{ folder.count }})
        </option>
      </select>
    </template>
    <TableResetCount
      :shown-count="props.shownCount"
      :total-count="props.totalCount"
      @reset="emit('reset-columns')"
    />
  </div>

  <Transition :css="false" @enter="animatePanelEnter" @leave="animatePanelLeave">
    <div v-if="props.selectedCount > 0" class="vo-bulk-bar" role="region" aria-label="Bulk actions">
      <span class="vo-bulk-count vo-mono">{{ props.selectedCount }} selected</span>
      <select
        class="vo-select"
        aria-label="Bulk set type"
        :disabled="props.disabled"
        @change="onBulkKindChange"
      >
        <option value="">Set Type...</option>
        <option v-for="kind in MEDIA_KINDS" :key="kind" :value="kind">
          {{ kind === 'tv' ? 'Series' : 'Movie' }}
        </option>
      </select>
      <select
        class="vo-select"
        aria-label="Bulk set library"
        :disabled="props.disabled"
        @change="onBulkCategoryChange"
      >
        <option value="">Set Library...</option>
        <option v-for="cat in OUTPUT_CATEGORIES" :key="cat" :value="cat">
          {{ CATEGORY_LABELS[cat] }}
        </option>
      </select>
      <select
        class="vo-select"
        aria-label="Bulk set audio normalization"
        :disabled="props.disabled"
        @change="onBulkAudioChange"
      >
        <option value="">Set Audio...</option>
        <option v-for="mode in AUDIO_NORMALIZATION_MODES" :key="mode" :value="mode">
          {{ AUDIO_MODE_LABELS[mode] }}
        </option>
      </select>
      <button
        type="button"
        class="vo-btn"
        :disabled="props.disabled"
        @click="emit('edit-tracks-bulk')"
      >
        <span aria-hidden="true">🎛️</span> Edit Tracks
      </button>
      <button
        type="button"
        class="vo-btn"
        :disabled="props.disabled"
        @click="emit('search-metadata-bulk')"
      >
        <UiIcon name="search" /> Search Match
      </button>
      <button type="button" class="vo-btn" @click="emit('clear-selection')">
        <span aria-hidden="true">🧹</span> Clear
      </button>
    </div>
  </Transition>

  <Transition :css="false" @enter="animatePanelEnter" @leave="animatePanelLeave">
    <div
      v-if="props.conflictCount > 0"
      class="vo-conflict-banner-bar"
      role="region"
      aria-label="Output conflicts"
    >
      <span class="vo-conflict-banner-title vo-mono">
        ⚠ {{ props.conflictCount }} output conflict(s) detected — resolve every conflict in the
        table before processing
      </span>
      <div class="vo-conflict-banner-actions">
        <button
          type="button"
          class="vo-btn"
          :disabled="props.disabled"
          @click="emit('resolve-all-conflicts', 'overwrite')"
        >
          <span aria-hidden="true">✅</span> Overwrite All Conflicts
        </button>
        <button
          type="button"
          class="vo-btn"
          :disabled="props.disabled"
          @click="emit('resolve-all-conflicts', 'ignore')"
        >
          <span aria-hidden="true">⏭️</span> Ignore All Conflicts
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
.vo-table-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-2);
  padding: var(--vo-space-3);
  background-color: var(--vo-surface-elevated);
  border-bottom: 1px solid var(--vo-border);
}

.vo-table-search {
  min-width: 14rem;
  flex: 1;
}

.vo-bulk-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-2);
  padding: var(--vo-space-2) var(--vo-space-3);
  background-color: color-mix(in oklch, var(--vo-accent) 10%, var(--vo-surface-elevated));
  border-bottom: 1px solid var(--vo-border-highlight);
}

.vo-bulk-count {
  color: var(--vo-accent);
  font-size: var(--vo-text-xs);
  font-weight: var(--vo-weight-semibold);
}

.vo-conflict-banner-bar {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: var(--vo-space-2);
  padding: var(--vo-space-2) var(--vo-space-3);
  background-color: color-mix(in oklch, var(--vo-danger) 12%, var(--vo-surface-elevated));
  border-bottom: 1px solid var(--vo-danger);
}

.vo-conflict-banner-title {
  color: var(--vo-danger);
  font-size: var(--vo-text-xs);
  font-weight: var(--vo-weight-semibold);
}

.vo-conflict-banner-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--vo-space-2);
}
</style>
