<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type {
  ConflictDecision,
  OutputCategory,
  VerifierEntry,
  VerifierEntryId,
  VerifierIssueCode,
  VerifierState
} from '../../domain/types.ts';
import { extractExternalIdLinks } from '../utils/formatters.ts';
import ConflictActionButton from './ConflictActionButton.vue';
import ProviderLinks from './ProviderLinks.vue';
import { areAllVisibleRowsSelected } from './table/tableQueryCore.ts';
import type { TableColumnDef, TableWorkerRowInput } from './table/tableTypes.js';
import { useTableWorker } from './table/useTableWorker.js';
import VirtualDataTable from './table/VirtualDataTable.vue';
import VerifierRenamePlanCell from './VerifierRenamePlanCell.vue';
import VerifierStatusToolbar from './VerifierStatusToolbar.vue';

type VerifierColId = 'select' | 'library' | 'current' | 'expected' | 'plan';

const VERIFIER_COLUMNS: readonly TableColumnDef<VerifierColId>[] = [
  {
    id: 'select',
    label: '',
    defaultWidthPx: 44,
    minWidthPx: 40,
    resizable: false,
    reorderable: false,
    align: 'center'
  },
  { id: 'library', label: 'Library', defaultWidthPx: 140, minWidthPx: 100 },
  {
    id: 'current',
    label: 'Current (Non-Compliant)',
    defaultWidthPx: 290,
    minWidthPx: 180
  },
  {
    id: 'expected',
    label: 'Expected Plex Standard',
    defaultWidthPx: 290,
    minWidthPx: 180
  },
  {
    id: 'plan',
    label: 'Bottom-Up Rename Plan',
    defaultWidthPx: 520,
    minWidthPx: 240
  }
];

const props = defineProps<{
  readonly state: VerifierState;
  readonly disabled: boolean;
  readonly conflictResolutions?: Readonly<Partial<Record<VerifierEntryId, ConflictDecision>>>;
}>();

const emit = defineEmits<{
  'update:selectedIds': [entryIds: readonly VerifierEntryId[]];
  'dismiss-error': [];
  'resolve-conflict': [entry: VerifierEntry];
}>();

const CATEGORY_LABELS: ReadonlyMap<OutputCategory, string> = new Map([
  ['movies', 'Movies'],
  ['animated-movies', 'Animated Movies'],
  ['tv-shows', 'Series'],
  ['animated-series', 'Animated Series']
]);

const ISSUE_LABELS: ReadonlyMap<VerifierIssueCode, string> = new Map([
  ['EMPTY_DIRECTORY', 'Empty directory'],
  ['DESTINATION_COLLISION', 'Destination exists'],
  ['MISSING_YEAR', 'Missing (YYYY)'],
  ['MISSING_PROVIDER_ID', 'Missing {tvdb/imdb/tmdb}'],
  ['NON_STANDARD_SEASON_DIR', 'Non-standard Season dir'],
  ['NON_STANDARD_FILENAME', 'Non-standard filename'],
  ['SUBTITLE_STEM_MISMATCH', 'Subtitle stem mismatch'],
  ['UNRESOLVED_METADATA', 'Unresolved metadata']
]);

const selectedIds = ref<Set<VerifierEntryId>>(new Set());
const filterCategory = ref<OutputCategory | 'all'>('all');
const searchQuery = ref('');
const vTableRef = ref<InstanceType<typeof VirtualDataTable> | null>(null);

const { filteredIndices, setRows, runQuery } = useTableWorker();

function buildWorkerRows(entries: readonly VerifierEntry[]): TableWorkerRowInput[] {
  const rows: TableWorkerRowInput[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }
    rows.push({
      index: i,
      searchText:
        `${entry.currentRootName} ${entry.expectedRootName} ${entry.issues.join(' ')}`.toLowerCase(),
      facetValues: { category: entry.category },
      sortValues: {}
    });
  }
  return rows;
}

function hasDestinationCollision(entry: VerifierEntry): boolean {
  return entry.issues.includes('DESTINATION_COLLISION');
}

watch(
  () => props.state.entries,
  (nextEntries): void => {
    const validIds = new Set(nextEntries.map((e) => e.id));
    const pruned = new Set<VerifierEntryId>();
    for (const id of selectedIds.value) {
      if (validIds.has(id)) {
        pruned.add(id);
      }
    }
    selectedIds.value = pruned;
    setRows(buildWorkerRows(nextEntries));
    runQuery({
      searchQuery: searchQuery.value,
      facetFilters: { category: filterCategory.value },
      sortBy: null,
      sortDir: 'asc'
    });
  },
  { immediate: true }
);

