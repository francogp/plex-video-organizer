import gsap from 'gsap';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import type {
  ActiveJobProgress,
  AudioLanguageCode,
  ClientId,
  ConflictComparison,
  ConflictDecision,
  ConnectionStatus,
  DiskSpaceCheck,
  EpisodeOrderMode,
  ExternalSubtitleFile,
  ItemId,
  ItemPatch,
  JobId,
  JobPhase,
  MediaKind,
  MetadataCandidate,
  MetadataLanguageCode,
  MountPathsMap,
  OrganizerStatePayload,
  ScannedItem,
  ServerInitStatus,
  SseLogEvent,
  SubtitleCandidate,
  TrackSelection,
  VerifierEntryId,
  VerifierState
} from '../../domain/types.ts';
import {
  buildMergedTrackSelection,
  createOrganizerSseSource,
  executeJsonFetch,
  type ApiErrorEnvelope,
  type OrganizerSseConnection
} from '../utils/organizerApi.ts';
import {
  getInitialAudioPreferredLanguages,
  getInitialPreferredLanguages,
  getInitialThemeMode,
  getOrCreateClientId,
  saveAudioPreferredLanguages,
  savePreferredLanguages,
  saveThemeMode,
  type ThemeMode
} from '../utils/storage.ts';

const MAX_LOG_ENTRIES = 100;
const HTTP_CONFLICT_STATUS = 409;
const MAX_STALE_REVISION_ATTEMPTS = 2;

