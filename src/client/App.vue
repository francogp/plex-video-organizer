<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed, watch } from 'vue';

import type {
  AudioNormalizationConfig,
  ConflictDecision,
  ItemId,
  MediaKind,
  OutputCategory,
  ScannedItem,
  SubtitleCandidate,
  VerifierEntry,
  VerifierEntryId
} from '../domain/types.ts';
import AppHeader, { type WorkspaceTab } from './components/AppHeader.vue';
import ConflictResolutionModal from './components/ConflictResolutionModal.vue';
import MetadataSearchModal from './components/MetadataSearchModal.vue';
import OrganizerStatusBar from './components/OrganizerStatusBar.vue';
import QueueTable, { type SubtitlePickerViewState } from './components/QueueTable.vue';
import ServerLogsPanel from './components/ServerLogsPanel.vue';
import SubtitlePreviewModal from './components/SubtitlePreviewModal.vue';
import TrackInspectorModal from './components/TrackInspectorModal.vue';
import VerifierView from './components/VerifierView.vue';
import { useGsapMotion } from './composables/useGsapMotion.ts';
import { useOrganizerStore } from './stores/organizerStore.ts';
import { formatEta, formatPhaseLabel } from './utils/formatters.ts';

declare const __APP_SEMVER__: string;

const store = useOrganizerStore();
const appSemver = typeof __APP_SEMVER__ === 'string' ? __APP_SEMVER__ : 'v1.0.0';
const rootRef = ref<HTMLElement | null>(null);
const inspectingItem = ref<ScannedItem | null>(null);
const searchingItem = ref<ScannedItem | null>(null);
const bulkSearchingItems = ref<readonly ScannedItem[] | null>(null);
const selectedVerifierIds = ref<readonly VerifierEntryId[]>([]);
const recalculateVerifierTags = ref(false);
const previewingSubtitleItem = ref<ScannedItem | null>(null);
const subtitlePicker = ref<SubtitlePickerViewState | null>(null);

async function handleSearchSubtitles(item: ScannedItem): Promise<void> {
  subtitlePicker.value = {
    itemId: item.id,
    loading: true,
    downloadingId: null,
    error: null,
    candidates: []
  };
  try {
    const candidates = await store.searchItemSubtitles(item.id);
    if (subtitlePicker.value?.itemId !== item.id) {
      return;
    }
    subtitlePicker.value = {
      itemId: item.id,
      loading: false,
      downloadingId: null,
      error: candidates.length === 0 ? 'No Spanish subtitles found.' : null,
      candidates
    };
  } catch (err) {
    if (subtitlePicker.value?.itemId !== item.id) {
      return;
    }
    subtitlePicker.value = {
      itemId: item.id,
      loading: false,
      downloadingId: null,
      error: err instanceof Error ? err.message : String(err),
      candidates: []
    };
  }
}