watch([searchQuery, filterCategory], (): void => {
  runQuery({
    searchQuery: searchQuery.value,
    facetFilters: { category: filterCategory.value },
    sortBy: null,
    sortDir: 'asc'
  });
});

const selectableFilteredIndices = computed<readonly number[]>(() =>
  filteredIndices.value.filter((idx) => props.state.entries[idx] !== undefined)
);

const allVisibleSelected = computed<boolean>(() =>
  areAllVisibleRowsSelected(selectableFilteredIndices.value, props.state.entries, selectedIds.value)
);

function toggleEntry(id: VerifierEntryId): void {
  const next = new Set(selectedIds.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  selectedIds.value = next;
}

function toggleAllVisible(): void {
  const next = new Set(selectedIds.value);
  const indices = selectableFilteredIndices.value;
  const shouldRemove = allVisibleSelected.value;
  for (let i = 0; i < indices.length; i++) {
    const rawIdx = indices[i];
    const entry = rawIdx !== undefined ? props.state.entries[rawIdx] : undefined;
    if (!entry) {
      continue;
    }
    if (shouldRemove) {
      next.delete(entry.id);
    } else {
      next.add(entry.id);
    }
  }
  selectedIds.value = next;
}

watch(
  selectedIds,
  (next): void => {
    emit('update:selectedIds', [...next]);
  },
  { immediate: true }
);

function getEntryKey(entry: VerifierEntry): string {
  return entry.id;
}

function getVerifierRowClass(entry: VerifierEntry): readonly string[] {
  const classes: string[] = ['vo-verifier-row'];
  if (entry.issues.includes('DESTINATION_COLLISION')) {
    classes.push('vo-row--has-conflict');
    if (props.conflictResolutions?.[entry.id]) {
      classes.push('vo-row--has-conflict-resolved');
    }
  }
  return classes;
}

function issueLabel(code: VerifierIssueCode): string {
  return ISSUE_LABELS.get(code) ?? code;
}

function categoryLabel(category: OutputCategory): string {
  return CATEGORY_LABELS.get(category) ?? category;
}
</script>

<template>
  <section class="vo-verifier">
    <VerifierStatusToolbar
      v-model:search-query="searchQuery"
      v-model:filter-category="filterCategory"
      :state="props.state"
      :shown-count="filteredIndices.length"
      :total-count="props.state.entries.length"
      @dismiss-error="emit('dismiss-error')"
      @reset-columns="vTableRef?.resetColumns()"
    />

    <div class="vo-panel vo-verifier__table-panel">
      <div
        v-if="props.state.summary && props.state.entries.length === 0"
        class="vo-verifier__clean"
      >
        All {{ props.state.summary.totalRootsAnalyzed }} root folder(s),
        {{ props.state.summary.totalSeasonDirsAnalyzed }} season folder(s), and
        {{ props.state.summary.totalFilesAnalyzed }} file(s) strictly match Plex naming standards.
      </div>

      <div
        v-else-if="!props.state.summary && props.state.entries.length === 0"
        class="vo-verifier__empty"
      >
        Click <strong>Scan Libraries</strong> to inspect all 4 output libraries for missing years,
        provider IDs, non-standard Season folders, or episode/movie filenames.
      </div>

      <VirtualDataTable
        v-else
        ref="vTableRef"
        table-id="verifier"
        :columns="VERIFIER_COLUMNS"
        :rows="props.state.entries"
        :indices="filteredIndices"
        :get-row-key="getEntryKey"
        :get-row-class="getVerifierRowClass"
        :estimated-row-height="112"
        empty-message="No matching issues for the current filter."
      >
        <template #header-select>
          <input
            type="checkbox"
            :checked="allVisibleSelected"
            :disabled="props.disabled || filteredIndices.length === 0"
            aria-label="Select all visible issues"
            @change="toggleAllVisible()"
          />
        </template>

        <template #header-plan>
          <span class="vo-th-title">
            <span>Bottom-Up Rename Plan</span>
            <span class="vo-badge vo-badge--compact">{{ filteredIndices.length }}</span>
          </span>
        </template>

        <template #cell-select="{ row }">
          <input
            type="checkbox"
            :checked="selectedIds.has(row.id)"
            :disabled="props.disabled || props.state.fixing"
            :aria-label="`Select ${row.currentRootName}`"
            @change="toggleEntry(row.id)"
          />
        </template>

        <template #cell-library="{ row }">
          <span class="vo-badge">{{ categoryLabel(row.category) }}</span>
        </template>

        <template #cell-current="{ row }">
          <div class="vo-diff-card vo-diff-card--current">
            <div class="vo-mono vo-diff-card__title">{{ row.currentRootName }}</div>
            <div class="vo-issue-list">
              <span v-for="issue in row.issues" :key="issue" class="vo-badge vo-badge--danger">
                {{ issueLabel(issue) }}
              </span>
            </div>
          </div>
        </template>

        <template #cell-expected="{ row }">
          <div class="vo-diff-card vo-diff-card--expected">
            <div class="vo-mono vo-diff-card__title">{{ row.expectedRootName }}</div>
            <div class="vo-issue-list">
              <span v-if="row.issues.includes('EMPTY_DIRECTORY')" class="vo-badge vo-badge--danger">
                Delete folder
              </span>
              <template v-else>
                <span v-if="row.resolvedYear" class="vo-badge vo-badge--ok vo-mono">
                  {{ row.resolvedYear }}
                </span>
                <span v-else class="vo-badge vo-badge--warn">Year missing</span>
                <span
                  v-if="hasDestinationCollision(row) && row.collisionTarget"
                  class="vo-badge vo-badge--danger vo-badge--truncate"
                  :title="`Conflict: ${row.collisionTarget}`"
                >
                  Conflict: {{ row.collisionTarget }}
                </span>
                <ConflictActionButton
                  v-if="hasDestinationCollision(row)"
                  :decision="props.conflictResolutions?.[row.id]"
                  :disabled="props.disabled || props.state.fixing || !row.collisionComparison"
                  :title="
                    row.collisionComparison
                      ? 'Compare files and choose Overwrite or Ignore'
                      : 'No comparable video found in destination folder'
                  "
                  @click="emit('resolve-conflict', row)"
                />
              </template>
              <span class="vo-badge vo-badge--compact vo-mono">
                {{ row.steps.length }} step(s)
              </span>
              <ProviderLinks
                v-if="!row.issues.includes('EMPTY_DIRECTORY')"
                :links="extractExternalIdLinks(row.expectedRootName, row.mediaKind)"
              />
            </div>
          </div>
        </template>

        <template #cell-plan="{ row }">
          <VerifierRenamePlanCell :entry-id="row.id" :steps="row.steps" />
        </template>
      </VirtualDataTable>
    </div>
  </section>
</template>

<style scoped lang="scss">
.vo-verifier {
  display: grid;
  gap: var(--vo-space-3);
}

.vo-verifier__table-panel {
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-md);
  background: var(--vo-surface-gradient);
  box-shadow: var(--vo-shadow-panel);
  overflow: hidden;
}

