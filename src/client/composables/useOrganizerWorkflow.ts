import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';

import type {
  AudioNormalizationConfig,
  ConflictComparison,
  ConflictDecision,
  DiskSpaceCheck,
  EpisodeOrderMode,
  EtaSimulationSnapshot,
  ItemId,
  ItemPatch,
  MediaKind,
  MetadataCandidate,
  OutputCategory,
  ScannedItem,
  SubtitleCandidate,
  TrackSelection,
  VerifierEntry,
  VerifierEntryId,
  VerifierState
} from '../../domain/types.ts';

export interface WorkflowStorePort {
  readonly items: readonly ScannedItem[];
  readonly preflightConflicts: readonly ConflictComparison[];
  readonly preflightDiskSpace: DiskSpaceCheck | null;
  readonly savedConflictResolutions: Partial<Record<ItemId, ConflictDecision>>;
  readonly hasUnresolvedConflicts: boolean;
  readonly verifierState: VerifierState;
  patchItem(itemId: ItemId, patch: ItemPatch): Promise<void>;
  patchItemsBulk(itemIds: readonly ItemId[], patch: ItemPatch): Promise<void>;
  applyTracksToItems(itemIds: readonly ItemId[], selection: TrackSelection): Promise<void>;
  applyTracksToSeries(sourceItem: ScannedItem): Promise<void>;
  searchMetadata(params: {
    readonly mediaKind: MediaKind;
    readonly query: string;
    readonly year?: number;
  }): Promise<readonly MetadataCandidate[]>;
  searchItemSubtitles(itemId: ItemId): Promise<readonly SubtitleCandidate[]>;
  downloadItemSubtitle(itemId: ItemId, candidate: SubtitleCandidate): Promise<void>;
  runPreflight(): Promise<boolean>;
  refreshPreflightSafely(): Promise<void>;
  setConflictResolutions(resolutions: Partial<Record<ItemId, ConflictDecision>>): Promise<void>;
  startJob(resolutions: Partial<Record<ItemId, ConflictDecision>>): Promise<void>;
  unlock(force: boolean): Promise<void>;
  drainJob(): Promise<void>;
  fetchEtaSimulation(): Promise<EtaSimulationSnapshot>;
  fixVerifier(
    entryIds: readonly VerifierEntryId[],
    conflictResolutions: Partial<Record<VerifierEntryId, ConflictDecision>>
  ): Promise<void>;
}

export interface SubtitlePickerViewState {
  readonly itemId: ItemId;
  readonly loading: boolean;
  readonly downloadingId: string | null;
  readonly error: string | null;
  readonly candidates: readonly SubtitleCandidate[];
}

