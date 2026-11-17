import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';

import * as v from 'valibot';

import {
  DEFAULT_AUDIO_PREFERRED_LANGUAGES,
  DEFAULT_PREFERRED_LANGUAGES
} from '../../domain/constants.ts';
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
  type ExternalSubtitleFile,
  type ItemId,
  type ItemPatch,
  type JobId,
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
import { buildMountPathsMap, resolvePortableInputPath, type AppConfig } from '../config.ts';
import { EtaPredictor } from './etaPredictor.ts';
import { cleanupOrphanTempFiles } from './fileMover.ts';
import { executeMoveJob } from './jobExecutionService.ts';
import { probeMedia } from './media/ffmpegRunner.ts';
import { configureMetadataCache } from './metadata/metadataCache.ts';
import { runPreflightCheck, type PreflightReport } from './preflight.ts';
import { openScanCacheDb } from './scanCacheDb.ts';
import {
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

const MAX_RECENT_LOGS = 100;

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

  public constructor(
    config: AppConfig,
    options?: {
      readonly autoDownloadSubtitles?: boolean;
      readonly searchSubtitles?: typeof searchSpanishSubtitlesForItem;
      readonly downloadSubtitle?: typeof downloadSubtitleCandidateForItem;
    }
  ) {
    this.#config = config;
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
    await cleanupOrphanTempFiles(this.#config.inputDir);
    await configureMetadataCache(this.#config.configDir, this.#emitFallbackWarningOnce);

    const db = await openScanCacheDb(
      this.#config.configDir,
      undefined,
      this.#emitFallbackWarningOnce
    );
    try {
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
      revision: this.#revision,
      lockOwnerClientId: this.#lockOwnerClientId,
      mountPaths: buildMountPathsMap(this.#config),
      items: this.#items,
      activeJob: this.#activeJob,
      lastError: this.#lastError,
      logs: [...this.#recentLogs],
      verifier: this.#verifier,
      preferredLanguages: [...this.#preferredLanguages],
      audioPreferredLanguages: [...this.#audioPreferredLanguages],
      conflictResolutions: { ...this.#conflictResolutions }
    };
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

      if (this.#items.length > 0) {
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
    this.#emitState();
    return this.getState();
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
    if (this.#recentLogs.length > MAX_RECENT_LOGS) {
      this.#recentLogs.shift();
    }
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
    this.#assertRevision(revision);

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
    if (this.#phase === 'SCANNING' || this.#phase === 'PROCESSING') {
      throw new LockConflictError('LOCK_HELD', `Operation already in progress (${this.#phase})`);
    }
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

  async #executeScan(): Promise<void> {
    const scanJobId = asJobId('scan');
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
          this.#items = [...items];
        },
        onCompleted: async (withSubtitles) => {
          this.#activeJob = null;
          this.#lastError = null;
          this.#items = [...withSubtitles];
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

  public async downloadItemSubtitle(
    clientId: ClientId,
    revision: number,
    itemId: ItemId,
    candidate?: SubtitleCandidate
  ): Promise<{ readonly state: OrganizerStatePayload; readonly downloaded: ExternalSubtitleFile }> {
    this.#assertInitialized();
    this.#assertLockOwner(clientId);
    this.#assertRevision(revision);

    const idx = this.#items.findIndex((entry) => entry.id === itemId);
    if (idx < 0) {
      throw new Error(`Item not found: ${itemId}`);
    }
    const item = this.#items[idx]!;
    let chosen = candidate;
    if (!chosen) {
      const candidates = await this.#searchSubtitles(item, this.#config, undefined, (level, msg) =>
        this.#emitLog(level, msg)
      );
      chosen = candidates[0];
    }
    if (!chosen) {
      this.#items[idx] = { ...item, subtitleStatus: { status: 'not_found' } };
      this.#revision += 1;
      await this.#persistQueue();
      this.#emitState();
      throw new Error('No Spanish subtitles found across configured providers.');
    }

    const downloaded = await this.#downloadSubtitle(item, chosen, this.#config);
    this.#items[idx] = attachDownloadedSubtitle(item, downloaded, chosen);
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
    this.#assertRevision(revision);

    const idx = this.#items.findIndex((i): boolean => i.id === itemId);
    if (idx < 0) {
      throw new Error(`Item not found: ${itemId}`);
    }

    this.#items[idx] = await applyPatchToItem(this.#items[idx]!, patch, this.#config.tvdbApiKey);

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
    this.#assertRevision(revision);

    const { nextItems, updatedCount } = await applyBulkPatchToItems(
      this.#items,
      itemIds,
      patch,
      this.#config.tvdbApiKey,
      this.#preferredLanguages
    );

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
    this.#assertRevision(revision);

    const mountPaths = buildMountPathsMap(this.#config);
    const report = await runPreflightCheck(this.#items, mountPaths, probeMedia);

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
    this.#assertRevision(revision);

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
    this.#cancelledByUnlock = false;
    this.#phase = 'PROCESSING';
    this.#drainingAfterCurrent = false;
    this.#revision += 1;

    const toProcess = this.#items.filter(
      (item) => item.include && conflictResolutions[item.id] !== 'ignore'
    );
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
        onComplete: async (movedCount) => {
          const wasDraining = this.#drainingAfterCurrent;
          this.#drainingAfterCurrent = false;
          this.#activeJob = null;
          const remaining = this.#items.length;
          this.#phase = wasDraining && remaining > 0 ? 'READY' : 'IDLE';
          if (this.#phase === 'IDLE') {
            this.#lockOwnerClientId = null;
          }
          this.#revision += 1;
          await this.#persistQueue();
          this.#emitLog(
            'info',
            wasDraining
              ? `Job ${jobId} stopped after current tasks: ${String(movedCount)} file(s) organized, ${String(remaining)} remaining in queue.`
              : `Job ${jobId} completed: ${String(movedCount)} file(s) organized.`
          );
          this.#emitState();
        },
        onError: async (msg) => {
          this.#drainingAfterCurrent = false;
          this.#phase = 'ERROR';
          this.#activeJob = null;
          this.#revision += 1;
          await cleanupOrphanTempFiles(this.#config.inputDir);
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
    if (this.#phase !== 'PROCESSING' || !this.#activeJob) {
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
    const wasRunning = this.#phase === 'SCANNING' || this.#phase === 'PROCESSING';
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
    await cleanupOrphanTempFiles(this.#config.inputDir);
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
    if (this.#verifier.scanning || this.#verifier.fixing) {
      throw new LockConflictError('LOCK_HELD', 'Library verifier is already running.');
    }
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
    try {
      await run({
        etaPredictor: session.etaPredictor,
        onLog: (level, message): void => {
          this.#emitLog(level, message);
        },
        onProgress: (progress): void => {
          this.#verifier = { ...this.#verifier, progress };
          this.#emitState();
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
    if (this.#verifier.scanning || this.#verifier.fixing) {
      throw new LockConflictError('LOCK_HELD', 'Library verifier is already running.');
    }
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