export const useOrganizerStore = defineStore('organizer', () => {
  const clientId = ref<ClientId>(getOrCreateClientId() as ClientId);
  const theme = ref<ThemeMode>(getInitialThemeMode());
  const preferredLanguages = ref<readonly MetadataLanguageCode[]>(getInitialPreferredLanguages());
  const audioPreferredLanguages = ref<readonly AudioLanguageCode[]>(
    getInitialAudioPreferredLanguages()
  );
  const connectionStatus = ref<ConnectionStatus>('connecting');
  const serverInitStatus = ref<ServerInitStatus>('initializing');
  const ffmpegVersion = ref<string | null>(null);
  const phase = ref<JobPhase>('IDLE');
  const revision = ref<number>(0);
  const lockOwnerClientId = ref<ClientId | null>(null);
  const mountPaths = ref<MountPathsMap | null>(null);
  const items = ref<ScannedItem[]>([]);
  const activeJob = ref<ActiveJobProgress | null>(null);
  const logs = ref<SseLogEvent[]>([]);
  const preflightConflicts = ref<ConflictComparison[]>([]);
  const preflightDiskSpace = ref<DiskSpaceCheck[]>([]);
  const savedConflictResolutions = ref<Partial<Record<ItemId, ConflictDecision>>>({});
  const verifierState = ref<VerifierState>({
    scanning: false,
    fixing: false,
    summary: null,
    entries: [],
    lastFixResult: null
  });
  const errorMessage = ref<string | null>(null);
  let eventSource: OrganizerSseConnection | null = null;

  const isLockedByOther = computed(
    (): boolean => lockOwnerClientId.value !== null && lockOwnerClientId.value !== clientId.value
  );

  const isBusy = computed(
    (): boolean => phase.value === 'SCANNING' || phase.value === 'PROCESSING'
  );

  const isInitializing = computed(
    (): boolean => connectionStatus.value !== 'ready' || serverInitStatus.value !== 'ready'
  );

  const hasUnresolvedConflicts = computed((): boolean =>
    preflightConflicts.value.some(
      (c): boolean =>
        savedConflictResolutions.value[c.itemId] !== 'overwrite' &&
        savedConflictResolutions.value[c.itemId] !== 'ignore'
    )
  );

  const canProcessQueue = computed((): boolean => {
    if (isInitializing.value || isLockedByOther.value || isBusy.value) {
      return false;
    }
    const included = items.value.filter((item) => item.include);
    return (
      included.length > 0 &&
      included.every(
        (item): boolean =>
          Boolean(item.selectedMetadata?.title.trim()) && !item.trackSelection.needsUserPrompt
      )
    );
  });

  function applyThemeToDocument(mode: ThemeMode): void {
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = mode;
    }
  }

  function toggleTheme(): void {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
    saveThemeMode(theme.value);
    applyThemeToDocument(theme.value);
  }

  function applyServerState(state: OrganizerStatePayload): void {
    phase.value = state.phase;
    serverInitStatus.value = state.initStatus ?? 'ready';
    if (state.ffmpegVersion !== undefined) {
      ffmpegVersion.value = state.ffmpegVersion;
    }
    revision.value = state.revision;
    lockOwnerClientId.value = state.lockOwnerClientId;
    mountPaths.value = state.mountPaths;
    items.value = [...state.items];
    activeJob.value = state.activeJob;
    if (Array.isArray(state.logs)) {
      logs.value = [...state.logs];
    }
    if (state.verifier) {
      verifierState.value = state.verifier;
    }
    if (state.preferredLanguages && state.preferredLanguages.length > 0) {
      preferredLanguages.value = state.preferredLanguages;
    }
    if (state.audioPreferredLanguages && state.audioPreferredLanguages.length > 0) {
      audioPreferredLanguages.value = state.audioPreferredLanguages;
    }
    if (state.conflictResolutions) {
      savedConflictResolutions.value = { ...state.conflictResolutions };
    }
    if (state.phase === 'ERROR' && state.lastError) {
      errorMessage.value = state.lastError;
    }
  }

  async function updateLanguagePreference<T extends string>(
    languages: readonly T[],
    targetRef: { value: readonly T[] },
    saveFn: (langs: readonly T[]) => void,
    payloadKey: 'preferredLanguages' | 'audioPreferredLanguages'
  ): Promise<void> {
    if (languages.length === 0) {
      return;
    }
    targetRef.value = [...languages];
    saveFn(languages);
    const next = await requestJson<OrganizerStatePayload>('/api/preferences', {
      method: 'POST',
      body: JSON.stringify({ [payloadKey]: languages })
    });
    applyServerState(next);
  }

  async function setPreferredLanguages(languages: readonly MetadataLanguageCode[]): Promise<void> {
    await updateLanguagePreference(
      languages,
      preferredLanguages,
      savePreferredLanguages,
      'preferredLanguages'
    );
  }

  async function setAudioPreferredLanguages(
    languages: readonly AudioLanguageCode[]
  ): Promise<void> {
    await updateLanguagePreference(
      languages,
      audioPreferredLanguages,
      saveAudioPreferredLanguages,
      'audioPreferredLanguages'
    );
  }

  async function clearLogs(): Promise<void> {
    logs.value = [];
    const next = await requestJson<OrganizerStatePayload>('/api/logs/clear', { method: 'POST' });
    applyServerState(next);
  }

  function clearError(): void {
    errorMessage.value = null;
  }

  let mutationChain: Promise<void> = Promise.resolve();

  function enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
    const run = mutationChain.then(task, task);
    mutationChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  function throwApiError(status: number, data: ApiErrorEnvelope): never {
    if (data.state) {
      applyServerState(data.state);
    }
    const msg = data.message ?? data.error ?? `HTTP ${String(status)}`;
    errorMessage.value = msg;
    throw new Error(msg);
  }

  async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    errorMessage.value = null;
    try {
      const { ok, status, data } = await executeJsonFetch<T>(clientId.value, url, init);
      if (!ok) {
        throwApiError(status, data);
      }
      return data;
    } catch (err) {
      if (errorMessage.value === null) {
        errorMessage.value = err instanceof Error ? err.message : String(err);
      }
      throw err;
    }
  }

  async function requestRevisionMutation<T>(url: string, buildInit: () => RequestInit): Promise<T> {
    errorMessage.value = null;
    for (let attempt = 0; attempt < MAX_STALE_REVISION_ATTEMPTS; attempt += 1) {
      const { ok, status, data } = await executeJsonFetch<T>(clientId.value, url, buildInit());
      if (ok) {
        return data;
      }
      if (data.state) {
        applyServerState(data.state);
      }
      const isRetryableStale =
        attempt === 0 &&
        status === HTTP_CONFLICT_STATUS &&
        data.error === 'STALE_REVISION' &&
        data.state !== undefined;
      if (isRetryableStale) {
        errorMessage.value = null;
        continue;
      }
      throwApiError(status, data);
    }
    throw new Error('Mutation exceeded stale-revision retry limit');
  }

  async function fetchState(): Promise<void> {
    applyThemeToDocument(theme.value);
    const state = await requestJson<OrganizerStatePayload>('/api/state');
    connectionStatus.value = 'ready';
    applyServerState(state);
    if (state.preferredLanguages) {
      savePreferredLanguages(state.preferredLanguages);
    }
    if (state.audioPreferredLanguages) {
      saveAudioPreferredLanguages(state.audioPreferredLanguages);
    }
  }

  let bootstrapCall: gsap.core.Tween | null = null;
  const BOOTSTRAP_RETRY_SECONDS = 0.5;

  async function bootstrapConnection(): Promise<void> {
    try {
      await fetchState();
      connectSse();
      await refreshPreflightSafely();
    } catch {
      errorMessage.value = null;
      bootstrapCall?.kill();
      bootstrapCall = gsap.delayedCall(BOOTSTRAP_RETRY_SECONDS, (): void => {
        bootstrapCall = null;
        void bootstrapConnection();
      });
    }
  }

  function clearVerifierErrors(): void {
    if (!verifierState.value.lastFixResult) {
      return;
    }
    verifierState.value = {
      ...verifierState.value,
      lastFixResult: {
        ...verifierState.value.lastFixResult,
        errors: []
      }
    };
  }

  let sseHadError = false;
  let lastSseActivityAt = 0;
  let syncPollCall: gsap.core.Tween | null = null;
  const SSE_STALL_FALLBACK_MS = 2000;
  const MS_PER_SECOND = 1000;

  async function resyncStateSafely(): Promise<void> {
    try {
      await fetchState();
    } catch (err) {
      console.warn('[SSE resync]', err);
    }
  }

  function stopSyncFallback(): void {
    syncPollCall?.kill();
    syncPollCall = null;
  }

  function ensureSyncFallback(): void {
    if (syncPollCall !== null) {
      return;
    }
    const scheduleTick = (): void => {
      syncPollCall = gsap.delayedCall(SSE_STALL_FALLBACK_MS / MS_PER_SECOND, (): void => {
        syncPollCall = null;
        const stillRunning =
          isBusy.value ||
          Boolean(activeJob.value) ||
          verifierState.value.scanning ||
          verifierState.value.fixing;
        if (!stillRunning) {
          return;
        }
        if (performance.now() - lastSseActivityAt >= SSE_STALL_FALLBACK_MS) {
          lastSseActivityAt = performance.now();
          void resyncStateSafely();
        }
        scheduleTick();
      });
    };
    scheduleTick();
  }

  function connectSse(): void {
    if (eventSource) {
      return;
    }
    eventSource = createOrganizerSseSource({
      onOpen: (): void => {
        lastSseActivityAt = performance.now();
        if (sseHadError) {
          sseHadError = false;
          void resyncStateSafely();
        }
      },
      onError: (): void => {
        sseHadError = true;
      },
      onState: (payload): void => {
        lastSseActivityAt = performance.now();
        applyServerState(payload);
      },
      onProgress: (prog): void => {
        lastSseActivityAt = performance.now();
        if (activeJob.value && activeJob.value.jobId === prog.jobId) {
          activeJob.value = {
            ...activeJob.value,
            activeTasks: prog.activeTasks,
            totalItems: prog.totalItems ?? activeJob.value.totalItems,
            completedItems: prog.completedItems ?? activeJob.value.completedItems,
            currentPercent: prog.percent,
            stage: prog.stage ?? activeJob.value.stage,
            stageLabel: prog.stageLabel ?? activeJob.value.stageLabel,
            etaSeconds: prog.etaSeconds,
            etaState: prog.etaState,
            drainRequested: prog.drainRequested ?? activeJob.value.drainRequested
          };
        }
      },
      onLog: (log): void => {
        lastSseActivityAt = performance.now();
        logs.value = [...logs.value.slice(-(MAX_LOG_ENTRIES - 1)), log];
      }
    });
  }

  function disconnectSse(): void {
    eventSource?.close();
    eventSource = null;
    stopSyncFallback();
  }

  async function setConflictResolutions(
    resolutions: Readonly<Partial<Record<ItemId, ConflictDecision>>>
  ): Promise<void> {
    const previous = { ...savedConflictResolutions.value };
    const next = { ...resolutions };
    savedConflictResolutions.value = next;
    try {
      await enqueueMutation(async () => {
        const state = await requestRevisionMutation<OrganizerStatePayload>(
          '/api/conflict-resolutions',
          () => ({
            method: 'POST',
            body: JSON.stringify({
              revision: revision.value,
              conflictResolutions: next
            })
          })
        );
        applyServerState(state);
      });
    } catch (err: unknown) {
      savedConflictResolutions.value = previous;
      errorMessage.value = err instanceof Error ? err.message : String(err);
    }
  }

  function clearConflictResolutions(): void {
    savedConflictResolutions.value = {};
  }

  async function refreshPreflightSafely(): Promise<void> {
    if (isLockedByOther.value || isBusy.value) {
      return;
    }
    const hasIncluded = items.value.some((item) => item.include);
    if (!hasIncluded) {
      preflightConflicts.value = [];
      preflightDiskSpace.value = [];
      return;
    }
    try {
      await runPreflight();
    } catch {
      // Non-fatal background check; explicit runPreflight() on process surfaces errors
    }
  }

  async function startScan(): Promise<void> {
    lastSseActivityAt = performance.now();
    await requestJson<{ readonly revision: number }>('/api/scan', { method: 'POST' });
    if (phase.value !== 'SCANNING') {
      phase.value = 'SCANNING';
    }
    ensureSyncFallback();
  }

  async function skipScanTask(itemId: ItemId): Promise<void> {
    await requestJson<{ readonly skipped: boolean }>('/api/scan/skip', {
      method: 'POST',
      body: JSON.stringify({ itemId })
    });
  }

  async function scanVerifier(recalculateTags = false): Promise<void> {
    lastSseActivityAt = performance.now();
    verifierState.value = {
      ...verifierState.value,
      scanning: true,
      progress: {
        completed: 0,
        total: 0,
        percent: 0,
        stageLabel: 'Discovering libraries...',
        activeTasks: []
      },
      lastFixResult: null
    };
    await requestJson<{ readonly revision: number }>('/api/verifier/scan', {
      method: 'POST',
      body: JSON.stringify({ recalculateTags })
    });
    ensureSyncFallback();
  }

  async function fixVerifier(
    entryIds: readonly VerifierEntryId[],
    conflictResolutions?: Readonly<Partial<Record<VerifierEntryId, ConflictDecision>>>
  ): Promise<void> {
    if (entryIds.length === 0) {
      return;
    }
    lastSseActivityAt = performance.now();
    verifierState.value = {
      ...verifierState.value,
      fixing: true,
      progress: {
        completed: 0,
        total: entryIds.length,
        percent: 0,
        stageLabel: 'Applying bottom-up renames...',
        activeTasks: []
      },
      lastFixResult: null
    };
    await requestJson<{ readonly revision: number }>('/api/verifier/fix', {
      method: 'POST',
      body: JSON.stringify({ entryIds, conflictResolutions })
    });
    ensureSyncFallback();
  }

  async function patchItem(itemId: ItemId, patch: ItemPatch): Promise<void> {
    await enqueueMutation(async () => {
      clearConflictResolutions();
      const next = await requestRevisionMutation<OrganizerStatePayload>(
        `/api/queue/items/${itemId}`,
        () => ({
          method: 'PATCH',
          body: JSON.stringify({ revision: revision.value, patch })
        })
      );
      applyServerState(next);
    });
  }

  async function patchItemsBulk(itemIds: readonly ItemId[], patch: ItemPatch): Promise<void> {
    if (itemIds.length === 0) {
      return;
    }
    await enqueueMutation(async () => {
      clearConflictResolutions();
      const next = await requestRevisionMutation<OrganizerStatePayload>(
        '/api/queue/items/bulk',
        () => ({
          method: 'PATCH',
          body: JSON.stringify({ revision: revision.value, itemIds, patch })
        })
      );
      applyServerState(next);
    });
  }

  async function applyTracksToSeries(sourceItem: ScannedItem): Promise<void> {
    const seriesTitle = sourceItem.parsedTitle;
    for (const item of items.value) {
      if (
        item.mediaKind === 'tv' &&
        item.parsedTitle === seriesTitle &&
        item.id !== sourceItem.id
      ) {
        await patchItem(item.id, {
          category: sourceItem.category,
          edition: sourceItem.edition,
          selectedMetadata: sourceItem.selectedMetadata,
          episodeOrder: sourceItem.episodeOrder,
          trackSelection: buildMergedTrackSelection(item.trackSelection, sourceItem.trackSelection)
        });
      }
    }
  }

  async function applyTracksToItems(
    targetIds: readonly ItemId[],
    templateSelection: TrackSelection
  ): Promise<void> {
    const idSet = new Set(targetIds);
    for (const item of items.value) {
      if (!idSet.has(item.id)) {
        continue;
      }
      await patchItem(item.id, {
        trackSelection: buildMergedTrackSelection(item.trackSelection, templateSelection)
      });
    }
  }

  async function searchMetadata(params: {
    readonly query: string;
    readonly year?: number;
    readonly kind: MediaKind;
    readonly imdbId?: string;
    readonly tvdbId?: string;
    readonly episodeOrder?: EpisodeOrderMode;
  }): Promise<readonly MetadataCandidate[]> {
    const res = await requestJson<{ readonly candidates: readonly MetadataCandidate[] }>(
      '/api/metadata/search',
      {
        method: 'POST',
        body: JSON.stringify(params)
      }
    );
    return res.candidates;
  }

  async function searchItemSubtitles(itemId: ItemId): Promise<readonly SubtitleCandidate[]> {
    const res = await requestJson<{ readonly candidates: readonly SubtitleCandidate[] }>(
      `/api/queue/items/${encodeURIComponent(itemId)}/subtitles/search`,
      { method: 'POST', body: JSON.stringify({}) }
    );
    return res.candidates;
  }

  async function downloadItemSubtitle(
    itemId: ItemId,
    candidate?: SubtitleCandidate
  ): Promise<ExternalSubtitleFile> {
    const res = await requestJson<{
      readonly state: OrganizerStatePayload;
      readonly downloaded: ExternalSubtitleFile;
    }>(`/api/queue/items/${encodeURIComponent(itemId)}/subtitles/download`, {
      method: 'POST',
      body: JSON.stringify({ revision: revision.value, candidate })
    });
    applyServerState(res.state);
    return res.downloaded;
  }

  async function runPreflight(): Promise<boolean> {
    return enqueueMutation(async () => {
      const res = await requestRevisionMutation<{
        readonly revision: number;
        readonly ok: boolean;
        readonly diskSpace: DiskSpaceCheck[];
        readonly conflicts: ConflictComparison[];
      }>('/api/preflight', () => ({
        method: 'POST',
        body: JSON.stringify({ revision: revision.value })
      }));
      revision.value = res.revision;
      preflightConflicts.value = res.conflicts;
      preflightDiskSpace.value = res.diskSpace;
      return res.ok;
    });
  }

  async function startJob(
    conflictResolutions: Readonly<Partial<Record<ItemId, ConflictDecision>>> = {}
  ): Promise<void> {
    await enqueueMutation(async () => {
      await requestJson<{ readonly jobId: JobId; readonly revision: number }>('/api/jobs/start', {
        method: 'POST',
        body: JSON.stringify({ revision: revision.value, conflictResolutions })
      });
    });
  }

  async function unlock(force: boolean): Promise<void> {
    const next = await requestJson<OrganizerStatePayload>('/api/jobs/unlock', {
      method: 'POST',
      body: JSON.stringify({ force })
    });
    applyServerState(next);
  }

  async function drainJob(): Promise<void> {
    const next = await requestJson<OrganizerStatePayload>('/api/jobs/drain', {
      method: 'POST'
    });
    applyServerState(next);
  }

  return {
    clientId,
    theme,
    preferredLanguages,
    audioPreferredLanguages,
    connectionStatus,
    serverInitStatus,
    isInitializing,
    ffmpegVersion,
    phase,
    revision,
    lockOwnerClientId,
    mountPaths,
    items,
    activeJob,
    logs,
    preflightConflicts,
    preflightDiskSpace,
    savedConflictResolutions,
    verifierState,
    hasUnresolvedConflicts,
    errorMessage,
    isLockedByOther,
    isBusy,
    canProcessQueue,
    toggleTheme,
    setPreferredLanguages,
    setAudioPreferredLanguages,
    fetchState,
    bootstrapConnection,
    connectSse,
    disconnectSse,
    startScan,
    skipScanTask,
    scanVerifier,
    fixVerifier,
    patchItem,
    patchItemsBulk,
    applyTracksToSeries,
    applyTracksToItems,
    searchMetadata,
    searchItemSubtitles,
    downloadItemSubtitle,
    runPreflight,
    refreshPreflightSafely,
    setConflictResolutions,
    clearConflictResolutions,
    startJob,
    unlock,
    drainJob,
    clearLogs,
    clearError,
    clearVerifierErrors
  };
});
