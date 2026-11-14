<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { OUTPUT_CATEGORIES } from '../../domain/constants.ts';
import type {
  ConflictDecision,
  OutputCategory,
  VerifierEntry,
  VerifierEntryId,
  VerifierIssueCode,
  VerifierRenameStep,
  VerifierState
} from '../../domain/types.ts';
import {
  extractExternalIdLinks,
  formatEta,
  splitRelativePathSegments
} from '../utils/formatters.ts';
import ParallelTasksList from './ParallelTasksList.vue';
import ProviderLinks from './ProviderLinks.vue';
import { areAllVisibleRowsSelected } from './table/tableQueryCore.ts';
import TableResetCount from './table/TableResetCount.vue';
import type { TableColumnDef, TableWorkerRowInput } from './table/tableTypes.js';
import { useTableWorker } from './table/useTableWorker.js';
import VirtualDataTable from './table/VirtualDataTable.vue';

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

function getVerifierRowClass(): string {
  return 'vo-verifier-row';
}

function issueLabel(code: VerifierIssueCode): string {
  return ISSUE_LABELS.get(code) ?? code;
}

function categoryLabel(category: OutputCategory): string {
  return CATEGORY_LABELS.get(category) ?? category;
}

interface FileComparisonItem {
  readonly fromName: string;
  readonly toName: string;
}

interface FilePlanGroup {
  readonly kind: 'files';
  readonly key: string;
  readonly fromFolders: readonly string[];
  readonly toFolders: readonly string[];
  readonly sameFolder: boolean;
  readonly items: readonly FileComparisonItem[];
}

interface DirPlanItem {
  readonly stepKind: 'season-dir' | 'root-dir';
  readonly fromPath: string;
  readonly toPath: string;
}

interface DirPlanGroup {
  readonly kind: 'dirs';
  readonly key: string;
  readonly items: readonly DirPlanItem[];
}

type RenamePlanGroup = FilePlanGroup | DirPlanGroup;

function buildRenamePlanGroups(steps: readonly VerifierRenameStep[]): readonly RenamePlanGroup[] {
  const fileGroups = new Map<
    string,
    {
      readonly kind: 'files';
      readonly key: string;
      readonly fromFolders: readonly string[];
      readonly toFolders: readonly string[];
      readonly sameFolder: boolean;
      readonly items: FileComparisonItem[];
    }
  >();
  const dirItems: DirPlanItem[] = [];

  for (const step of steps) {
    if (step.kind === 'file') {
      const fromSegs = splitRelativePathSegments(step.fromRelative);
      const toSegs = splitRelativePathSegments(step.toRelative);
      const fromKey = fromSegs.folders.join('/');
      const toKey = toSegs.folders.join('/');
      const groupKey = `${fromKey}::${toKey}`;
      let group = fileGroups.get(groupKey);
      if (!group) {
        group = {
          kind: 'files',
          key: groupKey,
          fromFolders: fromSegs.folders,
          toFolders: toSegs.folders,
          sameFolder: fromKey === toKey,
          items: []
        };
        fileGroups.set(groupKey, group);
      }
      group.items.push({
        fromName: fromSegs.fileName ?? step.fromRelative,
        toName: toSegs.fileName ?? step.toRelative
      });
      continue;
    }

    dirItems.push({
      stepKind: step.kind,
      fromPath: step.fromRelative.replace(/\\/g, '/'),
      toPath: step.toRelative.replace(/\\/g, '/')
    });
  }

  const groups: RenamePlanGroup[] = [...fileGroups.values()];
  if (dirItems.length > 0) {
    groups.push({ kind: 'dirs', key: 'dirs', items: dirItems });
  }
  return groups;
}
</script>

