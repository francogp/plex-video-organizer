<script setup lang="ts">
import { computed, ref } from 'vue';

import type {
  ActiveJobProgress,
  AudioLanguageCode,
  AudioNormalizationConfig,
  ClientId,
  ItemId,
  JobItemError,
  JobPhase,
  MediaKind,
  MetadataLanguageCode,
  MountPathsMap,
  OutputCategory,
  ScannedItem,
  SseLogEvent,
  VerifierEntryId,
  VerifierState
} from '../../domain/types.ts';
import {
  useOrganizerWorkflow,
  type WorkflowStorePort
} from '../composables/useOrganizerWorkflow.ts';
import type { ErrorToastState } from '../types.ts';
import { formatEta, formatPhaseLabel } from '../utils/formatters.ts';
import AppHeader, { type WorkspaceTab } from './AppHeader.vue';
import ErrorToast from './ErrorToast.vue';
import OrganizerModals from './OrganizerModals.vue';
import OrganizerStatusBar from './OrganizerStatusBar.vue';
import QueueTable from './QueueTable.vue';
import ServerLogsPanel from './ServerLogsPanel.vue';
import VerifierView from './VerifierView.vue';

export interface WorkspaceViewStore extends WorkflowStorePort {
  readonly phase: JobPhase;
  readonly clientId: ClientId;
  readonly theme: 'light' | 'dark';
  readonly lockOwnerClientId: ClientId | null;
  readonly mountPaths: MountPathsMap | null;
  readonly preferredLanguages: readonly MetadataLanguageCode[];
  readonly audioPreferredLanguages: readonly AudioLanguageCode[];
  readonly canProcessQueue: boolean;
  readonly connectionStatus: 'connecting' | 'connected' | 'disconnected';
  readonly activeJob: ActiveJobProgress | null;
  readonly errorMessage: string | null;
  readonly lastJobErrors: readonly JobItemError[];
  readonly errorToast: ErrorToastState;
  readonly isInitializing: boolean;
  readonly isLockedByOther: boolean;
  readonly isBusy: boolean;
  readonly logs: readonly SseLogEvent[];
  readonly items: readonly ScannedItem[];
  readonly verifierState: VerifierState;
  toggleTheme(): void;
  startScan(): Promise<void>;
  scanVerifier(recalculateTags?: boolean): Promise<void>;
  setPreferredLanguages(langs: readonly MetadataLanguageCode[]): Promise<void>;
  setAudioPreferredLanguages(langs: readonly AudioLanguageCode[]): Promise<void>;
  clearError(): void;
  dismissErrorToast(): void;
  skipScanTask(itemId: ItemId): Promise<void>;
  clearVerifierErrors(): void;
  clearLogs(): Promise<void>;
}

const props = defineProps<{
  readonly appSemver: string;
  readonly store: WorkspaceViewStore;
}>();

const activeTab = ref<WorkspaceTab>('organizer');
const logsContainerRef = ref<HTMLElement | null>(null);
const wf = useOrganizerWorkflow(props.store);

