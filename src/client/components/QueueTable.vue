<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import {
  MEDIA_KINDS,
  OUTPUT_CATEGORIES,
  type AudioNormalizationMode
} from '../../domain/constants.ts';
import type {
  AudioNormalizationConfig,
  AudioTrackAnalysis,
  ConflictComparison,
  ConflictDecision,
  ItemId,
  MediaKind,
  OutputCategory,
  ScannedItem
} from '../../domain/types.ts';
import { formatSizeMb } from '../utils/formatters.ts';
import QueueAudioCell from './QueueAudioCell.vue';
import QueueMetadataCell from './QueueMetadataCell.vue';
import QueueSourceCell from './QueueSourceCell.vue';
import QueueToolbar from './QueueToolbar.vue';
import QueueTracksCell from './QueueTracksCell.vue';
import type { TracksSummary } from './QueueTracksPanel.vue';
import { areAllVisibleRowsSelected } from './table/tableQueryCore.ts';
import type { TableColumnDef, TableWorkerRowInput } from './table/tableTypes.js';
import { useTableWorker } from './table/useTableWorker.js';
import VirtualDataTable from './table/VirtualDataTable.vue';

type QueueColId =
  | 'select'
  | 'include'
  | 'source'
  | 'type'
  | 'category'
  | 'metadata'
  | 'size'
  | 'audio'
  | 'tracks';

const QUEUE_COLUMNS: readonly TableColumnDef<QueueColId>[] = [
  {
    id: 'select',
    label: '',
    defaultWidthPx: 42,
    minWidthPx: 38,
    resizable: false,
    reorderable: false,
    align: 'center'
  },
  { id: 'include', label: 'Include', defaultWidthPx: 116, minWidthPx: 96, sortable: true },
  {
    id: 'source',
    label: 'Source -> Plex Output',
    defaultWidthPx: 360,
    minWidthPx: 220,
    sortable: true
  },
  { id: 'type', label: 'Type', defaultWidthPx: 112, minWidthPx: 92, sortable: true },
  { id: 'category', label: 'Category', defaultWidthPx: 158, minWidthPx: 120, sortable: true },
  { id: 'metadata', label: 'Metadata Match', defaultWidthPx: 270, minWidthPx: 180 },
  { id: 'size', label: 'Size', defaultWidthPx: 100, minWidthPx: 84, sortable: true },
  { id: 'audio', label: 'Audio', defaultWidthPx: 275, minWidthPx: 210 },
  { id: 'tracks', label: 'Tracks', defaultWidthPx: 185, minWidthPx: 140 }
];

type SortKey = 'include' | 'title' | 'mediaKind' | 'category' | 'size';
type SortDir = 'ascending' | 'descending';

export interface SubtitlePickerViewState {
  readonly itemId: ItemId;
  readonly loading: boolean;
  readonly downloadingId: string | null;
  readonly error: string | null;
  readonly candidates: readonly SubtitleCandidate[];
}

const props = defineProps<{
  readonly items: readonly ScannedItem[];
  readonly disabled: boolean;
  readonly conflicts?: readonly ConflictComparison[];
  readonly conflictResolutions?: Readonly<Partial<Record<ItemId, ConflictDecision>>>;
  readonly subtitlePicker?: SubtitlePickerViewState | null;
}>();