async function handleDownloadSubtitle(
  item: ScannedItem,
  candidate: SubtitleCandidate
): Promise<void> {
  if (subtitlePicker.value) {
    subtitlePicker.value = {
      ...subtitlePicker.value,
      downloadingId: candidate.id,
      error: null
    };
  }
  try {
    await store.downloadItemSubtitle(item.id, candidate);
    subtitlePicker.value = null;
  } catch (err) {
    if (subtitlePicker.value?.itemId === item.id) {
      subtitlePicker.value = {
        ...subtitlePicker.value,
        downloadingId: null,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }
}

function closeSubtitlePicker(): void {
  subtitlePicker.value = null;
}

async function handleTestSubtitleInPlayer(item: ScannedItem): Promise<void> {
  const result = await store.openItemInPlayer(item.id);
  if (!result.launched) {
    previewingSubtitleItem.value = item;
  }
}
const conflictsOpen = ref(false);
const confirmUnlockOpen = ref(false);
const activeTab = ref<WorkspaceTab>('organizer');

const { animateShellTimeline, animateEntrance } = useGsapMotion(rootRef);

onMounted(async (): Promise<void> => {
  animateShellTimeline();
  await store.bootstrapConnection();
});

const initBannerText = computed((): string =>
  store.connectionStatus === 'connecting'
    ? 'Connecting to backend server... Controls will unlock automatically once ready.'
    : 'Server is initializing mounts, cache, and workspace cleanup... Controls will unlock automatically when ready.'
);

watch(
  () => store.phase,
  (nextPhase, prevPhase): void => {
    if (prevPhase === 'SCANNING' && nextPhase === 'READY') {
      void store.refreshPreflightSafely();
    }
  }
);

watch(
  (): number => store.items.length,
  (nextLen, prevLen): void => {
    if (nextLen > 0 && nextLen !== prevLen) {
      animateEntrance('.vo-queue-row');
    }
  }
);

onUnmounted((): void => {
  store.disconnectSse();
});

const organizerModalConflictItemId = ref<ItemId | null>(null);
const organizerModalConflicts = computed(() =>
  organizerModalConflictItemId.value
    ? store.preflightConflicts.filter((c) => c.itemId === organizerModalConflictItemId.value)
    : store.preflightConflicts
);

async function handleProcess(): Promise<void> {
  organizerModalConflictItemId.value = null;
  const ok = await store.runPreflight();
  if (ok || !store.hasUnresolvedConflicts) {
    await store.startJob(store.savedConflictResolutions);
  }
}

function handleOpenOrganizerConflictModal(itemId: ItemId): void {
  organizerModalConflictItemId.value = itemId;
  conflictsOpen.value = true;
}

function handleSaveOrganizerConflicts(
  resolutions: Partial<Record<ItemId, ConflictDecision>>
): void {
  store.setConflictResolutions({
    ...store.savedConflictResolutions,
    ...resolutions
  });
  conflictsOpen.value = false;
  organizerModalConflictItemId.value = null;
}

function handleResolveAllConflicts(decision: ConflictDecision): void {
  const next: Partial<Record<ItemId, ConflictDecision>> = {};
  for (const conflict of store.preflightConflicts) {
    next[conflict.itemId] = decision;
  }
  store.setConflictResolutions(next);
}

async function patchItemAndRefresh(
  itemId: ItemId,
  patch: Parameters<typeof store.patchItem>[1]
): Promise<void> {
  await store.patchItem(itemId, patch);
  await store.refreshPreflightSafely();
}

async function handleConfirmConflicts(
  resolutions: Partial<Record<ItemId, ConflictDecision>>
): Promise<void> {
  handleSaveOrganizerConflicts(resolutions);
  await store.startJob(store.savedConflictResolutions);
}

async function handleSaveTracks(selection: TrackSelection, applySeries: boolean): Promise<void> {
  const target = inspectingItem.value;
  if (!target) {
    return;
  }
  await store.patchItem(target.id, { trackSelection: selection });
  if (applySeries) {
    await store.applyTracksToSeries({ ...target, trackSelection: selection });
  }
  inspectingItem.value = null;
  await store.refreshPreflightSafely();
}

function handleOpenBulkMetadata(items: readonly ScannedItem[]): void {
  if (items.length === 0) {
    return;
  }
  bulkSearchingItems.value = items;
  searchingItem.value = items[0] ?? null;
}

async function handleBulkInclude(itemIds: readonly ItemId[], include: boolean): Promise<void> {
  await store.patchItemsBulk(itemIds, { include });
  await store.refreshPreflightSafely();
}

async function handleBulkMediaKind(
  itemIds: readonly ItemId[],
  mediaKind: MediaKind
): Promise<void> {
  await store.patchItemsBulk(itemIds, { mediaKind });
  await store.refreshPreflightSafely();
}

async function handleBulkCategory(
  itemIds: readonly ItemId[],
  category: OutputCategory
): Promise<void> {
  await store.patchItemsBulk(itemIds, { category });
  await store.refreshPreflightSafely();
}

async function handleBulkAudioNormalization(
  itemIds: readonly ItemId[],
  mode: AudioNormalizationMode
): Promise<void> {
  await store.patchItemsBulk(itemIds, {
    audioNormalization: { mode, codec: 'auto', downmixStereo: false }
  });
}

async function handleApplyMetadata(
  candidate: MetadataCandidate,
  episodeOrder: EpisodeOrderMode
): Promise<void> {
  const bulkTargets = bulkSearchingItems.value;
  if (bulkTargets && bulkTargets.length > 0) {
    await store.patchItemsBulk(
      bulkTargets.map((item) => item.id),
      { selectedMetadata: candidate, episodeOrder }
    );
    bulkSearchingItems.value = null;
    searchingItem.value = null;
    await store.refreshPreflightSafely();
    return;
  }
  const target = searchingItem.value;
  if (!target) {
    return;
  }
  await store.patchItem(target.id, { selectedMetadata: candidate, episodeOrder });
  searchingItem.value = null;
  await store.refreshPreflightSafely();
}

const includedQueueCount = computed(() => {
  let count = 0;
  for (const item of store.items) {
    if (item.include) {
      count += 1;
    }
  }
  return count;
});

const isCancellingJob = ref(false);

async function handleCancelJob(): Promise<void> {
  if (isCancellingJob.value) {
    return;
  }
  isCancellingJob.value = true;
  try {
    await store.unlock(false);
  } finally {
    isCancellingJob.value = false;
  }
}

async function handleForceUnlock(): Promise<void> {
  confirmUnlockOpen.value = false;
  await store.unlock(true);
}

const verifierConflictResolutions = ref<Partial<Record<VerifierEntryId, ConflictDecision>>>({});
const verifierConflictsOpen = ref(false);
const verifierConflictEntries = ref<readonly VerifierEntry[]>([]);
const verifierFixAfterResolve = ref(false);

watch(
  () => store.verifierState.entries,
  (): void => {
    verifierConflictResolutions.value = {};
    verifierConflictsOpen.value = false;
    verifierConflictEntries.value = [];
    verifierFixAfterResolve.value = false;
  }
);

const verifierConflictComparisons = computed<readonly ConflictComparison<VerifierEntryId>[]>(() =>
  verifierConflictEntries.value
    .map((e) => e.collisionComparison)
    .filter((c): c is ConflictComparison<VerifierEntryId> => c !== undefined)
);

function handleResolveVerifierConflict(entry: VerifierEntry): void {
  if (!entry.collisionComparison) {
    return;
  }
  verifierConflictEntries.value = [entry];
  verifierFixAfterResolve.value = false;
  verifierConflictsOpen.value = true;
}

async function handleFixVerifierSelected(): Promise<void> {
  const selectedSet = new Set(selectedVerifierIds.value);
  const unresolvedCollisions = store.verifierState.entries.filter(
    (entry) =>
      selectedSet.has(entry.id) &&
      entry.issues.includes('DESTINATION_COLLISION') &&
      entry.collisionComparison !== undefined &&
      verifierConflictResolutions.value[entry.id] === undefined
  );
  if (unresolvedCollisions.length > 0) {
    verifierConflictEntries.value = unresolvedCollisions;
    verifierFixAfterResolve.value = true;
    verifierConflictsOpen.value = true;
    return;
  }
  await store.fixVerifier(selectedVerifierIds.value, verifierConflictResolutions.value);
}

function applyVerifierConflictMap(
  resolutions: Partial<Record<VerifierEntryId, ConflictDecision>>
): void {
  verifierConflictResolutions.value = {
    ...verifierConflictResolutions.value,
    ...resolutions
  };
}

function handleSaveVerifierConflicts(
  resolutions: Partial<Record<VerifierEntryId, ConflictDecision>>
): void {
  applyVerifierConflictMap(resolutions);
  verifierConflictsOpen.value = false;
  verifierFixAfterResolve.value = false;
}

async function handleConfirmVerifierConflicts(
  resolutions: Partial<Record<VerifierEntryId, ConflictDecision>>
): Promise<void> {
  applyVerifierConflictMap(resolutions);
  const shouldFix = verifierFixAfterResolve.value;
  verifierConflictsOpen.value = false;
  verifierFixAfterResolve.value = false;
  if (shouldFix) {
    await store.fixVerifier(selectedVerifierIds.value, verifierConflictResolutions.value);
  }
}
const activeJobSummaryText = computed<string>(() => {
  const job = store.activeJob;
  const label = formatPhaseLabel(store.phase);
  if (!job || job.totalItems <= 0) {
    return `${label} · Scanning...`;
  }
  const etaPart = job.etaSeconds !== undefined ? ` · ${formatEta(job.etaSeconds)}` : '';
  const stagePart = job.stageLabel ? ` · ${job.stageLabel}` : '';
  return `${label} (${job.jobId}) · ${String(job.completedItems)}/${String(job.totalItems)} (${String(job.currentPercent)}%)${etaPart}${stagePart}`;
});
</script>

<template>
  <main ref="rootRef" class="vo-shell">
    <AppHeader
      v-model:active-tab="activeTab"
      v-model:recalculate-verifier-tags="recalculateVerifierTags"
      :app-semver="appSemver"
      :phase="store.phase"
      :client-id="store.clientId"
      :queue-count="store.items.length"
      :verifier-count="store.verifierState.entries.length"
      :theme="store.theme"
      :is-initializing="store.isInitializing"
      :is-locked-by-other="store.isLockedByOther"
      :is-busy="store.isBusy"
      :can-process-queue="store.canProcessQueue"
      :has-unresolved-conflicts="store.hasUnresolvedConflicts"
      :included-queue-count="includedQueueCount"
      :verifier-scanning="store.verifierState.scanning"
      :verifier-fixing="store.verifierState.fixing"
      :selected-verifier-count="selectedVerifierIds.length"
      :mount-paths="store.mountPaths"
      :preferred-languages="store.preferredLanguages"
      @toggle-theme="store.toggleTheme()"
      @scan-input="void store.startScan().catch(() => undefined)"
      @process-queue="handleProcess()"
      @scan-verifier="store.scanVerifier(recalculateVerifierTags)"
      @fix-verifier="handleFixVerifierSelected()"
      @set-preferred-languages="(langs) => void store.setPreferredLanguages(langs)"
    />

    <section
      v-if="store.isInitializing"
      class="vo-banner vo-banner--initializing vo-panel"
      role="status"
      aria-live="polite"
    >
      <span>
        <span aria-hidden="true">⏳</span>
        {{ initBannerText }}
      </span>
    </section>

    <section v-if="store.isLockedByOther" class="vo-banner vo-panel">
      <span>
        Active session locked by <strong class="vo-mono">{{ store.lockOwnerClientId }}</strong>.
      </span>
      <div v-if="!confirmUnlockOpen">
        <button type="button" class="vo-btn vo-btn--danger" @click="confirmUnlockOpen = true">
          <span aria-hidden="true">🔓</span> Force Unlock
        </button>
      </div>
      <div v-else class="vo-header-actions">
        <span>Confirm overriding active session lock?</span>
        <button type="button" class="vo-btn vo-btn--danger" @click="handleForceUnlock()">
          <span aria-hidden="true">🔓</span> Confirm Unlock
        </button>
        <button type="button" class="vo-btn" @click="confirmUnlockOpen = false">
          <span aria-hidden="true">✖️</span> Cancel
        </button>
      </div>
    </section>

    <template v-if="activeTab === 'organizer'">
      <OrganizerStatusBar
        :is-busy="store.isBusy"
        :active-job="store.activeJob"
        :error-message="store.errorMessage"
        :is-locked-by-other="store.isLockedByOther"
        :is-cancelling-job="isCancellingJob"
        :can-skip-tasks="store.activeJob?.jobId === 'scan' && !store.isLockedByOther"
        :item-count="store.items.length"
        :summary-text="activeJobSummaryText"
        :phase="store.phase"
        @cancel="handleCancelJob"
        @dismiss-error="store.clearError()"
        @skip-task="void store.skipScanTask($event).catch(() => undefined)"
      />

      <section class="vo-panel">
        <QueueTable
          :items="store.items"
          :disabled="store.isInitializing || store.isLockedByOther || store.isBusy"
          :conflicts="store.preflightConflicts"
          :conflict-resolutions="store.savedConflictResolutions"
          :subtitle-picker="subtitlePicker"
          @search-subtitles="handleSearchSubtitles"
          @download-subtitle="handleDownloadSubtitle"
          @close-subtitle-picker="closeSubtitlePicker"
          @preview-subtitle="handleTestSubtitleInPlayer"
          @toggle-include="(item, inc) => patchItemAndRefresh(item.id, { include: inc })"
          @change-media-kind="
            (item, kind: MediaKind) => patchItemAndRefresh(item.id, { mediaKind: kind })
          "
          @change-category="
            (item, cat: OutputCategory) => patchItemAndRefresh(item.id, { category: cat })
          "
          @change-edition="(item, ed: string) => patchItemAndRefresh(item.id, { edition: ed })"
          @change-candidate="
            (item, idx) =>
              item.candidates[idx] &&
              patchItemAndRefresh(item.id, { selectedMetadata: item.candidates[idx] })
          "
          @search-metadata="
            (item) => {
              bulkSearchingItems = null;
              searchingItem = item;
            }
          "
          @search-metadata-bulk="handleOpenBulkMetadata"
          @bulk-include="handleBulkInclude"
          @bulk-media-kind="handleBulkMediaKind"
          @bulk-category="handleBulkCategory"
          @change-audio-normalization="
            (item, audioNormalization: AudioNormalizationConfig) =>
              store.patchItem(item.id, { audioNormalization })
          "
          @bulk-audio-normalization="handleBulkAudioNormalization"
          @inspect-tracks="(item) => (inspectingItem = item)"
          @open-conflict-modal="handleOpenOrganizerConflictModal"
          @resolve-all-conflicts="handleResolveAllConflicts"
        />
      </section>
    </template>

    <VerifierView
      v-else
      :state="store.verifierState"
      :disabled="store.isInitializing || store.isLockedByOther"
      :conflict-resolutions="verifierConflictResolutions"
      @update:selected-ids="(ids: readonly VerifierEntryId[]) => (selectedVerifierIds = ids)"
      @dismiss-error="store.clearVerifierErrors()"
      @resolve-conflict="handleResolveVerifierConflict"
    />

    <ServerLogsPanel :logs="store.logs" @clear="store.clearLogs()" />

    <MetadataSearchModal
      :item="searchingItem"
      :bulk-count="bulkSearchingItems?.length"
      :search-fn="store.searchMetadata"
      @close="
        () => {
          searchingItem = null;
          bulkSearchingItems = null;
        }
      "
      @apply="handleApplyMetadata"
    />

    <TrackInspectorModal
      :item="inspectingItem"
      @close="inspectingItem = null"
      @save="handleSaveTracks"
    />

    <SubtitlePreviewModal :item="previewingSubtitleItem" @close="previewingSubtitleItem = null" />

    <ConflictResolutionModal
      :open="conflictsOpen"
      :conflicts="organizerModalConflicts"
      :disk-space="store.preflightDiskSpace"
      :initial-resolutions="store.savedConflictResolutions"
      :mode="organizerModalConflictItemId !== null ? 'save-only' : 'confirm'"
      @close="
        () => {
          conflictsOpen = false;
          organizerModalConflictItemId = null;
        }
      "
      @save="handleSaveOrganizerConflicts"
      @confirm="handleConfirmConflicts"
    />

    <ConflictResolutionModal
      :open="verifierConflictsOpen"
      title="Destination Conflicts"
      :conflicts="verifierConflictComparisons"
      :initial-resolutions="verifierConflictResolutions"
      :mode="verifierFixAfterResolve ? 'save-and-confirm' : 'save-only'"
      @close="
        () => {
          verifierConflictsOpen = false;
          verifierFixAfterResolve = false;
        }
      "
      @save="handleSaveVerifierConflicts"
      @confirm="handleConfirmVerifierConflicts"
    />
  </main>
</template>

<style scoped lang="scss">
.vo-shell {
  display: grid;
  gap: var(--vo-space-3);
  grid-template-columns: minmax(0, 1fr);
  width: 100%;
  padding: var(--vo-space-2);
}

.vo-panel {
  min-width: 0;
  max-width: 100%;
}

.vo-header-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vo-space-2);
  margin-inline-start: auto;
}
</style>