<template>
  <section class="vo-verifier">
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
                }}%){{
                  props.state.progress.etaSeconds !== undefined
                    ? ` · ${formatEta(props.state.progress.etaSeconds)}`
                    : ''
                }}{{
                  props.state.progress.stageLabel ? ` · ${props.state.progress.stageLabel}` : ''
                }}
              </template>
              <template v-else>
                {{ props.state.fixing ? 'Fixing' : 'Scanning' }} ·
                {{ props.state.progress?.stageLabel || 'Discovering libraries...' }}
              </template>
            </div>
          </div>
          <ParallelTasksList
            v-if="props.state.progress"
            :tasks="props.state.progress.activeTasks"
          />
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
          v-model="searchQuery"
          type="search"
          class="vo-input"
          placeholder="Filter by folder or issue..."
          aria-label="Filter non-compliant entries"
        />
        <select v-model="filterCategory" class="vo-select" aria-label="Filter by library">
          <option value="all">All libraries</option>
          <option v-for="cat in OUTPUT_CATEGORIES" :key="cat" :value="cat">
            {{ categoryLabel(cat) }}
          </option>
        </select>
        <TableResetCount
          :shown-count="filteredIndices.length"
          :total-count="props.state.entries.length"
          @reset="vTableRef?.resetColumns()"
        />
      </div>
    </div>

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
                <button
                  v-if="hasDestinationCollision(row)"
                  type="button"
                  class="vo-btn vo-btn--xs"
                  :class="{
                    'vo-btn--primary': props.conflictResolutions?.[row.id] === 'overwrite',
                    'vo-btn--warn': !props.conflictResolutions?.[row.id]
                  }"
                  :disabled="props.disabled || props.state.fixing || !row.collisionComparison"
                  :title="
                    row.collisionComparison
                      ? 'Compare files and choose Overwrite or Ignore'
                      : 'No comparable video found in destination folder'
                  "
                  @click="emit('resolve-conflict', row)"
                >
                  <template v-if="props.conflictResolutions?.[row.id] === 'overwrite'">
                    <span aria-hidden="true">✅</span> Overwrite
                  </template>
                  <template v-else-if="props.conflictResolutions?.[row.id] === 'ignore'">
                    <span aria-hidden="true">⏭️</span> Ignore
                  </template>
                  <template v-else> <span aria-hidden="true">⚖️</span> Resolve conflict </template>
                </button>
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
          <div v-if="row.steps.length > 0" class="vo-plan-panels vo-mono">
            <details
              v-for="group in buildRenamePlanGroups(row.steps)"
              :key="`${row.id}-${group.key}`"
              class="vo-plan-panel"
              open
            >
              <summary class="vo-plan-panel__summary">
                <template v-if="group.kind === 'files'">
                  <span class="vo-plan-panel__title">
                    <span class="vo-badge vo-badge--accent">files</span>
                    <span v-if="group.fromFolders.length > 0" class="vo-plan-panel__path">
                      {{ group.fromFolders.join(' / ') }}
                      <template v-if="!group.sameFolder">
                        -> {{ group.toFolders.join(' / ') }}
                      </template>
                    </span>
                    <span v-else class="vo-muted">root</span>
                  </span>
                </template>
                <template v-else>
                  <span class="vo-plan-panel__title">
                    <span class="vo-badge vo-badge--accent">folders</span>
                    <span class="vo-muted">Directory renames</span>
                  </span>
                </template>
                <span class="vo-badge vo-badge--compact">{{ group.items.length }}</span>
              </summary>

              <ul v-if="group.kind === 'files'" class="vo-plan-panel__list">
                <li
                  v-for="(item, idx) in group.items"
                  :key="`${group.key}-${idx}`"
                  class="vo-plan-diff-row"
                >
                  <span class="vo-plan-diff-cell vo-plan-diff-cell--from">
                    {{ item.fromName }}
                  </span>
                  <span class="vo-step-arrow" aria-hidden="true">-></span>
                  <span class="vo-plan-diff-cell vo-plan-diff-cell--to">
                    {{ item.toName }}
                  </span>
                </li>
              </ul>

              <ul v-else class="vo-plan-panel__list">
                <li
                  v-for="(item, idx) in group.items"
                  :key="`${group.key}-${idx}`"
                  class="vo-plan-dir-row"
                >
                  <span class="vo-badge vo-badge--compact vo-badge--accent">{{
                    item.stepKind
                  }}</span>
                  <span class="vo-plan-diff-cell vo-plan-diff-cell--from">
                    {{ item.fromPath }}
                  </span>
                  <span class="vo-step-arrow" aria-hidden="true">-></span>
                  <span class="vo-plan-diff-cell vo-plan-diff-cell--to">
                    {{ item.toPath }}
                  </span>
                </li>
              </ul>
            </details>
          </div>
          <span v-else class="vo-muted vo-mono">
            Manual metadata resolution required before rename.
          </span>
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

.vo-muted {
  color: var(--vo-text-muted);
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

.vo-plan-panels {
  display: grid;
  gap: var(--vo-space-2);
  min-width: 0;
  max-width: 100%;
  max-height: 16rem;
  padding-right: var(--vo-space-1);
  overflow-y: auto;
}

.vo-plan-panel {
  border: 1px solid var(--vo-border);
  border-radius: var(--vo-radius-sm);
  background: color-mix(in oklch, var(--vo-bg) 45%, transparent);
  overflow: hidden;
}

.vo-plan-panel__summary {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--vo-space-2);
  padding: var(--vo-space-1) var(--vo-space-2);
  background: color-mix(in oklch, var(--vo-border) 24%, transparent);
  font-size: var(--vo-text-xs);
  cursor: pointer;
  user-select: none;
}

.vo-plan-panel__title {
  display: inline-flex;
  align-items: center;
  gap: var(--vo-space-2);
  min-width: 0;
}

.vo-plan-panel__path {
  color: var(--vo-text);
  overflow-wrap: anywhere;
}

.vo-plan-panel__list {
  display: grid;
  gap: var(--vo-space-1);
  margin: 0;
  padding: var(--vo-space-1) var(--vo-space-2);
  list-style: none;
}

%vo-plan-row-base {
  display: grid;
  align-items: center;
  gap: var(--vo-space-2);
  padding-block: var(--vo-space-1);
  border-bottom: 1px solid color-mix(in oklch, var(--vo-border) 40%, transparent);

  &:last-child {
    border-bottom: none;
  }
}

.vo-plan-diff-row {
  @extend %vo-plan-row-base;

  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
}

.vo-plan-dir-row {
  @extend %vo-plan-row-base;

  grid-template-columns: auto minmax(0, 1fr) auto minmax(0, 1fr);
}

.vo-plan-diff-cell {
  min-width: 0;
  padding: var(--vo-space-1) var(--vo-space-2);
  border-radius: var(--vo-radius-sm);
  font-size: var(--vo-text-xs);
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.vo-plan-diff-cell--from {
  border: 1px solid color-mix(in oklch, var(--vo-danger) 38%, transparent);
  background: color-mix(in oklch, var(--vo-danger) 9%, transparent);
  color: var(--vo-text);
}

.vo-plan-diff-cell--to {
  border: 1px solid color-mix(in oklch, var(--vo-success) 42%, transparent);
  background: color-mix(in oklch, var(--vo-success) 10%, transparent);
  color: var(--vo-text);
}

.vo-step-arrow {
  color: var(--vo-text-muted);
  font-size: var(--vo-text-xs);
}
</style>