const emit = defineEmits<{
  (e: 'toggle-include', item: ScannedItem, include: boolean): void;
  (e: 'bulk-include', itemIds: readonly ItemId[], include: boolean): void;
  (e: 'change-media-kind', item: ScannedItem, kind: MediaKind): void;
  (e: 'change-category', item: ScannedItem, category: OutputCategory): void;
  (e: 'change-edition', item: ScannedItem, edition: string): void;
  (e: 'change-candidate', item: ScannedItem, idx: number): void;
  (e: 'search-metadata', item: ScannedItem): void;
  (e: 'search-metadata-bulk', items: readonly ScannedItem[]): void;
  (e: 'edit-tracks-bulk', items: readonly ScannedItem[]): void;
  (e: 'bulk-media-kind', itemIds: readonly ItemId[], kind: MediaKind): void;
  (e: 'bulk-category', itemIds: readonly ItemId[], category: OutputCategory): void;
  (e: 'inspect-tracks', item: ScannedItem): void;
  (e: 'search-subtitles', item: ScannedItem): void;
  (e: 'preview-subtitle', item: ScannedItem): void;
  (e: 'change-audio-normalization', item: ScannedItem, config: AudioNormalizationConfig): void;
  (e: 'bulk-audio-normalization', itemIds: readonly ItemId[], mode: AudioNormalizationMode): void;
  (e: 'open-conflict-modal', itemId: ItemId): void;
  (e: 'resolve-all-conflicts', decision: ConflictDecision): void;
}>();

const conflictByItemId = computed<ReadonlyMap<ItemId, ConflictComparison>>(() => {
  const map = new Map<ItemId, ConflictComparison>();
  for (const conflict of props.conflicts ?? []) {
    map.set(conflict.itemId, conflict);
  }
  return map;
});

const CATEGORY_LABELS: Readonly<Record<OutputCategory, string>> = {
  movies: 'Movies',
  'animated-movies': 'Animated Movies',
  'tv-shows': 'Series',
  'animated-series': 'Animated Series'
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const searchQuery = ref('');
const kindFilter = ref<'all' | MediaKind>('all');
const categoryFilter = ref<'all' | OutputCategory>('all');
const sortKey = ref<SortKey | null>(null);
const sortDir = ref<SortDir>('ascending');
const selectedIds = ref<Set<ItemId>>(new Set());

interface FolderSummary {
  readonly prefix: string;
  readonly count: number;
}

function extractFolderPrefixes(relativePath: string): readonly string[] {
  const normalized = relativePath.replace(/\\/gu, '/');
  const parts = normalized.split('/');
  if (parts.length <= 1) {
    return [];
  }
  const prefixes: string[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    prefixes.push(parts.slice(0, i).join('/'));
  }
  return prefixes;
}

watch(
  () => props.items,
  (items): void => {
    const valid = new Set(items.map((item) => item.id));
    const next = new Set<ItemId>();
    for (const id of selectedIds.value) {
      if (valid.has(id)) {
        next.add(id);
      }
    }
    selectedIds.value = next;
  }
);

const availableFolders = computed<readonly FolderSummary[]>(() => {
  const counts = new Map<string, number>();
  for (const item of props.items) {
    for (const prefix of extractFolderPrefixes(item.relativePath)) {
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([prefix, count]) => ({ prefix, count }))
    .sort((a, b) => collator.compare(a.prefix, b.prefix));
});

const selectedItems = computed<readonly ScannedItem[]>(() =>
  props.items.filter((item): boolean => selectedIds.value.has(item.id))
);

const selectedCount = computed((): number => selectedIds.value.size);

function toggleSelect(id: ItemId, checked: boolean): void {
  const next = new Set(selectedIds.value);
  if (checked) {
    next.add(id);
  } else {
    next.delete(id);
  }
  selectedIds.value = next;
}

function clearSelection(): void {
  selectedIds.value = new Set();
}

function selectByFolderPrefix(prefix: string): void {
  const normalizedPrefix = `${prefix}/`;
  const next = new Set(selectedIds.value);
  for (const item of props.items) {
    const normalized = item.relativePath.replace(/\\/gu, '/');
    if (normalized.startsWith(normalizedPrefix)) {
      next.add(item.id);
    }
  }
  selectedIds.value = next;
}

const vTableRef = ref<InstanceType<typeof VirtualDataTable> | null>(null);
const { filteredIndices, setRows, runQuery } = useTableWorker();

function buildQueueWorkerRows(items: readonly ScannedItem[]): TableWorkerRowInput[] {
  const rows: TableWorkerRowInput[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) {
      continue;
    }
    rows.push({
      index: i,
      searchText: `${item.parsedTitle} ${item.relativePath} ${item.fileName}`.toLowerCase(),
      facetValues: {
        mediaKind: item.mediaKind,
        category: item.category
      },
      sortValues: {
        include: Number(item.include),
        title: item.parsedTitle || item.fileName,
        mediaKind: item.mediaKind,
        category: CATEGORY_LABELS[item.category],
        size: item.probe.sizeBytes
      }
    });
  }
  return rows;
}

function triggerQueueQuery(): void {
  runQuery({
    searchQuery: searchQuery.value,
    facetFilters: {
      mediaKind: kindFilter.value,
      category: categoryFilter.value
    },
    sortBy: sortKey.value,
    sortDir: sortDir.value === 'descending' ? 'desc' : 'asc'
  });
}

watch(
  () => props.items,
  (nextItems): void => {
    setRows(buildQueueWorkerRows(nextItems));
    triggerQueueQuery();
  },
  { immediate: true }
);

watch([searchQuery, kindFilter, categoryFilter, sortKey, sortDir], (): void => {
  triggerQueueQuery();
});

function toggleSort(key: SortKey): void {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'ascending' ? 'descending' : 'ascending';
    return;
  }
  sortKey.value = key;
  sortDir.value = 'ascending';
}

