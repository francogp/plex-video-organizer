import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';

import * as v from 'valibot';

import {
  DEFAULT_AUDIO_PREFERRED_LANGUAGES,
  DEFAULT_PREFERRED_LANGUAGES,
  MAX_SERVER_LOG_ENTRIES
} from '../../domain/constants.ts';
import { extractPlexTags } from '../../domain/plexTagExtractor.ts';
import { reapplyAudioFilterToItem } from '../../domain/trackSelection.ts';
import {
  AudioLanguageCodeSchema,
  MetadataLanguageCodeSchema,
  asJobId,
  sanitizeConflictResolutions,
  type ActiveJobProgress,
  type AudioLanguageCode,
  type ClientId,
  type ConflictDecision,
  type EpisodeOrderMode,
  type EtaSimulationSnapshot,
  type ExternalSubtitleFile,
  type ItemId,
  type ItemPatch,
  type JobId,
  type JobItemError,
  type JobPhase,
  type LockErrorCode,
  type LogLevel,
  type MediaKind,
  type MetadataCandidate,
  type MetadataLanguageCode,
  type OrganizerStatePayload,
  type ScannedItem,
  type ServerInitStatus,
  type SseLogEvent,
  type SseProgressEvent,
  type SubtitleCandidate,
  type VerifierEntry,
  type VerifierEntryId,
  type VerifierState
} from '../../domain/types.ts';
import {
  buildMountPathsMap,
  resolvePortableInputPath,
  resolveServerTag,
  type AppConfig
} from '../config.ts';
import { EtaPredictor } from './etaPredictor.ts';
import { cleanupOrphanTempFiles } from './fileMover.ts';
import {
  buildIdleEtaSimulationSnapshot,
  executeMoveJob,
  selectProcessableQueueItems
} from './jobExecutionService.ts';
import { detectFfmpegVersion, probeMedia } from './media/ffmpegRunner.ts';
import { configureMetadataCache } from './metadata/metadataCache.ts';
import { runPreflightCheck, type PreflightReport } from './preflight.ts';
import { openScanCacheDb, withAppDbPathSync } from './scanCacheDb.ts';
import {
  annotateQueueItemsWithMounts,
  applyBulkPatchToItems,
  applyPatchToItem,
  attachDownloadedSubtitle,
  executeScanWorkflow,
  searchMetadataCatalog
} from './scanMetadataService.ts';
import {
  downloadSubtitleCandidateForItem,
  searchSpanishSubtitlesForItem
} from './subtitles/subtitleService.ts';
import { executeVerifierFix, executeVerifierScan } from './verifierJobService.ts';

export class LockConflictError extends Error {
  public readonly code: LockErrorCode;

  public constructor(code: LockErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export class ServerInitializingError extends Error {
  public constructor(message = 'Server is still initializing mounts and cache.') {
    super(message);
  }
}

export class InvalidPreferencesError extends Error {
  public constructor(
    message = 'Preferences must provide non-empty arrays of valid language codes.'
  ) {
    super(message);
  }
}

function parseUniqueLanguageList<
  TSchema extends v.BaseSchema<unknown, string, v.BaseIssue<unknown>>
>(raw: unknown, itemSchema: TSchema): readonly v.InferOutput<TSchema>[] {
  const result = v.safeParse(v.pipe(v.array(itemSchema), v.minLength(1)), raw);
  if (!result.success) {
    throw new InvalidPreferencesError();
  }
  return Array.from(new Set(result.output));
}

export interface SseSubscriber {
  send(event: string, data: unknown): void;
}

export class JobRunner {
  readonly #config: AppConfig;
  #initStatus: ServerInitStatus = 'initializing';
  #ffmpegVersion: string | null = null;
  #phase: JobPhase = 'IDLE';
  #revision = 0;
  #lockOwnerClientId: ClientId | null = null;
  #items: ScannedItem[] = [];
  #conflictResolutions: Partial<Record<ItemId, ConflictDecision>> = {};
  #activeJob: ActiveJobProgress | null = null;
  #activeEtaPredictor: EtaPredictor | null = null;
  #lastError: string | null = null;
  readonly #activeChildren = new Set<ChildProcess>();
  readonly #activeScanChildrenByItemId = new Map<ItemId, ChildProcess>();
  readonly #skippedScanItemIds = new Set<ItemId>();
  #cancelledByUnlock = false;
  #drainingAfterCurrent = false;
  #activeRunPromise: Promise<void> | null = null;
  readonly #recentLogs: SseLogEvent[] = [];
  readonly #subscribers = new Set<SseSubscriber>();
  #resolvedDbPath: string | null = null;
  #lastJobErrors: JobItemError[] = [];
  #queueFallbackWarned = false;
  #verifier: VerifierState = {
    scanning: false,
    fixing: false,
    summary: null,
    entries: [],
    lastFixResult: null
  };
  #preferredLanguages: readonly MetadataLanguageCode[] = [...DEFAULT_PREFERRED_LANGUAGES];
  #audioPreferredLanguages: readonly AudioLanguageCode[] = [...DEFAULT_AUDIO_PREFERRED_LANGUAGES];
  readonly #autoDownloadSubtitles: boolean;
  readonly #searchSubtitles: typeof searchSpanishSubtitlesForItem;
  readonly #downloadSubtitle: typeof downloadSubtitleCandidateForItem;
  readonly #serverTag: string;

  public constructor(
    config: AppConfig,
    options?: {
      readonly autoDownloadSubtitles?: boolean;
      readonly searchSubtitles?: typeof searchSpanishSubtitlesForItem;
      readonly downloadSubtitle?: typeof downloadSubtitleCandidateForItem;
    }
  ) {
    this.#config = config;
    this.#serverTag = resolveServerTag(config.serverId);
    this.#autoDownloadSubtitles =
      options?.autoDownloadSubtitles ?? process.env['VITEST'] !== 'true';
    this.#searchSubtitles = options?.searchSubtitles ?? searchSpanishSubtitlesForItem;
    this.#downloadSubtitle = options?.downloadSubtitle ?? downloadSubtitleCandidateForItem;
  }

  #emitFallbackWarningOnce = (warning: string): void => {
    if (!this.#queueFallbackWarned) {
      this.#queueFallbackWarned = true;
      console.warn(warning);
      this.#emitLog('warn', warning);
    }
  };