export interface OrganizerWorkflow {
  readonly inspectingItem: Ref<ScannedItem | null>;
  readonly searchingItem: Ref<ScannedItem | null>;
  readonly bulkSearchingItems: Ref<readonly ScannedItem[] | null>;
  readonly bulkTrackItems: Ref<readonly ScannedItem[] | null>;
  readonly selectedVerifierIds: Ref<readonly VerifierEntryId[]>;
  readonly recalculateVerifierTags: Ref<boolean>;
  readonly previewingSubtitleItem: Ref<ScannedItem | null>;
  readonly subtitlePicker: Ref<SubtitlePickerViewState | null>;
  readonly subtitlePickerItem: ComputedRef<ScannedItem | null>;
  readonly conflictsOpen: Ref<boolean>;
  readonly confirmUnlockOpen: Ref<boolean>;
  readonly isCancellingJob: Ref<boolean>;
  readonly isDrainingJob: Ref<boolean>;
  readonly organizerModalConflicts: ComputedRef<readonly ConflictComparison[]>;
  readonly isSingleOrganizerConflict: ComputedRef<boolean>;
  readonly includedQueueCount: ComputedRef<number>;
  readonly verifierConflictResolutions: Ref<Partial<Record<VerifierEntryId, ConflictDecision>>>;
  readonly verifierConflictsOpen: Ref<boolean>;
  readonly verifierFixAfterResolve: Ref<boolean>;
  readonly verifierConflictComparisons: ComputedRef<readonly ConflictComparison<VerifierEntryId>[]>;
  readonly etaSimulationOpen: Ref<boolean>;
  readonly etaSimulationData: Ref<EtaSimulationSnapshot | null>;
  readonly etaSimulationLoading: Ref<boolean>;
  readonly etaSimulationError: Ref<string | null>;
  openEtaSimulation(): Promise<void>;
  refreshEtaSimulation(): Promise<void>;
  closeEtaSimulation(): void;
  handleSearchSubtitles(item: ScannedItem): Promise<void>;
  handleDownloadSubtitle(item: ScannedItem, candidate: SubtitleCandidate): Promise<void>;
  closeSubtitlePicker(): void;
  closeSearchModal(): void;
  closeTrackModal(): void;
  closePreviewModal(): void;
  openSingleMetadataSearch(item: ScannedItem): void;
  openSingleTrackInspector(item: ScannedItem): void;
  closeOrganizerConflicts(): void;
  closeVerifierConflicts(): void;
  handleTestSubtitleInPlayer(item: ScannedItem): void;
  handleProcess(): Promise<void>;
  handleOpenOrganizerConflictModal(itemId: ItemId): void;
  handleSaveOrganizerConflicts(resolutions: Partial<Record<ItemId, ConflictDecision>>): void;
  handleResolveAllConflicts(decision: ConflictDecision): void;
  patchItemAndRefresh(itemId: ItemId, patch: ItemPatch): Promise<void>;
  handleConfirmConflicts(resolutions: Partial<Record<ItemId, ConflictDecision>>): Promise<void>;
  handleSaveTracks(selection: TrackSelection, applySeries: boolean): Promise<void>;
  handleOpenBulkTracks(items: readonly ScannedItem[]): void;
  handleOpenBulkMetadata(items: readonly ScannedItem[]): void;
  handleBulkInclude(itemIds: readonly ItemId[], include: boolean): Promise<void>;
  handleBulkMediaKind(itemIds: readonly ItemId[], mediaKind: MediaKind): Promise<void>;
  handleBulkCategory(itemIds: readonly ItemId[], category: OutputCategory): Promise<void>;
  handleBulkAudioNormalization(
    itemIds: readonly ItemId[],
    mode: AudioNormalizationConfig['mode']
  ): Promise<void>;
  handleApplyMetadata(
    candidate: MetadataCandidate,
    episodeOrder: EpisodeOrderMode,
    candidates?: readonly MetadataCandidate[]
  ): Promise<void>;
  handleCancelJob(): Promise<void>;
  handleDrainJob(): Promise<void>;
  handleForceUnlock(): Promise<void>;
  handleResolveVerifierConflict(entry: VerifierEntry): void;
  handleFixVerifierSelected(): Promise<void>;
  handleSaveVerifierConflicts(
    resolutions: Partial<Record<VerifierEntryId, ConflictDecision>>
  ): void;
  handleConfirmVerifierConflicts(
    resolutions: Partial<Record<VerifierEntryId, ConflictDecision>>
  ): Promise<void>;
}

/**
 * Encapsulates modal state, bulk actions, subtitle picker, and verifier conflict workflows for App.vue.
 */