const allVisibleSelected = computed<boolean>(() =>
  areAllVisibleRowsSelected(filteredIndices.value, props.items, selectedIds.value)
);

const targetIncludeItems = computed<readonly ScannedItem[]>(() => {
  if (selectedIds.value.size > 0) {
    return props.items.filter((item) => selectedIds.value.has(item.id));
  }
  const visible: ScannedItem[] = [];
  for (const rawIdx of filteredIndices.value) {
    const item = props.items[rawIdx];
    if (item) {
      visible.push(item);
    }
  }
  return visible;
});

const allTargetIncluded = computed<boolean>(
  () => targetIncludeItems.value.length > 0 && targetIncludeItems.value.every((i) => i.include)
);

const someTargetIncluded = computed<boolean>(() => targetIncludeItems.value.some((i) => i.include));

function toggleIncludeTarget(include: boolean): void {
  const ids = targetIncludeItems.value
    .filter((item) => item.include !== include)
    .map((item) => item.id);
  if (ids.length > 0) {
    emit('bulk-include', ids, include);
  }
}

function toggleSelectVisible(checked: boolean): void {
  const next = new Set(selectedIds.value);
  const indices = filteredIndices.value;
  for (let i = 0; i < indices.length; i++) {
    const rawIdx = indices[i];
    const item = rawIdx !== undefined ? props.items[rawIdx] : undefined;
    if (!item) {
      continue;
    }
    if (checked) {
      next.add(item.id);
    } else {
      next.delete(item.id);
    }
  }
  selectedIds.value = next;
}

function getQueueRowKey(item: ScannedItem): string {
  return item.id;
}

function getQueueRowClass(item: ScannedItem): readonly string[] {
  const classes: string[] = ['vo-queue-row'];
  if (!item.include) {
    classes.push('vo-row--muted');
  }
  if (selectedIds.value.has(item.id)) {
    classes.push('vo-row--selected');
  }
  if (conflictByItemId.value.get(item.id)) {
    classes.push('vo-row--has-conflict');
    if (props.conflictResolutions?.[item.id]) {
      classes.push('vo-row--has-conflict-resolved');
    }
  }
  return classes;
}

const COL_TO_SORT_KEY: ReadonlyMap<QueueColId, SortKey> = new Map([
  ['include', 'include'],
  ['source', 'title'],
  ['type', 'mediaKind'],
  ['category', 'category'],
  ['size', 'size']
]);