  public async init(): Promise<void> {
    await cleanupOrphanTempFiles(this.#config.inputDir, { serverTag: this.#serverTag });
    await configureMetadataCache(this.#config.configDir, this.#emitFallbackWarningOnce);

    const db = await openScanCacheDb(
      this.#config.configDir,
      undefined,
      this.#emitFallbackWarningOnce
    );
    try {
      this.#resolvedDbPath = db.dbPath;
      const savedLogs = db.loadRecentLogs(MAX_SERVER_LOG_ENTRIES);
      if (savedLogs.length > 0) {
        this.#recentLogs.splice(0, this.#recentLogs.length, ...savedLogs);
      }
      const savedQueue = db.getQueueState();
      if (savedQueue) {
        this.#revision = savedQueue.revision;
        this.#items = [...savedQueue.items];
      }
      this.#conflictResolutions = db.getConflictResolutions();
      const savedPrefs = db.getPreferences();
      if (savedPrefs?.preferredLanguages) {
        this.#preferredLanguages = parseUniqueLanguageList(
          savedPrefs.preferredLanguages,
          MetadataLanguageCodeSchema
        );
      }
      if (savedPrefs?.audioPreferredLanguages) {
        this.#audioPreferredLanguages = parseUniqueLanguageList(
          savedPrefs.audioPreferredLanguages,
          AudioLanguageCodeSchema
        );
      }
    } finally {
      db.close();
    }

    this.#ffmpegVersion = await detectFfmpegVersion();
    if (this.#items.length > 0) {
      this.#items = await annotateQueueItemsWithMounts(this.#items, this.#config);
    }
    this.#initStatus = 'ready';
    this.#emitState();
  }

  public subscribe(sub: SseSubscriber): () => void {
    this.#subscribers.add(sub);
    sub.send('state', this.getState());
    return (): void => {
      this.#subscribers.delete(sub);
    };
  }

  public getState(): OrganizerStatePayload {
    return {
      phase: this.#phase,
      initStatus: this.#initStatus,
      ffmpegVersion: this.#ffmpegVersion,
      revision: this.#revision,
      lockOwnerClientId: this.#lockOwnerClientId,
      mountPaths: buildMountPathsMap(this.#config),
      items: this.#items,
      activeJob: this.#activeJob,
      lastError: this.#lastError,
      lastJobErrors: [...this.#lastJobErrors],
      logs: [...this.#recentLogs],
      verifier: this.#verifier,
      preferredLanguages: [...this.#preferredLanguages],
      audioPreferredLanguages: [...this.#audioPreferredLanguages],
      conflictResolutions: { ...this.#conflictResolutions }
    };
  }

  /** Returns live or pre-flight ETA simulation data across all parallel slots and pending items. */
  public async getEtaSimulationSnapshot(): Promise<EtaSimulationSnapshot> {
    if (this.#activeEtaPredictor) {
      const mode = this.#phase === 'SCANNING' ? 'scanning' : 'processing';
      return this.#activeEtaPredictor.getSimulationSnapshot(mode);
    }
    return buildIdleEtaSimulationSnapshot({
      configDir: this.#config.configDir,
      serverId: this.#config.serverId,
      items: this.#items,
      conflictResolutions: this.#conflictResolutions,
      onDbFallbackWarning: this.#emitFallbackWarningOnce
    });
  }

  public async updatePreferences(input: {
    readonly preferredLanguages?: unknown;
    readonly audioPreferredLanguages?: unknown;
  }): Promise<OrganizerStatePayload> {
    const hasTitle = input.preferredLanguages !== undefined;
    const hasAudio = input.audioPreferredLanguages !== undefined;
    if (!hasTitle && !hasAudio) {
      throw new InvalidPreferencesError();
    }

    if (hasTitle) {
      this.#preferredLanguages = parseUniqueLanguageList(
        input.preferredLanguages,
        MetadataLanguageCodeSchema
      );
    }

    if (hasAudio) {
      this.#audioPreferredLanguages = parseUniqueLanguageList(
        input.audioPreferredLanguages,
        AudioLanguageCodeSchema
      );

      if (!this.#isActiveRun && this.#items.length > 0) {
        let updatedAny = false;
        this.#items = this.#items.map((item) => {
          const stem = path.basename(item.fileName, path.extname(item.fileName));
          const next = reapplyAudioFilterToItem(item, stem, this.#audioPreferredLanguages);
          if (next !== item) {
            updatedAny = true;
          }
          return next;
        });
        if (updatedAny) {
          this.#revision += 1;
          await this.#persistQueue();
        }
      }
    }

    await this.#persistPreferences();
    this.#emitState();
    return this.getState();
  }

  public clearLogs(): OrganizerStatePayload {
    this.#recentLogs.length = 0;
    this.#lastError = null;
    this.#lastJobErrors = [];
    this.#withLogDb((db) => {
      db.clearLogs();
    });
    this.#emitState();
    return this.getState();
  }

  #withLogDb(fn: Parameters<typeof withAppDbPathSync>[1]): void {
    if (!this.#resolvedDbPath) {
      return;
    }
    try {
      withAppDbPathSync(this.#resolvedDbPath, fn);
    } catch {
      // Keep in-memory & SSE log delivery resilient if SQLite write fails
    }
  }

  #emitState(): void {
    const state = this.getState();
    for (const sub of this.#subscribers) {
      sub.send('state', state);
    }
  }