function scrollToLogs(): void {
  logsContainerRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const initBannerText = computed((): string =>
  props.store.connectionStatus === 'connecting'
    ? 'Connecting to backend server... Controls will unlock automatically once ready.'
    : 'Server is initializing mounts, cache, and workspace cleanup... Controls will unlock automatically when ready.'
);

const activeJobSummaryText = computed<string>(() => {
  const job = props.store.activeJob;
  const label = formatPhaseLabel(props.store.phase);
  if (!job || job.totalItems <= 0) {
    return `${label} · Scanning...`;
  }
  const etaText = formatEta(job.etaSeconds, job.etaState);
  const etaPart = etaText ? ` · ${etaText}` : '';
  const stagePart = job.stageLabel ? ` · ${job.stageLabel}` : '';
  return `${label} (${job.jobId}) · ${String(job.completedItems)}/${String(job.totalItems)} (${String(job.currentPercent)}%)${etaPart}${stagePart}`;
});
</script>

<template>
  <AppHeader
    v-model:active-tab="activeTab"
    v-model:recalculate-verifier-tags="wf.recalculateVerifierTags.value"
    :app-semver="appSemver"
    :ffmpeg-version="store.ffmpegVersion"
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
    :included-queue-count="wf.includedQueueCount.value"
    :verifier-scanning="store.verifierState.scanning"
    :verifier-fixing="store.verifierState.fixing"
    :selected-verifier-count="wf.selectedVerifierIds.value.length"
    :mount-paths="store.mountPaths"
    :preferred-languages="store.preferredLanguages"
    :audio-preferred-languages="store.audioPreferredLanguages"
    @toggle-theme="store.toggleTheme()"
    @scan-input="void store.startScan().catch(() => undefined)"
    @process-queue="wf.handleProcess()"
    @scan-verifier="store.scanVerifier(wf.recalculateVerifierTags.value)"
    @fix-verifier="wf.handleFixVerifierSelected()"
    @set-preferred-languages="(langs) => void store.setPreferredLanguages(langs)"
    @set-audio-preferred-languages="(langs) => void store.setAudioPreferredLanguages(langs)"
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
    <div v-if="!wf.confirmUnlockOpen.value">
      <button
        type="button"
        class="vo-btn vo-btn--danger"
        @click="wf.confirmUnlockOpen.value = true"
      >
        <span aria-hidden="true">🔓</span> Force Unlock
      </button>
    </div>
    <div v-else class="vo-header-actions">
      <span>Confirm overriding active session lock?</span>
      <button type="button" class="vo-btn vo-btn--danger" @click="wf.handleForceUnlock()">
        <span aria-hidden="true">🔓</span> Confirm Unlock
      </button>
      <button type="button" class="vo-btn" @click="wf.confirmUnlockOpen.value = false">
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
      :is-cancelling-job="wf.isCancellingJob.value"
      :is-draining-job="wf.isDrainingJob.value"
      :can-skip-tasks="store.activeJob?.jobId === 'scan' && !store.isLockedByOther"
      :item-count="store.items.length"
      :summary-text="activeJobSummaryText"
      :phase="store.phase"
      @cancel="wf.handleCancelJob"
      @drain="wf.handleDrainJob"
      @dismiss-error="store.clearError()"
      @skip-task="void store.skipScanTask($event).catch(() => undefined)"
    />

    <section class="vo-panel">
      <QueueTable
        :items="store.items"
        :disabled="store.isInitializing || store.isLockedByOther || store.isBusy"
        :conflicts="store.preflightConflicts"
        :conflict-resolutions="store.savedConflictResolutions"
        :job-errors="store.lastJobErrors"
        :subtitle-picker="wf.subtitlePicker.value"
        @search-subtitles="wf.handleSearchSubtitles"
        @preview-subtitle="wf.handleTestSubtitleInPlayer"
        @toggle-include="(item, inc) => wf.patchItemAndRefresh(item.id, { include: inc })"
        @change-media-kind="
          (item, kind: MediaKind) => wf.patchItemAndRefresh(item.id, { mediaKind: kind })
        "
        @change-category="
          (item, cat: OutputCategory) => wf.patchItemAndRefresh(item.id, { category: cat })
        "
        @change-edition="(item, ed: string) => wf.patchItemAndRefresh(item.id, { edition: ed })"
        @change-candidate="
          (item, idx) =>
            item.candidates[idx] &&
            wf.patchItemAndRefresh(item.id, { selectedMetadata: item.candidates[idx] })
        "
        @search-metadata="wf.openSingleMetadataSearch"
        @search-metadata-bulk="wf.handleOpenBulkMetadata"
        @edit-tracks-bulk="wf.handleOpenBulkTracks"
        @bulk-include="wf.handleBulkInclude"
        @bulk-media-kind="wf.handleBulkMediaKind"
        @bulk-category="wf.handleBulkCategory"
        @change-audio-normalization="
          (item, audioNormalization: AudioNormalizationConfig) =>
            store.patchItem(item.id, { audioNormalization })
        "
        @bulk-audio-normalization="wf.handleBulkAudioNormalization"
        @inspect-tracks="wf.openSingleTrackInspector"
        @open-conflict-modal="wf.handleOpenOrganizerConflictModal"
        @resolve-all-conflicts="wf.handleResolveAllConflicts"
      />
    </section>
  </template>

  <VerifierView
    v-else
    :state="store.verifierState"
    :disabled="store.isInitializing || store.isLockedByOther"
    :conflict-resolutions="wf.verifierConflictResolutions.value"
    @update:selected-ids="(ids: readonly VerifierEntryId[]) => (wf.selectedVerifierIds.value = ids)"
    @dismiss-error="store.clearVerifierErrors()"
    @resolve-conflict="wf.handleResolveVerifierConflict"
  />

  <div ref="logsContainerRef">
    <ServerLogsPanel :logs="store.logs" @clear="store.clearLogs()" />
  </div>

  <ErrorToast
    :state="store.errorToast"
    @dismiss="store.dismissErrorToast()"
    @view-logs="scrollToLogs()"
  />

  <OrganizerModals :store="store" :workflow="wf" />
</template>

<style scoped lang="scss">
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