function getQueueAriaSort(colId: QueueColId): 'ascending' | 'descending' | undefined {
  const key = COL_TO_SORT_KEY.get(colId);
  if (!key || sortKey.value !== key) {
    return undefined;
  }
  return sortDir.value;
}

const DEFAULT_AUDIO_NORM: AudioNormalizationConfig = {
  mode: 'copy',
  codec: 'auto',
  downmixStereo: false
};

function getAudioNorm(item: ScannedItem): AudioNormalizationConfig {
  return item.trackSelection.audioNormalization ?? DEFAULT_AUDIO_NORM;
}

const SURROUND_SIX_CHANNELS = 6;
const SURROUND_EIGHT_CHANNELS = 8;

function formatChannelLayout(channels: number): string {
  if (channels === SURROUND_SIX_CHANNELS) {
    return '5.1';
  }
  if (channels === SURROUND_EIGHT_CHANNELS) {
    return '7.1';
  }
  if (channels === 2) {
    return '2.0';
  }
  return `${String(channels)}ch`;
}

function hasActionableAudioSuggestion(item: ScannedItem): boolean {
  const analysis = getAudioSummary(item).analysis;
  return Boolean(analysis && analysis.suggestion !== 'ok');
}

function getAudioSummary(item: ScannedItem): {
  readonly codecText: string;
  readonly hasSurround: boolean;
  readonly analysis?: AudioTrackAnalysis;
} {
  const includedOrders = new Set(
    item.trackSelection.audioTracks.filter((t) => t.include).map((t) => t.streamOrder)
  );
  const includedStreams = item.probe.audioStreams.filter((s): boolean =>
    includedOrders.has(s.streamOrder)
  );
  const primaryStream = includedStreams[0] ?? item.probe.audioStreams[0];
  const codecText = primaryStream
    ? `${primaryStream.codecName.toUpperCase()} ${formatChannelLayout(primaryStream.channels)}`
    : 'No audio';
  const hasSurround = includedStreams.some((s): boolean => s.channels > 2);

  const analyses = (item.probe.audioAnalysis ?? []).filter((a): boolean =>
    includedOrders.has(a.streamOrder)
  );
  const actionable = analyses.find((a): boolean => a.suggestion !== 'ok');
  return {
    codecText,
    hasSurround,
    analysis: actionable ?? analyses[0]
  };
}

function formatSubTag(sub: {
  readonly language: string;
  readonly isForced: boolean;
  readonly isHearingImpaired: boolean;
}): string {
  const flags: string[] = [];
  if (sub.isForced) {
    flags.push('forced');
  }
  if (sub.isHearingImpaired) {
    flags.push('sdh');
  }
  return flags.length > 0 ? `${sub.language} (${flags.join('/')})` : sub.language;
}

function getTracksSummary(item: ScannedItem): TracksSummary {
  const includedPaths = new Set(item.trackSelection.externalSubtitleOrder);
  const addedSubs = item.externalSubtitles.filter((s): boolean => includedPaths.has(s.path));
  const isReplace = item.trackSelection.subtitleMergeMode === 'replace';
  const keptInternalIds = new Set(item.trackSelection.includedInternalSubtitles);
  const keptInternal = isReplace
    ? []
    : item.probe.subtitleStreams.filter((s): boolean => keptInternalIds.has(s.streamOrder));

  const hasSpanishSubs =
    addedSubs.some((s): boolean => s.language === 'spa') ||
    keptInternal.some((s): boolean => s.language === 'spa');

  const totalAudio = item.trackSelection.audioTracks.length;
  const includedAudio = item.trackSelection.audioTracks.filter((t): boolean => t.include);
  const audioCountLabel =
    includedAudio.length === totalAudio
      ? String(totalAudio)
      : `${String(includedAudio.length)}/${String(totalAudio)}`;
  const audioLangs = includedAudio.map((t) => t.language).join(', ');
  const audioSummaryText = audioLangs ? `${audioCountLabel} (${audioLangs})` : audioCountLabel;

  const totalInternalSubs = item.probe.subtitleStreams.length;
  const intSubCountLabel =
    keptInternal.length === totalInternalSubs
      ? String(totalInternalSubs)
      : `${String(keptInternal.length)}/${String(totalInternalSubs)}`;
  const subsSummaryText = `${intSubCountLabel} int · ${String(addedSubs.length)} ext`;

  return {
    audioSummaryText,
    subsSummaryText,
    addedCount: addedSubs.length,
    addedText: addedSubs.map(formatSubTag).join(', '),
    keptCount: keptInternal.length,
    keptText: keptInternal.map(formatSubTag).join(', '),
    isReplace,
    hasConflict: item.trackSelection.needsUserPrompt,
    conflictText: item.trackSelection.promptReason ?? 'Resolve subtitle conflict',
    missingSpanishSubs: !hasSpanishSubs
  };
}