  #emitProgress(evt: SseProgressEvent): void {
    for (const sub of this.#subscribers) {
      sub.send('progress', evt);
    }
  }

  #updateProgress(evt: SseProgressEvent): void {
    this.#activeJob = {
      jobId: evt.jobId,
      totalItems: evt.totalItems ?? this.#activeJob?.totalItems ?? 0,
      completedItems: evt.completedItems ?? this.#activeJob?.completedItems ?? 0,
      activeTasks: evt.activeTasks,
      currentPercent: evt.percent,
      stage: evt.stage,
      stageLabel: evt.stageLabel,
      etaSeconds: evt.etaSeconds,
      etaState: evt.etaState,
      drainRequested: evt.drainRequested ?? this.#activeJob?.drainRequested
    };
    this.#emitProgress(evt);
  }

  #emitLog(level: LogLevel, message: string): void {
    const evt: SseLogEvent = { level, message, timestamp: Temporal.Now.instant().toString() };
    this.#recentLogs.push(evt);
    if (this.#recentLogs.length > MAX_SERVER_LOG_ENTRIES) {
      this.#recentLogs.shift();
    }
    this.#withLogDb((db) => {
      db.appendLog(evt, MAX_SERVER_LOG_ENTRIES);
    });
    for (const sub of this.#subscribers) {
      sub.send('log', evt);
    }
  }

  async #persistQueue(): Promise<void> {
    const db = await openScanCacheDb(
      this.#config.configDir,
      undefined,
      this.#emitFallbackWarningOnce,
      true
    );
    try {
      db.saveQueueState(this.#revision, this.#items);
    } finally {
      db.close();
    }
  }

  async #persistPreferences(): Promise<void> {
    const db = await openScanCacheDb(
      this.#config.configDir,
      undefined,
      this.#emitFallbackWarningOnce,
      true
    );
    try {
      db.savePreferences({
        preferredLanguages: this.#preferredLanguages,
        audioPreferredLanguages: this.#audioPreferredLanguages
      });
    } finally {
      db.close();
    }
  }

  async #persistConflictResolutions(): Promise<void> {
    const db = await openScanCacheDb(
      this.#config.configDir,
      undefined,
      this.#emitFallbackWarningOnce,
      true
    );
    try {
      db.saveConflictResolutions(this.#conflictResolutions);
    } finally {
      db.close();
    }
  }

  public async updateConflictResolutions(
    clientId: ClientId,
    revision: number,
    resolutions: Readonly<Partial<Record<ItemId, ConflictDecision>>>
  ): Promise<OrganizerStatePayload> {
    this.#assertInitialized();
    this.#assertLockOwner(clientId);
    this.#assertIdleRevision(revision);

    this.#conflictResolutions = sanitizeConflictResolutions(resolutions);
    this.#revision += 1;
    await this.#persistConflictResolutions();
    this.#emitState();
    return this.getState();
  }

  async #pruneConflictResolutionsToCurrentItems(): Promise<void> {
    const validIds = new Set<string>(this.#items.map((item) => item.id));
    const filtered: Record<string, unknown> = {};
    let changed = false;
    for (const [id, decision] of Object.entries(this.#conflictResolutions)) {
      if (validIds.has(id)) {
        filtered[id] = decision;
      } else {
        changed = true;
      }
    }
    const sanitized = sanitizeConflictResolutions(filtered);
    if (
      changed ||
      Object.keys(sanitized).length !== Object.keys(this.#conflictResolutions).length
    ) {
      this.#conflictResolutions = sanitized;
      await this.#persistConflictResolutions();
    }
  }

  async #finalizeMovedItems(movedItems: readonly ScannedItem[]): Promise<void> {
    this.#removeMovedItems(movedItems);
    await this.#pruneConflictResolutionsToCurrentItems();
    this.#revision += 1;
    await this.#persistQueue();
    this.#emitState();
  }

  get #isActiveRun(): boolean {
    return this.#phase === 'SCANNING' || this.#phase === 'PROCESSING' || this.#activeJob !== null;
  }

  #assertNoActiveJob(): void {
    if (this.#isActiveRun) {
      throw new LockConflictError(
        'JOB_IN_PROGRESS',
        `Operation already in progress (${this.#phase})`
      );
    }
  }

  #assertVerifierIdle(): void {
    if (this.#verifier.scanning || this.#verifier.fixing) {
      throw new LockConflictError('JOB_IN_PROGRESS', 'Library verifier is already running.');
    }
  }

  #assertIdleRevision(revision: number): void {
    this.#assertNoActiveJob();
    this.#assertVerifierIdle();
    this.#assertRevision(revision);
  }

  #assertLockOwner(clientId: ClientId): void {
    if (this.#lockOwnerClientId !== null && this.#lockOwnerClientId !== clientId) {
      throw new LockConflictError(
        'LOCK_HELD',
        `Queue is locked by client ${this.#lockOwnerClientId}`
      );
    }
  }

  #assertRevision(expectedRevision: number): void {
    if (expectedRevision !== this.#revision) {
      throw new LockConflictError(
        'STALE_REVISION',
        `Stale revision ${String(expectedRevision)}; current is ${String(this.#revision)}`
      );
    }
  }

  #trackActiveRun(runPromise: Promise<void>): void {
    const tracked = runPromise.finally(() => {
      if (this.#activeRunPromise === tracked) {
        this.#activeRunPromise = null;
      }
    });
    this.#activeRunPromise = tracked;
  }

  #removeMovedItems(movedItems: readonly ScannedItem[]): void {
    if (movedItems.length === 0) {
      return;
    }
    const movedIds = new Set(movedItems.map((m) => m.id));
    this.#items = this.#items.filter((item): boolean => !movedIds.has(item.id));
  }

  #assertInitialized(): void {
    if (this.#initStatus !== 'ready') {
      throw new ServerInitializingError();
    }
  }

  public skipScanItem(clientId: ClientId, itemId: ItemId): boolean {
    this.#assertInitialized();
    this.#assertLockOwner(clientId);
    if (this.#phase !== 'SCANNING') {
      return false;
    }
    this.#skippedScanItemIds.add(itemId);
    this.#activeEtaPredictor?.skipTask(`volumedetect:${itemId}`);
    const activeTask = this.#activeJob?.activeTasks.find((t) => t.itemId === itemId);
    const label = activeTask?.fileName ?? itemId;
    const child = this.#activeScanChildrenByItemId.get(itemId);
    if (child) {
      this.#activeScanChildrenByItemId.delete(itemId);
      try {
        if (!child.kill('SIGKILL')) {
          child.kill();
        }
      } catch {
        // Child may have already exited before kill.
      }
    }
    this.#emitLog('warn', `Skipped audio analysis for "${label}" by user request.`);
    return true;
  }

  public startScan(clientId: ClientId): number {
    this.#assertInitialized();
    this.#assertLockOwner(clientId);
    this.#assertNoActiveJob();
    this.#assertVerifierIdle();
    this.#lockOwnerClientId = clientId;
    this.#cancelledByUnlock = false;
    this.#drainingAfterCurrent = false;
    this.#skippedScanItemIds.clear();
    this.#activeScanChildrenByItemId.clear();
    this.#phase = 'SCANNING';
    this.#lastError = null;
    this.#activeJob = {
      jobId: asJobId('scan'),
      totalItems: 0,
      completedItems: 0,
      activeTasks: [],
      currentPercent: 0,
      etaState: 'calibrating'
    };
    this.#revision += 1;
    this.#emitState();

    this.#trackActiveRun(this.#executeScan());
    return this.#revision;
  }

  async #createEtaPredictorSession(): Promise<{
    readonly etaPredictor: EtaPredictor;
    readonly dispose: () => void;
  }> {
    const db = await openScanCacheDb(
      this.#config.configDir,
      undefined,
      this.#emitFallbackWarningOnce
    );
    const etaPredictor = new EtaPredictor({ db, serverId: this.#config.serverId });
    return {
      etaPredictor,
      dispose: () => {
        etaPredictor.flush();
        db.close();
      }
    };
  }

  #preserveAudioNormalizationOnRescan(
    items: readonly ScannedItem[],
    previousByPath: ReadonlyMap<string, ScannedItem>
  ): ScannedItem[] {
    return items.map((item) => {
      const prev = previousByPath.get(item.sourcePath);
      const savedNorm = prev?.trackSelection.audioNormalization;
      if (!prev || prev.probe.sizeBytes !== item.probe.sizeBytes || !savedNorm) {
        return item;
      }
      const updatedTrackSelection = { ...item.trackSelection, audioNormalization: savedNorm };
      const baseNoExt = path.basename(item.fileName, path.extname(item.fileName));
      const tags = extractPlexTags(baseNoExt, item.probe, {
        trackSelection: updatedTrackSelection
      });
      return { ...item, trackSelection: updatedTrackSelection, tags };
    });
  }

  async #executeScan(): Promise<void> {
    const scanJobId = asJobId('scan');
    const previousByPath = new Map(this.#items.map((item) => [item.sourcePath, item]));
    const session = await this.#createEtaPredictorSession();
    this.#activeEtaPredictor = session.etaPredictor;
    try {
      await executeScanWorkflow({
        config: this.#config,
        preferredLanguages: this.#preferredLanguages,
        audioPreferredLanguages: this.#audioPreferredLanguages,
        autoDownloadSubtitles: this.#autoDownloadSubtitles,
        etaPredictor: session.etaPredictor,
        isCancelled: () => this.#cancelledByUnlock,
        isItemSkipped: (itemId) => this.#skippedScanItemIds.has(itemId),
        createChildTracker: () => this.#createChildTracker(),
        createScanChildTracker: (itemId) => this.#createScanChildTracker(itemId),
        searchSubtitles: this.#searchSubtitles,
        downloadSubtitle: this.#downloadSubtitle,
        onLog: (level, message) => {
          this.#emitLog(level, message);
        },
        onProgress: (progress) => {
          this.#updateProgress(progress);
        },
        onInitMetadataStage: (totalItems) => {
          this.#activeJob = {
            jobId: scanJobId,
            totalItems,
            completedItems: 0,
            activeTasks: [],
            currentPercent: 0,
            stage: 'scanning',
            stageLabel: `Fetching metadata (0/${String(totalItems)})`
          };
          this.#emitState();
        },
        onCancelledItems: (items) => {
          this.#items = this.#preserveAudioNormalizationOnRescan(items, previousByPath);
        },
        onCompleted: async (withSubtitles) => {
          this.#activeJob = null;
          this.#lastError = null;
          this.#items = this.#preserveAudioNormalizationOnRescan(withSubtitles, previousByPath);
          await this.#pruneConflictResolutionsToCurrentItems();
          this.#phase = withSubtitles.length > 0 ? 'READY' : 'IDLE';
          if (withSubtitles.length === 0) {
            this.#lockOwnerClientId = null;
          }
          this.#revision += 1;
          await this.#persistQueue();
          this.#emitLog(
            'info',
            `Scan completed: ${String(withSubtitles.length)} media file(s) found.`
          );
          this.#emitState();
        },
        onError: (msg) => {
          this.#activeJob = null;
          this.#lastError = msg;
          this.#phase = 'ERROR';
          this.#revision += 1;
          this.#emitLog('error', `Scan failed: ${msg}`);
          this.#emitState();
        }
      });
    } finally {
      if (this.#activeEtaPredictor === session.etaPredictor) {
        this.#activeEtaPredictor = null;
      }
      session.dispose();
    }
  }

  #requireItem(itemId: ItemId): ScannedItem {
    this.#assertInitialized();
    const item = this.#items.find((entry) => entry.id === itemId);
    if (!item) {
      throw new Error(`Item not found: ${itemId}`);
    }
    return item;
  }

  public async getItemPreviewStreamInfo(itemId: ItemId): Promise<{
    readonly sourcePath: string;
    readonly audioStreamOrder?: number;
  }> {
    const item = this.#requireItem(itemId);
    const preferredAudio = item.trackSelection.audioTracks.find((track) => track.include);
    return {
      sourcePath: await resolvePortableInputPath(this.#config, item.sourcePath, item.relativePath),
      audioStreamOrder: preferredAudio?.streamOrder
    };
  }

  public async getItemPreviewSubtitlePath(itemId: ItemId): Promise<string | undefined> {
    const item = this.#requireItem(itemId);
    const spaSub =
      item.externalSubtitles.find((sub) => sub.language === 'spa' && Boolean(sub.downloadedFrom)) ??
      item.externalSubtitles.find((sub) => sub.language === 'spa') ??
      item.externalSubtitles[0];
    if (!spaSub) {
      return undefined;
    }
    return resolvePortableInputPath(this.#config, spaSub.path, spaSub.relativePath);
  }

  public async searchItemSubtitles(itemId: ItemId): Promise<readonly SubtitleCandidate[]> {
    const item = this.#requireItem(itemId);
    return this.#searchSubtitles(item, this.#config, undefined, (level, msg) =>
      this.#emitLog(level, msg)
    );
  }

  #requireIdleItemIndex(revision: number, itemId: ItemId): number {
    this.#assertIdleRevision(revision);
    const targetIdx = this.#items.findIndex((entry): boolean => entry.id === itemId);
    if (targetIdx < 0) {
      throw new Error(`Item not found: ${itemId}`);
    }
    return targetIdx;
  }

  public async downloadItemSubtitle(
    clientId: ClientId,
    revision: number,
    itemId: ItemId,
    candidate?: SubtitleCandidate
  ): Promise<{ readonly state: OrganizerStatePayload; readonly downloaded: ExternalSubtitleFile }> {
    this.#assertInitialized();
    this.#assertLockOwner(clientId);
    const idx = this.#requireIdleItemIndex(revision, itemId);
    const item = this.#items[idx]!;
    let chosen = candidate;
    if (!chosen) {
      const candidates = await this.#searchSubtitles(item, this.#config, undefined, (level, msg) =>
        this.#emitLog(level, msg)
      );
      chosen = candidates[0];
    }
    if (!chosen) {
      const targetIdx = this.#requireIdleItemIndex(revision, itemId);
      this.#items[targetIdx] = {
        ...this.#items[targetIdx]!,
        subtitleStatus: { status: 'not_found' }
      };
      this.#revision += 1;
      await this.#persistQueue();
      this.#emitState();
      throw new Error('No Spanish subtitles found across configured providers.');
    }

    this.#requireIdleItemIndex(revision, itemId);
    const downloaded = await this.#downloadSubtitle(item, chosen, this.#config);
    const targetIdx = this.#requireIdleItemIndex(revision, itemId);
    this.#items[targetIdx] = attachDownloadedSubtitle(this.#items[targetIdx]!, downloaded, chosen);
    this.#revision += 1;
    await this.#persistQueue();
    this.#emitLog(
      'info',
      `Downloaded spa subtitle for ${item.fileName} (${chosen.provider}, ${chosen.variant})`
    );
    this.#emitState();
    return { state: this.getState(), downloaded };
  }

  public async patchItem(
    clientId: ClientId,
    revision: number,
    itemId: ItemId,
    patch: ItemPatch
  ): Promise<OrganizerStatePayload> {
    this.#assertInitialized();
    this.#assertLockOwner(clientId);
    const idx = this.#requireIdleItemIndex(revision, itemId);

    const updatedItem = await applyPatchToItem(this.#items[idx]!, patch, this.#config.tvdbApiKey);
    const targetIdx = this.#requireIdleItemIndex(revision, itemId);
    this.#items[targetIdx] = updatedItem;

    if (this.#phase === 'PREFLIGHT_BLOCKED') {
      this.#phase = 'READY';
    }
    this.#revision += 1;
    await this.#persistQueue();
    this.#emitState();
    return this.getState();
  }

  public async patchItemsBulk(
    clientId: ClientId,
    revision: number,
    itemIds: readonly ItemId[],
    patch: ItemPatch
  ): Promise<OrganizerStatePayload> {
    this.#assertInitialized();
    this.#assertLockOwner(clientId);
    this.#assertIdleRevision(revision);

    const { nextItems, updatedCount } = await applyBulkPatchToItems(
      this.#items,
      itemIds,
      patch,
      this.#config.tvdbApiKey,
      this.#preferredLanguages
    );
    this.#assertIdleRevision(revision);

    this.#items = nextItems;
    if (this.#phase === 'PREFLIGHT_BLOCKED') {
      this.#phase = 'READY';
    }
    this.#revision += 1;
    await this.#persistQueue();
    this.#emitLog('info', `Updated ${String(updatedCount)} queue item(s) in bulk.`);
    this.#emitState();
    return this.getState();
  }

  public async searchMetadata(
    clientId: ClientId,
    params: {
      readonly query: string;
      readonly year?: number;
      readonly kind: MediaKind;
      readonly imdbId?: string;
      readonly tvdbId?: string;
      readonly episodeOrder?: EpisodeOrderMode;
    }
  ): Promise<readonly MetadataCandidate[]> {
    this.#assertLockOwner(clientId);
    return searchMetadataCatalog(this.#config, this.#preferredLanguages, params);
  }

  public async preflight(
    clientId: ClientId,
    revision: number
  ): Promise<PreflightReport & { readonly revision: number }> {
    this.#assertInitialized();
    this.#assertLockOwner(clientId);
    this.#assertIdleRevision(revision);

    const mountPaths = buildMountPathsMap(this.#config);
    const report = await runPreflightCheck(this.#items, mountPaths, probeMedia);
    this.#assertIdleRevision(revision);

    this.#items = this.#items.map((item) => ({
      ...item,
      projectedDestination: report.projectedByItemId[item.id] ?? item.projectedDestination
    }));

    this.#phase = report.ok ? 'READY' : 'PREFLIGHT_BLOCKED';
    this.#revision += 1;
    await this.#persistQueue();
    this.#emitState();
    return { ...report, revision: this.#revision };
  }

  public async startJob(
    clientId: ClientId,
    revision: number,
    conflictResolutions: Readonly<Partial<Record<ItemId, ConflictDecision>>>
  ): Promise<{ readonly jobId: JobId; readonly revision: number }> {
    this.#assertInitialized();
    this.#assertLockOwner(clientId);
    this.#assertIdleRevision(revision);

    for (const item of this.#items) {
      if (
        item.include &&
        (!item.selectedMetadata?.title.trim() || item.trackSelection.needsUserPrompt)
      ) {
        throw new Error(`Unresolved metadata or track prompt for ${item.fileName}`);
      }
    }

    const mountPaths = buildMountPathsMap(this.#config);
    const report = await runPreflightCheck(this.#items, mountPaths, probeMedia);
    this.#assertIdleRevision(revision);
    const existingCollisionByItemId: Partial<Record<ItemId, string>> = {};
    for (const conflict of report.conflicts) {
      if (!Object.hasOwn(conflictResolutions, conflict.itemId)) {
        throw new Error(`Unresolved conflict for item ${conflict.itemId}`);
      }
      if (conflict.existingPath) {
        existingCollisionByItemId[conflict.itemId] = conflict.existingPath;
      }
    }

    const jobId = asJobId(crypto.randomUUID().slice(0, 8));
    this.#lockOwnerClientId = clientId;
    this.#cancelledByUnlock = false;
    this.#phase = 'PROCESSING';
    this.#drainingAfterCurrent = false;
    this.#revision += 1;

    const toProcess = selectProcessableQueueItems(this.#items, conflictResolutions);
    this.#activeJob = {
      jobId,
      totalItems: toProcess.length,
      completedItems: 0,
      activeTasks: [],
      currentPercent: 0,
      etaState: 'calibrating'
    };
    this.#emitState();

    this.#trackActiveRun(
      this.#executeJob(
        jobId,
        toProcess,
        report.projectedByItemId,
        conflictResolutions,
        existingCollisionByItemId
      )
    );
    return { jobId, revision: this.#revision };
  }

  #createChildTracker(): (child: ChildProcess | null) => void {
    let tracked: ChildProcess | null = null;
    return (child): void => {
      if (tracked && tracked !== child) {
        this.#activeChildren.delete(tracked);
      }
      tracked = child;
      if (child) {
        this.#activeChildren.add(child);
      }
    };
  }

  #createScanChildTracker(itemId: ItemId): (child: ChildProcess | null) => void {
    const baseTracker = this.#createChildTracker();
    return (child): void => {
      baseTracker(child);
      if (child) {
        this.#activeScanChildrenByItemId.set(itemId, child);
      } else {
        this.#activeScanChildrenByItemId.delete(itemId);
      }
    };
  }

  async #executeJob(
    jobId: JobId,
    toProcess: readonly ScannedItem[],
    projectedByItemId: Readonly<Partial<Record<ItemId, string>>>,
    conflictResolutions: Readonly<Partial<Record<ItemId, ConflictDecision>>>,
    existingCollisionByItemId: Readonly<Partial<Record<ItemId, string>>>
  ): Promise<void> {
    const session = await this.#createEtaPredictorSession();
    this.#activeEtaPredictor = session.etaPredictor;
    this.#lastJobErrors = [];
    this.#lastError = null;
    try {
      await executeMoveJob({
        config: this.#config,
        jobId,
        toProcess,
        projectedByItemId,
        conflictResolutions,
        existingCollisionByItemId,
        etaPredictor: session.etaPredictor,
        isCancelled: () => this.#cancelledByUnlock,
        isDraining: () => this.#drainingAfterCurrent,
        createChildTracker: () => this.#createChildTracker(),
        onLog: (level, message) => {
          this.#emitLog(level, message);
        },
        onProgress: (progress) => {
          this.#updateProgress(progress);
        },
        onFinalizeMovedItems: async (movedItems) => {
          await this.#finalizeMovedItems(movedItems);
        },
        onComplete: async (movedCount, attemptErrors) => {
          const wasDraining = this.#drainingAfterCurrent;
          this.#drainingAfterCurrent = false;
          this.#activeJob = null;
          this.#lastJobErrors = [...attemptErrors];
          const finalFailedCount = attemptErrors.filter((entry) => entry.attempt === 2).length;
          const remaining = this.#items.length;
          if (finalFailedCount > 0 && movedCount === 0 && !wasDraining) {
            this.#phase = 'ERROR';
            this.#lastError = `${String(finalFailedCount)} item(s) failed after retry. Check Server Logs.`;
          } else if (finalFailedCount > 0) {
            this.#phase = 'READY';
            this.#lastError = `${String(movedCount)} organized, ${String(finalFailedCount)} failed after retry. Check Server Logs.`;
          } else {
            this.#phase = wasDraining && remaining > 0 ? 'READY' : 'IDLE';
          }
          if (this.#phase === 'IDLE') {
            this.#lockOwnerClientId = null;
          }
          this.#revision += 1;
          await this.#persistQueue();
          const failedSummary =
            finalFailedCount > 0 ? `, ${String(finalFailedCount)} failed after retry` : '';
          this.#emitLog(
            finalFailedCount > 0 ? 'warn' : 'info',
            wasDraining
              ? `Job ${jobId} stopped after current tasks: ${String(movedCount)} file(s) organized${failedSummary}, ${String(remaining)} remaining in queue.`
              : `Job ${jobId} completed: ${String(movedCount)} file(s) organized${failedSummary}.`
          );
          this.#emitState();
        },
        onError: async (msg) => {
          this.#drainingAfterCurrent = false;
          this.#phase = 'ERROR';
          this.#activeJob = null;
          this.#revision += 1;
          await cleanupOrphanTempFiles(this.#config.inputDir, {
            serverTag: this.#serverTag,
            jobId
          });
          this.#emitLog('error', `Job ${jobId} failed: ${msg}`);
          this.#emitState();
        }
      });
    } finally {
      this.#drainingAfterCurrent = false;
      if (this.#activeEtaPredictor === session.etaPredictor) {
        this.#activeEtaPredictor = null;
      }
      session.dispose();
    }
  }

  public requestDrain(clientId: ClientId): OrganizerStatePayload {
    this.#assertInitialized();
    this.#assertLockOwner(clientId);
    if (!this.#activeJob || this.#activeJob.jobId === 'scan') {
      return this.getState();
    }
    if (!this.#drainingAfterCurrent) {
      this.#drainingAfterCurrent = true;
      this.#activeJob = { ...this.#activeJob, drainRequested: true };
      this.#emitLog('warn', 'Drain requested: finishing active tasks and stopping job...');
      this.#emitState();
    }
    return this.getState();
  }

  public async unlock(clientId: ClientId, force: boolean): Promise<OrganizerStatePayload> {
    if (!force) {
      this.#assertLockOwner(clientId);
    }
    const wasRunning = this.#isActiveRun;
    const activeJobId = this.#activeJob?.jobId;
    this.#cancelledByUnlock = true;
    this.#drainingAfterCurrent = false;
    for (const child of this.#activeChildren) {
      child.kill('SIGKILL');
    }
    this.#activeChildren.clear();
    if (this.#activeRunPromise) {
      await this.#activeRunPromise;
    }
    this.#activeEtaPredictor?.flush();
    await cleanupOrphanTempFiles(this.#config.inputDir, {
      serverTag: this.#serverTag,
      jobId: activeJobId && activeJobId !== 'scan' ? activeJobId : undefined
    });
    this.#lockOwnerClientId = null;
    this.#activeJob = null;
    this.#phase = wasRunning && this.#items.length > 0 ? 'READY' : 'IDLE';
    this.#revision += 1;
    await this.#persistQueue();
    const actionLog =
      wasRunning && !force
        ? `Job cancelled by ${clientId}.`
        : `Session unlocked${force ? ' (forced)' : ''} by ${clientId}.`;
    this.#emitLog('warn', actionLog);
    this.#emitState();
    return this.getState();
  }

  public startVerifierScan(clientId: ClientId, recalculateTags = false): number {
    this.#assertInitialized();
    this.#assertLockOwner(clientId);
    this.#assertNoActiveJob();
    this.#assertVerifierIdle();
    this.#verifier = {
      ...this.#verifier,
      scanning: true,
      progress: {
        completed: 0,
        total: 0,
        percent: 0,
        stageLabel: 'Discovering libraries...',
        activeTasks: [],
        etaState: 'calibrating'
      },
      lastFixResult: null
    };
    this.#revision += 1;
    this.#emitLog(
      'info',
      recalculateTags
        ? 'Starting Plex naming compliance scan with FFprobe tag recalculation...'
        : 'Starting Plex naming compliance scan across all libraries...'
    );
    this.#emitState();
    void this.#runVerifierScan(recalculateTags);
    return this.#revision;
  }

  async #withVerifierSession(
    operation: 'scan' | 'fix',
    run: (ctx: {
      readonly etaPredictor: EtaPredictor;
      readonly onLog: (level: LogLevel, message: string) => void;
      readonly onProgress: (progress: NonNullable<VerifierState['progress']>) => void;
      readonly onError: (msg: string) => void;
    }) => Promise<void>
  ): Promise<void> {
    const session = await this.#createEtaPredictorSession();
    const VERIFIER_PROGRESS_THROTTLE_MS = 150;
    let lastProgressEmitAt = 0;
    let lastStageLabel = '';
    try {
      await run({
        etaPredictor: session.etaPredictor,
        onLog: (level, message): void => {
          this.#emitLog(level, message);
        },
        onProgress: (progress): void => {
          this.#verifier = { ...this.#verifier, progress };
          const now = performance.now();
          const stageChanged = progress.stageLabel !== lastStageLabel;
          const isComplete = progress.total > 0 && progress.completed >= progress.total;
          if (
            stageChanged ||
            isComplete ||
            now - lastProgressEmitAt >= VERIFIER_PROGRESS_THROTTLE_MS
          ) {
            lastProgressEmitAt = now;
            lastStageLabel = progress.stageLabel;
            this.#emitState();
          }
        },
        onError: (msg): void => {
          this.#failVerifierOperation(operation, msg);
        }
      });
    } finally {
      session.dispose();
    }
  }

  async #runVerifierScan(recalculateTags = false): Promise<void> {
    await this.#withVerifierSession('scan', (ctx) =>
      executeVerifierScan({
        config: this.#config,
        preferredLanguages: this.#preferredLanguages,
        recalculateTags,
        ...ctx,
        onComplete: (nextState, issueCount, roots, files): void => {
          this.#verifier = nextState;
          this.#revision += 1;
          this.#emitLog(
            'info',
            `Verifier scan complete: ${String(issueCount)} issue(s) across ${String(roots)} folder(s) and ${String(files)} file(s).`
          );
          this.#emitState();
        }
      })
    );
  }

  public startVerifierFix(
    clientId: ClientId,
    entryIds: readonly VerifierEntryId[],
    conflictResolutions?: Readonly<Partial<Record<VerifierEntryId, ConflictDecision>>>
  ): number {
    this.#assertInitialized();
    this.#assertLockOwner(clientId);
    this.#assertNoActiveJob();
    this.#assertVerifierIdle();
    const idSet = new Set(entryIds);
    const selected = this.#verifier.entries.filter((entry): boolean => idSet.has(entry.id));
    if (selected.length === 0) {
      throw new Error('No matching verifier entries selected.');
    }
    this.#verifier = {
      ...this.#verifier,
      fixing: true,
      progress: {
        completed: 0,
        total: selected.length,
        percent: 0,
        stageLabel: 'Applying bottom-up renames...',
        activeTasks: [],
        etaState: 'calibrating'
      },
      lastFixResult: null
    };
    this.#revision += 1;
    this.#emitLog(
      'info',
      `Applying bottom-up Plex renames for ${String(selected.length)} selected item(s)...`
    );
    this.#emitState();
    void this.#runVerifierFix(selected, conflictResolutions);
    return this.#revision;
  }

  async #runVerifierFix(
    selected: readonly VerifierEntry[],
    conflictResolutions?: Readonly<Partial<Record<VerifierEntryId, ConflictDecision>>>
  ): Promise<void> {
    await this.#withVerifierSession('fix', (ctx) =>
      executeVerifierFix({
        config: this.#config,
        preferredLanguages: this.#preferredLanguages,
        selected,
        conflictResolutions,
        ...ctx,
        onComplete: (nextState): void => {
          this.#verifier = nextState;
          this.#revision += 1;
          this.#emitState();
        }
      })
    );
  }

  #failVerifierOperation(operation: 'scan' | 'fix', err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.#verifier = {
      ...this.#verifier,
      scanning: false,
      fixing: false,
      progress: null,
      lastFixResult: { renamedFiles: 0, renamedDirs: 0, errors: [msg] }
    };
    this.#revision += 1;
    this.#emitLog('error', `Verifier ${operation} failed: ${msg}`);
    this.#emitState();
  }
}