export function useOrganizerWorkflow(store: WorkflowStorePort): OrganizerWorkflow {
  const inspectingItem = ref<ScannedItem | null>(null);
  const searchingItem = ref<ScannedItem | null>(null);
  const bulkSearchingItems = ref<readonly ScannedItem[] | null>(null);
  const bulkTrackItems = ref<readonly ScannedItem[] | null>(null);
  const selectedVerifierIds = ref<readonly VerifierEntryId[]>([]);
  const recalculateVerifierTags = ref(false);
  const previewingSubtitleItem = ref<ScannedItem | null>(null);
  const subtitlePicker = ref<SubtitlePickerViewState | null>(null);
  const conflictsOpen = ref(false);
  const confirmUnlockOpen = ref(false);
  const isCancellingJob = ref(false);
  const etaSimulationOpen = ref(false);
  const etaSimulationData = ref<EtaSimulationSnapshot | null>(null);
  const etaSimulationLoading = ref(false);
  const etaSimulationError = ref<string | null>(null);
  const isDrainingJob = ref(false);
  const organizerModalConflictItemId = ref<ItemId | null>(null);
  const verifierConflictResolutions = ref<Partial<Record<VerifierEntryId, ConflictDecision>>>({});
  const verifierConflictsOpen = ref(false);
  const verifierConflictEntries = ref<readonly VerifierEntry[]>([]);
  const verifierFixAfterResolve = ref(false);

  const subtitlePickerItem = computed<ScannedItem | null>(() => {
    const itemId = subtitlePicker.value?.itemId;
    if (!itemId) {
      return null;
    }
    return store.items.find((entry) => entry.id === itemId) ?? null;
  });

  const organizerModalConflicts = computed(() =>
    organizerModalConflictItemId.value
      ? store.preflightConflicts.filter((c) => c.itemId === organizerModalConflictItemId.value)
      : store.preflightConflicts
  );

  const isSingleOrganizerConflict = computed(() => organizerModalConflictItemId.value !== null);

  const includedQueueCount = computed(() => {
    let count = 0;
    for (const item of store.items) {
      if (item.include) {
        count += 1;
      }
    }
    return count;
  });

  const verifierConflictComparisons = computed<readonly ConflictComparison<VerifierEntryId>[]>(() =>
    verifierConflictEntries.value
      .map((e) => e.collisionComparison)
      .filter((c): c is ConflictComparison<VerifierEntryId> => c !== undefined)
  );

  watch(
    () => store.verifierState.entries,
    (): void => {
      verifierConflictResolutions.value = {};
      verifierConflictsOpen.value = false;
      verifierConflictEntries.value = [];
      verifierFixAfterResolve.value = false;
    }
  );

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

  function closeSearchModal(): void {
    searchingItem.value = null;
    bulkSearchingItems.value = null;
  }

  function closeTrackModal(): void {
    inspectingItem.value = null;
    bulkTrackItems.value = null;
  }

  function closePreviewModal(): void {
    previewingSubtitleItem.value = null;
  }

  function openSingleMetadataSearch(item: ScannedItem): void {
    bulkSearchingItems.value = null;
    searchingItem.value = item;
  }

  function openSingleTrackInspector(item: ScannedItem): void {
    bulkTrackItems.value = null;
    inspectingItem.value = item;
  }

  function closeOrganizerConflicts(): void {
    conflictsOpen.value = false;
    organizerModalConflictItemId.value = null;
  }

  function closeVerifierConflicts(): void {
    verifierConflictsOpen.value = false;
    verifierFixAfterResolve.value = false;
  }

  function handleTestSubtitleInPlayer(item: ScannedItem): void {
    previewingSubtitleItem.value = item;
  }

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
    void store.setConflictResolutions({
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
    void store.setConflictResolutions(next);
  }

  async function patchItemAndRefresh(itemId: ItemId, patch: ItemPatch): Promise<void> {
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
    if (bulkTrackItems.value && bulkTrackItems.value.length > 0) {
      const ids = bulkTrackItems.value.map((item) => item.id);
      await store.applyTracksToItems(ids, selection);
      bulkTrackItems.value = null;
      inspectingItem.value = null;
      await store.refreshPreflightSafely();
      return;
    }
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

  function handleOpenBulkTracks(items: readonly ScannedItem[]): void {
    if (items.length === 0) {
      return;
    }
    bulkTrackItems.value = items;
    inspectingItem.value = items[0] ?? null;
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
    mode: AudioNormalizationConfig['mode']
  ): Promise<void> {
    await store.patchItemsBulk(itemIds, {
      audioNormalization: { mode, codec: 'auto', downmixStereo: false }
    });
  }

  async function handleApplyMetadata(
    candidate: MetadataCandidate,
    episodeOrder: EpisodeOrderMode,
    candidates?: readonly MetadataCandidate[]
  ): Promise<void> {
    const metadataPatch: ItemPatch =
      candidates && candidates.length > 0
        ? { selectedMetadata: candidate, candidates, episodeOrder }
        : { selectedMetadata: candidate, episodeOrder };
    const bulkTargets = bulkSearchingItems.value;
    if (bulkTargets && bulkTargets.length > 0) {
      await store.patchItemsBulk(
        bulkTargets.map((item) => item.id),
        metadataPatch
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
    await store.patchItem(target.id, metadataPatch);
    searchingItem.value = null;
    await store.refreshPreflightSafely();
  }

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

  async function handleDrainJob(): Promise<void> {
    if (isDrainingJob.value || isCancellingJob.value) {
      return;
    }
    isDrainingJob.value = true;
    try {
      await store.drainJob();
    } finally {
      isDrainingJob.value = false;
    }
  }

  async function handleForceUnlock(): Promise<void> {
    confirmUnlockOpen.value = false;
    await store.unlock(true);
  }

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

  async function refreshEtaSimulation(): Promise<void> {
    etaSimulationLoading.value = true;
    etaSimulationError.value = null;
    try {
      etaSimulationData.value = await store.fetchEtaSimulation();
    } catch (err) {
      etaSimulationError.value = err instanceof Error ? err.message : String(err);
    } finally {
      etaSimulationLoading.value = false;
    }
  }

  async function openEtaSimulation(): Promise<void> {
    etaSimulationOpen.value = true;
    await refreshEtaSimulation();
  }

  function closeEtaSimulation(): void {
    etaSimulationOpen.value = false;
  }

  return {
    inspectingItem,
    searchingItem,
    bulkSearchingItems,
    bulkTrackItems,
    selectedVerifierIds,
    recalculateVerifierTags,
    previewingSubtitleItem,
    subtitlePicker,
    subtitlePickerItem,
    conflictsOpen,
    confirmUnlockOpen,
    isCancellingJob,
    isDrainingJob,
    organizerModalConflicts,
    isSingleOrganizerConflict,
    includedQueueCount,
    verifierConflictResolutions,
    verifierConflictsOpen,
    verifierFixAfterResolve,
    verifierConflictComparisons,
    etaSimulationOpen,
    etaSimulationData,
    etaSimulationLoading,
    etaSimulationError,
    openEtaSimulation,
    refreshEtaSimulation,
    closeEtaSimulation,
    handleSearchSubtitles,
    handleDownloadSubtitle,
    closeSubtitlePicker,
    closeSearchModal,
    closeTrackModal,
    closePreviewModal,
    openSingleMetadataSearch,
    openSingleTrackInspector,
    closeOrganizerConflicts,
    closeVerifierConflicts,
    handleTestSubtitleInPlayer,
    handleProcess,
    handleOpenOrganizerConflictModal,
    handleSaveOrganizerConflicts,
    handleResolveAllConflicts,
    patchItemAndRefresh,
    handleConfirmConflicts,
    handleSaveTracks,
    handleOpenBulkTracks,
    handleOpenBulkMetadata,
    handleBulkInclude,
    handleBulkMediaKind,
    handleBulkCategory,
    handleBulkAudioNormalization,
    handleApplyMetadata,
    handleCancelJob,
    handleDrainJob,
    handleForceUnlock,
    handleResolveVerifierConflict,
    handleFixVerifierSelected,
    handleSaveVerifierConflicts,
    handleConfirmVerifierConflicts
  };
}