const tracksSummaryByItemId = computed<Map<ItemId, TracksSummary>>(() => {
  const map = new Map<ItemId, TracksSummary>();
  for (const item of props.items) {
    map.set(item.id, getTracksSummary(item));
  }
  return map;
});

function getRowTracksSummary(item: ScannedItem): TracksSummary {
  return tracksSummaryByItemId.value.get(item.id) ?? getTracksSummary(item);
}
</script>

<template>
  <div class="vo-table-wrap">
    <QueueToolbar
      v-model:search-query="searchQuery"
      v-model:kind-filter="kindFilter"
      v-model:category-filter="categoryFilter"
      :available-folders="availableFolders"
      :shown-count="filteredIndices.length"
      :total-count="props.items.length"
      :selected-count="selectedCount"
      :conflict-count="props.conflicts?.length ?? 0"
      :disabled="disabled"
      @select-folder="selectByFolderPrefix"
      @reset-columns="vTableRef?.resetColumns()"
      @bulk-media-kind="emit('bulk-media-kind', [...selectedIds], $event)"
      @bulk-category="emit('bulk-category', [...selectedIds], $event)"
      @bulk-audio-normalization="
        emit(
          'bulk-audio-normalization',
          selectedItems.map((i) => i.id),
          $event
        )
      "
      @search-metadata-bulk="emit('search-metadata-bulk', selectedItems)"
      @edit-tracks-bulk="emit('edit-tracks-bulk', selectedItems)"
      @clear-selection="clearSelection"
      @resolve-all-conflicts="emit('resolve-all-conflicts', $event)"
    />

    <VirtualDataTable
      ref="vTableRef"
      table-id="queue"
      :columns="QUEUE_COLUMNS"
      :rows="props.items"
      :indices="filteredIndices"
      :get-row-key="getQueueRowKey"
      :get-row-class="getQueueRowClass"
      :get-aria-sort="getQueueAriaSort"
      :estimated-row-height="136"
      :empty-message="
        props.items.length === 0
          ? 'Queue is empty. Click Scan Input to discover media files.'
          : 'No media items match the current filters.'
      "
    >
      <template #header-select>
        <label for="vo-select-all-visible" class="vo-sr-only">Select all visible</label>
        <input
          id="vo-select-all-visible"
          type="checkbox"
          :checked="allVisibleSelected"
          :disabled="disabled || filteredIndices.length === 0"
          @change="toggleSelectVisible(($event.target as HTMLInputElement).checked)"
        />
      </template>

      <template #header-include>
        <div class="vo-include-header">
          <label for="vo-include-all" class="vo-sr-only">
            {{ selectedIds.size > 0 ? 'Include selected items' : 'Include all visible items' }}
          </label>
          <input
            id="vo-include-all"
            type="checkbox"
            :checked="allTargetIncluded"
            :indeterminate.prop="someTargetIncluded && !allTargetIncluded"
            :disabled="disabled || targetIncludeItems.length === 0"
            :title="
              selectedIds.size > 0
                ? 'Toggle Include for selected items'
                : 'Toggle Include for all visible items'
            "
            @change="toggleIncludeTarget(($event.target as HTMLInputElement).checked)"
          />
          <button type="button" class="vo-sort-btn" @click="toggleSort('include')">
            Include
            <span v-if="sortKey === 'include'" class="vo-sort-indicator" aria-hidden="true">
              {{ sortDir === 'ascending' ? '▲' : '▼' }}
            </span>
          </button>
        </div>
      </template>

      <template #header-source>
        <button type="button" class="vo-sort-btn" @click="toggleSort('title')">
          Source File
          <span v-if="sortKey === 'title'" class="vo-sort-indicator" aria-hidden="true">
            {{ sortDir === 'ascending' ? '▲' : '▼' }}
          </span>
        </button>
      </template>

      <template #header-type>
        <button type="button" class="vo-sort-btn" @click="toggleSort('mediaKind')">
          Type
          <span v-if="sortKey === 'mediaKind'" class="vo-sort-indicator" aria-hidden="true">
            {{ sortDir === 'ascending' ? '▲' : '▼' }}
          </span>
        </button>
      </template>

      <template #header-category>
        <button type="button" class="vo-sort-btn" @click="toggleSort('category')">
          Library
          <span v-if="sortKey === 'category'" class="vo-sort-indicator" aria-hidden="true">
            {{ sortDir === 'ascending' ? '▲' : '▼' }}
          </span>
        </button>
      </template>

      <template #header-size>
        <button type="button" class="vo-sort-btn" @click="toggleSort('size')">
          Size
          <span v-if="sortKey === 'size'" class="vo-sort-indicator" aria-hidden="true">
            {{ sortDir === 'ascending' ? '▲' : '▼' }}
          </span>
        </button>
      </template>

      <template #cell-select="{ row }">
        <label :for="`sel-${row.id}`" class="vo-sr-only">Select {{ row.fileName }}</label>
        <input
          :id="`sel-${row.id}`"
          type="checkbox"
          :checked="selectedIds.has(row.id)"
          :disabled="disabled"
          @change="toggleSelect(row.id, ($event.target as HTMLInputElement).checked)"
        />
      </template>

      <template #cell-include="{ row }">
        <label :for="`inc-${row.id}`" class="vo-sr-only">Include {{ row.fileName }}</label>
        <input
          :id="`inc-${row.id}`"
          type="checkbox"
          :checked="row.include"
          :disabled="disabled"
          @change="emit('toggle-include', row, ($event.target as HTMLInputElement).checked)"
        />
      </template>

      <template #cell-source="{ row }">
        <QueueSourceCell
          :item="row"
          :disabled="disabled"
          :conflict="conflictByItemId.get(row.id)"
          :decision="props.conflictResolutions?.[row.id]"
          @change-edition="emit('change-edition', row, $event)"
          @open-conflict-modal="emit('open-conflict-modal', row.id)"
        />
      </template>

      <template #cell-type="{ row }">
        <label :for="`kind-${row.id}`" class="vo-sr-only">Media kind for {{ row.fileName }}</label>
        <select
          :id="`kind-${row.id}`"
          class="vo-select"
          :value="row.mediaKind"
          :disabled="disabled"
          @change="
            emit('change-media-kind', row, ($event.target as HTMLSelectElement).value as MediaKind)
          "
        >
          <option v-for="kind in MEDIA_KINDS" :key="kind" :value="kind">
            {{ kind === 'tv' ? 'Series' : 'Movie' }}
          </option>
        </select>
      </template>

      <template #cell-category="{ row }">
        <label :for="`cat-${row.id}`" class="vo-sr-only">Category for {{ row.fileName }}</label>
        <select
          :id="`cat-${row.id}`"
          class="vo-select"
          :value="row.category"
          :disabled="disabled"
          @change="
            emit(
              'change-category',
              row,
              ($event.target as HTMLSelectElement).value as OutputCategory
            )
          "
        >
          <option v-for="cat in OUTPUT_CATEGORIES" :key="cat" :value="cat">
            {{ CATEGORY_LABELS[cat] }}
          </option>
        </select>
      </template>

      <template #cell-metadata="{ row }">
        <QueueMetadataCell
          :item="row"
          :disabled="disabled"
          @change-candidate="emit('change-candidate', row, $event)"
          @search-metadata="emit('search-metadata', row)"
        />
      </template>

      <template #cell-size="{ row }">
        <span class="vo-mono vo-size-cell">{{ formatSizeMb(row.probe.sizeBytes) }}</span>
      </template>

      <template #cell-audio="{ row }">
        <QueueAudioCell
          :item="row"
          :disabled="disabled"
          :summary="getAudioSummary(row)"
          :audio-norm="getAudioNorm(row)"
          @change-audio-normalization="emit('change-audio-normalization', row, $event)"
        />
      </template>

      <template #cell-tracks="{ row }">
        <QueueTracksCell
          :item="row"
          :disabled="disabled"
          :summary="getRowTracksSummary(row)"
          :subtitle-picker="props.subtitlePicker"
          @inspect-tracks="emit('inspect-tracks', row)"
          @search-subtitles="emit('search-subtitles', row)"
          @preview-subtitle="emit('preview-subtitle', row)"
        />
      </template>
    </VirtualDataTable>
  </div>