.vo-verifier__clean {
  padding: var(--vo-space-5);
  color: var(--vo-success);
  font-size: var(--vo-text-sm);
  text-align: center;
}

.vo-verifier__empty {
  padding: var(--vo-space-5);
  color: var(--vo-text-muted);
  font-size: var(--vo-text-sm);
  text-align: center;
}

.vo-th-title {
  display: inline-flex;
  align-items: center;
  gap: var(--vo-space-2);
}

.vo-diff-card {
  display: grid;
  gap: var(--vo-space-1);
  min-width: 0;
  max-width: 100%;
  padding: var(--vo-space-2);
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-sm);
  overflow: hidden;
}

.vo-diff-card--current {
  background: color-mix(in oklch, var(--vo-danger) 8%, transparent);
  border-color: color-mix(in oklch, var(--vo-danger) 48%, var(--vo-border));
}

.vo-diff-card--expected {
  background: color-mix(in oklch, var(--vo-success) 8%, transparent);
  border-color: color-mix(in oklch, var(--vo-success) 48%, var(--vo-border));
}

.vo-diff-card__title {
  font-weight: var(--vo-weight-semibold);
  overflow-wrap: anywhere;
}

.vo-issue-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--vo-space-1);
  min-width: 0;
  max-width: 100%;
}

.vo-badge--truncate {
  display: inline-block;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}
</style>