</template>

<style scoped lang="scss">
.vo-table-wrap {
  width: 100%;
  max-width: 100%;
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-md);
  background: var(--vo-surface-gradient);
  box-shadow: var(--vo-shadow-panel);
}

.vo-table-scroll {
  width: 100%;
  max-width: 100%;
  overflow-x: auto;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.vo-floating-scrollbar {
  position: sticky;
  bottom: 0;
  border-radius: 0 0 var(--vo-radius-md) var(--vo-radius-md);
  background-color: color-mix(in oklch, var(--vo-surface-elevated) 92%, transparent);
  overflow: auto hidden;
  border-top: 1px solid var(--vo-border);
  backdrop-filter: blur(6px);
}

.vo-floating-scrollbar-track {
  height: 1px;
}

.vo-table-count {
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
  margin-inline-start: auto;
}

.vo-table-empty {
  color: var(--vo-text-muted);
  text-align: center;
}

.vo-sort-btn {
  display: inline-flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--vo-space-1);
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--vo-text-muted);
  font: inherit;
  text-transform: inherit;
  letter-spacing: inherit;
  cursor: pointer;

  &:hover {
    color: var(--vo-text);
  }

  &:focus-visible {
    outline: 2px solid var(--vo-accent);
    outline-offset: -2px;
  }
}

.vo-include-header {
  display: flex;
  align-items: center;
  gap: var(--vo-space-2);
  width: 100%;
}

.vo-sort-indicator::after {
  opacity: 0.4;
  content: '⇅';
}

th[aria-sort='ascending'] .vo-sort-indicator::after {
  color: var(--vo-accent);
  opacity: 1;
  content: '▲';
}

th[aria-sort='descending'] .vo-sort-indicator::after {
  color: var(--vo-accent);
  opacity: 1;
  content: '▼';
}

.vo-file-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-1);
}

.vo-file-title {
  font-weight: var(--vo-weight-semibold);
}

.vo-col-shrink {
  width: 1%;
  white-space: nowrap;
}

.vo-col-shrink select {
  width: auto;
  max-width: none;
}

.vo-size-head .vo-sort-btn {
  justify-content: flex-end;
  width: 100%;
}

.vo-size-cell {
  text-align: end;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.vo-actions-cell {
  white-space: nowrap;
}

.vo-select-col {
  width: 2.25rem;
  text-align: center;
}
</style>
