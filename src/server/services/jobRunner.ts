import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as v from 'valibot';

import { runSlotWorkerPool } from '../../domain/concurrency.ts';
import {
  DEFAULT_AUDIO_PREFERRED_LANGUAGES,
  DEFAULT_PREFERRED_LANGUAGES,
  ORGANIZING_TEMP_MARKER,
  ORGANIZING_TEMP_SUFFIX,
  PROCESS_JOB_CONCURRENCY
} from '../../domain/constants.ts';
import { parseProviderReference } from '../../domain/plexFormatter.ts';
import { extractPlexTags } from '../../domain/plexTagExtractor.ts';
import { reapplyAudioFilterToItem } from '../../domain/trackSelection.ts';
import {
  AudioLanguageCodeSchema,
  MetadataLanguageCodeSchema,
  asJobId,
  asTvdbId,
  collectActiveTasks,
  sanitizeConflictResolutions,
  type ActiveJobProgress,
  type ActiveParallelTask,
  type AudioLanguageCode,
  type ClientId,
  type ConflictDecision,
  type EpisodeOrderMode,
  type ExternalSubtitleFile,
  type ItemId,
  type ItemPatch,
  type JobId,
  type JobPhase,
  type JobStageKind,
  type LockErrorCode,
  type LogLevel,
  type MediaKind,
  type MetadataCandidate,
  type MetadataDiagnostic,
  type MetadataLanguageCode,
  type MetadataLookupOptions,
  type OrganizerStatePayload,
  type OutputCategory,
  type ScannedItem,
  type ServerInitStatus,
  type SseLogEvent,
  type SseProgressEvent,
  type SubtitleCandidate,
  type TvdbId,
  type VerifierEntry,
  type VerifierEntryId,
  type VerifierState
} from '../../domain/types.ts';
import { buildMountPathsMap, resolvePortableInputPath, type AppConfig } from '../config.ts';
import {
  backupAndCleanupAfterJob,
  cleanupOrphanTempFiles,
  moveTempOutputFile,
  purgeExpiredBackups
} from './fileMover.ts';
import { applyVerifierRenames, scanLibrariesForCompliance } from './libraryVerifierService.ts';
import {
  analyzeAudioVolume,
  buildFfmpegRemuxArgs,
  measureLoudnormPass1,
  normalizeSubtitleToUtf8,
  probeMedia,
  runFfmpegRemux,
  type LoudnormMeasurements
} from './media/ffmpegRunner.ts';
import { lookupMovieByImdbId, searchMovies } from './metadata/imdbClient.ts';
import { configureMetadataCache } from './metadata/metadataCache.ts';
import {
  fetchEpisodeTitleMap,
  lookupSeriesByTvmazeId,
  lookupSeriesByTvdbId,
  searchTvShows
} from './metadata/tvdbClient.ts';
import { runPreflightCheck, type PreflightReport } from './preflight.ts';
import { openScanCacheDb } from './scanCacheDb.ts';
import { enrichItemsWithAudioAnalysis, scanInputDirectory } from './scanner.ts';
import {
  downloadSubtitleCandidateForItem,
  hasSpanishSubtitles,
  searchSpanishSubtitlesForItem
} from './subtitles/subtitleService.ts';

const MAX_RECENT_LOGS = 100;
const PERCENT_MAX = 100;
const LOUDNORM_PASS1_WEIGHT = 0.45;
const REMUX_WITH_LOUDNORM_WEIGHT = 0.45;
const REMUX_ONLY_WEIGHT = 0.9;
const VERIFY_STAGE_FRACTION = 0.9;
const MOVE_STAGE_WEIGHT = 0.1;
const MS_PER_SECOND = 1000;
const MIN_ETA_FRACTION = 0.001;
const MIN_ETA_ELAPSED_SECONDS = 1;

type ProcessItemStage = Extract<JobStageKind, 'remuxing' | 'verifying' | 'moving'>;

function resolveCategoryFromMetadata(
  mediaKind: MediaKind,
  selectedMetadata: MetadataCandidate | undefined,
  currentCategory: OutputCategory
): OutputCategory {
  if (selectedMetadata?.isAnimated) {
    return mediaKind === 'tv' ? 'animated-series' : 'animated-movies';
  }
  if (
    selectedMetadata &&
    (currentCategory === 'animated-series' || currentCategory === 'animated-movies')
  ) {
    return mediaKind === 'tv' ? 'tv-shows' : 'movies';
  }
  if (mediaKind === 'tv' && currentCategory === 'movies') {
    return 'tv-shows';
  }
  if (mediaKind === 'movie' && currentCategory === 'tv-shows') {
    return 'movies';
  }
  return currentCategory;
}

function isSameResolvedPath(leftPath: string, rightPath: string): boolean {
  const left = path.resolve(leftPath);
  const right = path.resolve(rightPath);
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

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
  #lastError: string | null = null;
  readonly #activeChildren = new Set<ChildProcess>();
  readonly #activeScanChildrenByItemId = new Map<ItemId, ChildProcess>();
  readonly #skippedScanItemIds = new Set<ItemId>();
  #cancelledByUnlock = false;
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
      etaSeconds: evt.etaSeconds
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
    this.#skippedScanItemIds.clear();
    this.#activeScanChildrenByItemId.clear();
    this.#phase = 'SCANNING';
    this.#lastError = null;
    this.#activeJob = {
      jobId: asJobId('scan'),
      totalItems: 0,
      completedItems: 0,
      activeTasks: [],
      currentPercent: 0
    };
    this.#revision += 1;
    this.#emitState();

    this.#trackActiveRun(this.#executeScan());
    return this.#revision;
  }

  async #executeScan(): Promise<void> {
    const scanJobId = asJobId('scan');
    const lookupCache = new Map<string, readonly MetadataCandidate[]>();
    try {
      this.#emitLog('info', `Scanning ${this.#config.inputDir}...`);
      const rawScanned = await scanInputDirectory(
        this.#config.inputDir,
        probeMedia,
        () => this.#cancelledByUnlock,
        {
          configDir: this.#config.configDir,
          audioPreferredLanguages: this.#audioPreferredLanguages,
          onProgress: (completed, total): void => {
            if (this.#cancelledByUnlock) {
              return;
            }
            this.#updateProgress({
              jobId: scanJobId,
              activeTasks: [],
              totalItems: total,
              completedItems: completed,
              percent:
                total > 0
                  ? Math.min(PERCENT_MAX, Math.round((completed / total) * PERCENT_MAX))
                  : 0,
              stage: 'scanning',
              stageLabel: `Probing media (${String(completed)}/${String(total)})`
            });
          }
        }
      );
      if (this.#cancelledByUnlock) {
        this.#items = [...rawScanned];
        return;
      }
      const scanStartedAtMs = performance.now();
      const scanned = await enrichItemsWithAudioAnalysis(
        rawScanned,
        this.#config.configDir,
        async (filePath, streamOrder, durationSeconds, onProgress, itemId) => {
          const tracker =
            itemId !== undefined
              ? this.#createScanChildTracker(itemId)
              : this.#createChildTracker();
          try {
            return await analyzeAudioVolume(
              filePath,
              streamOrder,
              durationSeconds,
              onProgress,
              tracker
            );
          } catch (err) {
            if (itemId !== undefined && this.#skippedScanItemIds.has(itemId)) {
              throw err;
            }
            const msg = err instanceof Error ? err.message : String(err);
            this.#emitLog(
              'warn',
              `Audio analysis skipped for "${path.basename(filePath)}" (stream #${String(streamOrder)}): ${msg}`
            );
            throw err;
          }
        },
        (completed, total, activeTasks, overallFraction, activeFraction): void => {
          if (this.#cancelledByUnlock) {
            return;
          }
          const effectiveFraction = overallFraction ?? (total > 0 ? completed / total : 1);
          const etaFraction = activeFraction ?? effectiveFraction;
          const percent = Math.min(PERCENT_MAX, Math.round(effectiveFraction * PERCENT_MAX));
          const elapsedSec = (performance.now() - scanStartedAtMs) / 1000;
          const etaSeconds =
            etaFraction > 0.001 && completed < total && elapsedSec >= 1
              ? Math.max(0, Math.round((elapsedSec * (1 - etaFraction)) / etaFraction))
              : undefined;
          this.#updateProgress({
            jobId: scanJobId,
            activeTasks,
            totalItems: total,
            completedItems: completed,
            percent,
            stage: 'scanning',
            stageLabel: `Analyzing audio (${String(completed)}/${String(total)})`,
            etaSeconds
          });
        },
        () => this.#cancelledByUnlock,
        (stats): void => {
          const prunedSuffix = stats.pruned > 0 ? `, ${String(stats.pruned)} expired pruned` : '';
          this.#emitLog(
            'info',
            `Audio scan cache: ${String(stats.cacheHits)} cached, ${String(stats.analyzed)} analyzed${prunedSuffix}.`
          );
        },
        (itemId) => this.#skippedScanItemIds.has(itemId)
      );
      if (this.#cancelledByUnlock) {
        this.#items = [...scanned];
        return;
      }
      const enriched = await this.#enrichScannedItemsMetadata(scanJobId, scanned, lookupCache);

      if (this.#cancelledByUnlock) {
        this.#items = [...enriched];
        return;
      }

      const withSubtitles = this.#autoDownloadSubtitles
        ? await this.#autoDownloadMissingSpanishSubtitles(scanJobId, enriched)
        : [...enriched];

      if (this.#cancelledByUnlock) {
        this.#items = [...withSubtitles];
        return;
      }

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
      this.#emitLog('info', `Scan completed: ${String(withSubtitles.length)} media file(s) found.`);
      this.#emitState();
    } catch (err) {
      if (this.#cancelledByUnlock) {
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.#activeJob = null;
      this.#lastError = msg;
      this.#phase = 'ERROR';
      this.#revision += 1;
      this.#emitLog('error', `Scan failed: ${msg}`);
      this.#emitState();
    }
  }

  async #enrichScannedItemsMetadata(
    scanJobId: JobId,
    scanned: readonly ScannedItem[],
    lookupCache: Map<string, readonly MetadataCandidate[]>
  ): Promise<ScannedItem[]> {
    const enriched: ScannedItem[] = [];
    const reportedDiagnostics = new Set<string>();
    this.#activeJob = {
      jobId: scanJobId,
      totalItems: scanned.length,
      completedItems: 0,
      activeTasks: [],
      currentPercent: 0,
      stage: 'scanning',
      stageLabel: `Fetching metadata (0/${String(scanned.length)})`
    };
    this.#emitState();

    for (const item of scanned) {
      if (this.#cancelledByUnlock) {
        break;
      }
      const startPercent =
        scanned.length > 0 ? Math.round((enriched.length / scanned.length) * PERCENT_MAX) : 0;
      this.#updateProgress({
        jobId: scanJobId,
        activeTasks: [{ slot: 0, itemId: item.id, fileName: item.fileName }],
        totalItems: scanned.length,
        completedItems: enriched.length,
        percent: startPercent,
        stage: 'scanning',
        stageLabel: `Fetching metadata (${String(enriched.length)}/${String(scanned.length)})`
      });

      const updatedItem = await this.#resolveSingleItemMetadata(
        item,
        lookupCache,
        reportedDiagnostics
      );
      if (this.#cancelledByUnlock) {
        break;
      }
      enriched.push(updatedItem);

      const donePercent =
        scanned.length > 0
          ? Math.round((enriched.length / scanned.length) * PERCENT_MAX)
          : PERCENT_MAX;
      this.#updateProgress({
        jobId: scanJobId,
        activeTasks:
          enriched.length < scanned.length
            ? [{ slot: 0, itemId: item.id, fileName: item.fileName }]
            : [],
        totalItems: scanned.length,
        completedItems: enriched.length,
        percent: donePercent,
        stage: 'scanning',
        stageLabel: `Fetching metadata (${String(enriched.length)}/${String(scanned.length)})`
      });
    }

    return enriched;
  }

  async #resolveSingleItemMetadata(
    item: ScannedItem,
    lookupCache: Map<string, readonly MetadataCandidate[]>,
    reportedDiagnostics: Set<string>
  ): Promise<ScannedItem> {
    const itemDiagnostics: MetadataDiagnostic[] = [];
    const lookupOptions: MetadataLookupOptions = {
      preferredLanguages: this.#preferredLanguages,
      onLog: (level, message) => this.#emitLog(level, message),
      onDiagnostic: (diagnostic) => {
        itemDiagnostics.push(diagnostic);
        const dedupKey = `${diagnostic.provider}:${diagnostic.kind}`;
        if (!reportedDiagnostics.has(dedupKey)) {
          reportedDiagnostics.add(dedupKey);
          this.#emitLog('error', diagnostic.message);
        }
      }
    };

    const lookupKey = `${item.mediaKind}:${item.parsedTitle.toLowerCase()}:${String(item.parsedYear ?? '')}`;
    let fetched = lookupCache.get(lookupKey);
    if (fetched === undefined) {
      fetched =
        item.mediaKind === 'movie'
          ? await searchMovies(
              item.parsedTitle,
              item.parsedYear,
              this.#config.omdbApiKey,
              fetch,
              lookupOptions
            )
          : await searchTvShows(item.parsedTitle, this.#config.tvdbApiKey, fetch, lookupOptions);
      if (fetched.length > 0 || itemDiagnostics.length === 0) {
        lookupCache.set(lookupKey, fetched);
      }
    }

    const candidates = [...item.candidates, ...fetched];
    const selectedMetadata = item.selectedMetadata ?? candidates[0];
    let episode = item.episode;
    if (item.mediaKind === 'tv' && selectedMetadata?.tvdbId && episode) {
      episode = await this.#enrichEpisodeTitle(
        selectedMetadata.tvdbId,
        item.episodeOrder,
        episode,
        lookupOptions
      );
    }

    const warnings = [...item.warnings];
    if (candidates.length === 0) {
      for (const diag of itemDiagnostics.filter((d) => !warnings.includes(d.message))) {
        warnings.push(diag.message);
      }
    }
    if (item.mediaKind === 'tv' && selectedMetadata && !selectedMetadata.tvdbId) {
      warnings.push(
        'TVmaze did not provide a TVDB ID; {tvdb-...} will be omitted unless entered manually.'
      );
    }

    return {
      ...item,
      category: resolveCategoryFromMetadata(item.mediaKind, selectedMetadata, item.category),
      episode,
      candidates,
      selectedMetadata,
      warnings
    };
  }

  async #enrichEpisodeTitle(
    tvdbId: TvdbId,
    order: EpisodeOrderMode,
    episode: NonNullable<ScannedItem['episode']>,
    options?: MetadataLookupOptions
  ): Promise<NonNullable<ScannedItem['episode']>> {
    const epMap = await fetchEpisodeTitleMap(
      tvdbId,
      order,
      this.#config.tvdbApiKey,
      fetch,
      options
    );
    const title = epMap.get(`${String(episode.seasonNumber)}:${String(episode.episodeStart)}`);
    return title ? { ...episode, episodeTitle: title } : episode;
  }

  async #applyPatchToItem(
    current: ScannedItem,
    patch: ItemPatch,
    prefetchedEpisodeMap?: ReadonlyMap<string, string>
  ): Promise<ScannedItem> {
    let nextEpisode = current.episode;
    const nextMeta = patch.selectedMetadata ?? current.selectedMetadata;
    const nextOrder = patch.episodeOrder ?? current.episodeOrder;
    const nextKind = patch.mediaKind ?? current.mediaKind;

    if (
      nextKind === 'tv' &&
      nextMeta?.tvdbId &&
      nextEpisode &&
      (patch.selectedMetadata !== undefined || patch.episodeOrder !== undefined)
    ) {
      if (prefetchedEpisodeMap) {
        const title = prefetchedEpisodeMap.get(
          `${String(nextEpisode.seasonNumber)}:${String(nextEpisode.episodeStart)}`
        );
        nextEpisode = title ? { ...nextEpisode, episodeTitle: title } : nextEpisode;
      } else {
        nextEpisode = await this.#enrichEpisodeTitle(nextMeta.tvdbId, nextOrder, nextEpisode);
      }
    }

    let nextCandidates = current.candidates;
    if (patch.selectedMetadata) {
      const target = patch.selectedMetadata;
      const alreadyPresent = current.candidates.some(
        (c): boolean =>
          c.source === target.source &&
          c.title === target.title &&
          c.imdbId === target.imdbId &&
          c.tvdbId === target.tvdbId
      );
      if (!alreadyPresent) {
        nextCandidates = [target, ...current.candidates];
      }
    }

    const nextEdition =
      patch.edition !== undefined ? patch.edition.trim() || undefined : current.edition;

    const nextTrackSelection = patch.trackSelection ?? current.trackSelection;
    const updatedTrackSelection = patch.audioNormalization
      ? { ...nextTrackSelection, audioNormalization: patch.audioNormalization }
      : nextTrackSelection;
    const baseNoExt = path.basename(current.fileName, path.extname(current.fileName));
    const nextTags =
      patch.trackSelection !== undefined || patch.audioNormalization !== undefined
        ? extractPlexTags(baseNoExt, current.probe, {
            trackSelection: updatedTrackSelection
          })
        : current.tags;

    const nextCategory =
      patch.category ??
      (patch.selectedMetadata !== undefined || patch.mediaKind !== undefined
        ? resolveCategoryFromMetadata(nextKind, nextMeta, current.category)
        : current.category);

    return {
      ...current,
      mediaKind: nextKind,
      category: nextCategory,
      edition: nextEdition,
      include: patch.include ?? current.include,
      tags: nextTags,
      candidates: nextCandidates,
      selectedMetadata: nextMeta,
      episodeOrder: nextOrder,
      episode: nextEpisode,
      trackSelection: updatedTrackSelection
    };
  }

  #attachDownloadedSubtitle(
    item: ScannedItem,
    downloaded: ExternalSubtitleFile,
    candidate: SubtitleCandidate
  ): ScannedItem {
    const filteredSubs = item.externalSubtitles.filter(
      (sub) => sub.path !== downloaded.path && !sub.downloadedFrom
    );
    const nextExternalSubtitles = [...filteredSubs, downloaded];
    const filteredOrder = item.trackSelection.externalSubtitleOrder.filter(
      (subPath) =>
        subPath !== downloaded.path &&
        !item.externalSubtitles.some((old) => old.path === subPath && Boolean(old.downloadedFrom))
    );
    const nextOrder = [...filteredOrder, downloaded.path];
    return {
      ...item,
      externalSubtitles: nextExternalSubtitles,
      trackSelection: {
        ...item.trackSelection,
        externalSubtitleOrder: nextOrder
      },
      subtitleStatus: {
        status: 'downloaded',
        provider: candidate.provider,
        variant: candidate.variant
      }
    };
  }

  async #autoDownloadMissingSpanishSubtitles(
    scanJobId: JobId,
    items: readonly ScannedItem[]
  ): Promise<readonly ScannedItem[]> {
    const missingIndices: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item && !hasSpanishSubtitles(item)) {
        missingIndices.push(i);
      }
    }
    if (missingIndices.length === 0) {
      return items;
    }

    const result = [...items];
    const concurrency = 3;
    const workerCount = Math.min(concurrency, missingIndices.length);
    const slotTasks: Array<ActiveParallelTask | undefined> = Array.from(
      { length: workerCount },
      () => undefined
    );
    let completed = 0;
    const total = missingIndices.length;

    const emitSubProgress = (): void => {
      this.#updateProgress({
        jobId: scanJobId,
        activeTasks: collectActiveTasks(slotTasks),
        totalItems: total,
        completedItems: completed,
        percent: Math.min(PERCENT_MAX, Math.round((completed / total) * PERCENT_MAX)),
        stage: 'scanning',
        stageLabel: `Fetching Spanish subtitles (${String(completed)}/${String(total)})`
      });
    };

    await runSlotWorkerPool(
      missingIndices,
      concurrency,
      async (idx, _poolIdx, slot) => {
        const item = result[idx]!;
        slotTasks[slot] = { slot, fileName: item.fileName, itemId: item.id };
        emitSubProgress();
        try {
          const candidates = await this.#searchSubtitles(
            item,
            this.#config,
            undefined,
            (level, msg) => this.#emitLog(level, msg)
          );
          const best = candidates[0];
          if (!best) {
            result[idx] = { ...item, subtitleStatus: { status: 'not_found' } };
          } else {
            const downloaded = await this.#downloadSubtitle(item, best, this.#config);
            result[idx] = this.#attachDownloadedSubtitle(item, downloaded, best);
            this.#emitLog(
              'info',
              `Auto-downloaded spa subtitle for ${item.fileName} (${best.provider}, ${best.variant})`
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result[idx] = { ...item, subtitleStatus: { status: 'failed', message: msg } };
          this.#emitLog('warn', `Subtitle auto-download skipped for ${item.fileName}: ${msg}`);
        } finally {
          slotTasks[slot] = undefined;
          completed += 1;
          emitSubProgress();
        }
      },
      () => this.#cancelledByUnlock
    );
    return result;
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
    this.#items[idx] = this.#attachDownloadedSubtitle(item, downloaded, chosen);
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

    this.#items[idx] = await this.#applyPatchToItem(this.#items[idx]!, patch);

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

    const idSet = new Set(itemIds);
    if (idSet.size === 0) {
      throw new Error('Bulk patch requires at least one item ID.');
    }

    let prefetchedEpisodeMap: ReadonlyMap<string, string> | undefined;
    if (
      patch.selectedMetadata?.tvdbId &&
      this.#items.some(
        (i) => idSet.has(i.id) && (patch.mediaKind ?? i.mediaKind) === 'tv' && i.episode
      )
    ) {
      const order = patch.episodeOrder ?? 'aired';
      prefetchedEpisodeMap = await fetchEpisodeTitleMap(
        patch.selectedMetadata.tvdbId,
        order,
        this.#config.tvdbApiKey,
        fetch,
        { preferredLanguages: this.#preferredLanguages }
      );
    }

    let updatedCount = 0;
    const nextItems: ScannedItem[] = [];
    for (const current of this.#items) {
      if (!idSet.has(current.id)) {
        nextItems.push(current);
        continue;
      }
      nextItems.push(await this.#applyPatchToItem(current, patch, prefetchedEpisodeMap));
      updatedCount += 1;
    }

    if (updatedCount === 0) {
      throw new Error('No matching queue items found for bulk patch.');
    }

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
    const lookupOptions: MetadataLookupOptions = {
      throwOnFailure: true,
      preferredLanguages: this.#preferredLanguages
    };
    const queryRef = parseProviderReference(params.query);
    const imdbRef = params.imdbId
      ? (parseProviderReference(params.imdbId).imdbId ?? params.imdbId)
      : queryRef.imdbId;
    const tvdbRef =
      (params.tvdbId
        ? (parseProviderReference(params.tvdbId).tvdbId ?? params.tvdbId.trim())
        : undefined) ?? queryRef.tvdbId;
    const tvmazeRef =
      (params.tvdbId ? parseProviderReference(params.tvdbId).tvmazeId : undefined) ??
      queryRef.tvmazeId;

    if (imdbRef) {
      const found = await lookupMovieByImdbId(
        imdbRef,
        this.#config.omdbApiKey,
        fetch,
        lookupOptions
      );
      return found ? [found] : [];
    }
    if (tvmazeRef) {
      const found = await lookupSeriesByTvmazeId(tvmazeRef, fetch, lookupOptions);
      return found ? [found] : [];
    }
    if (tvdbRef && /^\d+$/.test(tvdbRef)) {
      const found = await lookupSeriesByTvdbId(
        asTvdbId(tvdbRef),
        this.#config.tvdbApiKey,
        fetch,
        lookupOptions
      );
      return found ? [found] : [];
    }
    if (params.kind === 'movie') {
      return searchMovies(params.query, params.year, this.#config.omdbApiKey, fetch, lookupOptions);
    }
    return searchTvShows(params.query, this.#config.tvdbApiKey, fetch, lookupOptions);
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
    this.#revision += 1;

    const toProcess = this.#items.filter(
      (item) => item.include && conflictResolutions[item.id] !== 'ignore'
    );
    this.#activeJob = {
      jobId,
      totalItems: toProcess.length,
      completedItems: 0,
      activeTasks: [],
      currentPercent: 0
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

  async #measureLoudnormForItem(
    item: ScannedItem,
    downmixStereo: boolean,
    onProgress?: (
      fraction: number,
      label: string,
      activeTasks: readonly ActiveParallelTask[]
    ) => void
  ): Promise<ReadonlyMap<number, LoudnormMeasurements>> {
    this.#emitLog('info', `Measuring EBU R128 loudness (pass 1) for ${item.fileName}...`);
    const includedTracks = item.trackSelection.audioTracks.filter((t) => t.include);
    const measuredMap = new Map<number, LoudnormMeasurements>();
    if (includedTracks.length === 0) {
      return measuredMap;
    }

    const workerCount = Math.min(includedTracks.length, Math.max(1, os.cpus().length));
    const trackSlotTasks = Array.from<ActiveParallelTask | undefined>({ length: workerCount });
    const trackPercents = Array.from({ length: includedTracks.length }, (): number => 0);
    let completedTracks = 0;

    const emitPass1Progress = (): void => {
      const sumPct = trackPercents.reduce((acc, p): number => acc + p, 0);
      const fraction = Math.max(0, Math.min(1, sumPct / (includedTracks.length * PERCENT_MAX)));
      const label = `Loudnorm Pass 1/2 (${String(completedTracks)}/${String(includedTracks.length)} tracks)`;
      onProgress?.(fraction, label, collectActiveTasks(trackSlotTasks));
    };

    await runSlotWorkerPool(
      includedTracks,
      workerCount,
      async (track, trackIdx, trackSlot) => {
        const trackLabel = `${item.fileName} · audio #${String(trackIdx + 1)} (${track.language})`;
        trackSlotTasks[trackSlot] = {
          slot: trackSlot,
          itemId: item.id,
          fileName: trackLabel,
          percent: 0
        };
        emitPass1Progress();

        const measured = await measureLoudnormPass1(
          item.sourcePath,
          track.streamOrder,
          downmixStereo,
          item.probe.durationSeconds,
          (update): void => {
            if (this.#cancelledByUnlock) {
              return;
            }
            trackPercents[trackIdx] = update.percent;
            trackSlotTasks[trackSlot] = {
              slot: trackSlot,
              itemId: item.id,
              fileName: trackLabel,
              percent: update.percent
            };
            emitPass1Progress();
          },
          this.#createChildTracker()
        );
        trackSlotTasks[trackSlot] = undefined;
        if (this.#cancelledByUnlock) {
          return;
        }
        measuredMap.set(track.streamOrder, measured);
        completedTracks += 1;
        trackPercents[trackIdx] = PERCENT_MAX;
        emitPass1Progress();
      },
      () => this.#cancelledByUnlock
    );
    return measuredMap;
  }

  async #pruneEmptyOldParentDirs(oldFilePath: string): Promise<void> {
    const maxPruneDepth = 2;
    const protectedRoots = Object.values(buildMountPathsMap(this.#config));
    let current = path.resolve(path.dirname(oldFilePath));
    for (let depth = 0; depth < maxPruneDepth; depth += 1) {
      if (protectedRoots.some((root) => isSameResolvedPath(root, current))) {
        break;
      }
      try {
        await fs.rmdir(current);
      } catch {
        break;
      }
      current = path.dirname(current);
    }
  }

  async #processSingleJobItem(options: {
    readonly jobId: JobId;
    readonly item: ScannedItem;
    readonly slot: number;
    readonly destPath: string;
    readonly allowOverwrite: boolean;
    readonly oldExistingPath: string | undefined;
    readonly createdTempSubs: string[];
    readonly onProgress: (
      slotTasks: ActiveParallelTask | readonly ActiveParallelTask[] | undefined,
      itemFraction: number,
      stage: ProcessItemStage,
      stageLabel: string
    ) => void;
  }): Promise<boolean> {
    const {
      jobId,
      item,
      slot,
      destPath,
      allowOverwrite,
      oldExistingPath,
      createdTempSubs,
      onProgress
    } = options;
    const sourceDir = path.dirname(item.sourcePath);
    const baseNoExt = path.basename(item.sourcePath, path.extname(item.sourcePath));
    const tempMkvPath = path.join(
      sourceDir,
      `${baseNoExt}${ORGANIZING_TEMP_MARKER}${jobId}.${item.id}${ORGANIZING_TEMP_SUFFIX}`
    );

    const subInputs: {
      readonly sub: (typeof item.externalSubtitles)[number];
      readonly inputPath: string;
    }[] = [];
    for (const subPath of item.trackSelection.externalSubtitleOrder) {
      const subObj = item.externalSubtitles.find((s): boolean => s.path === subPath);
      if (!subObj) {
        continue;
      }
      const normalized = await normalizeSubtitleToUtf8(subObj, sourceDir);
      if (normalized.tempCreated) {
        createdTempSubs.push(normalized.tempCreated);
      }
      subInputs.push({ sub: subObj, inputPath: normalized.inputPath });
    }

    onProgress(
      { slot, itemId: item.id, fileName: item.fileName, percent: 0 },
      0,
      'remuxing',
      'Remuxing'
    );
    this.#emitLog('info', `Remuxing ${item.fileName} -> ${path.basename(destPath)}`);

    const norm = item.trackSelection.audioNormalization;
    const hasLoudnorm = norm?.mode === 'loudnorm';
    const remuxWeight = hasLoudnorm ? REMUX_WITH_LOUDNORM_WEIGHT : REMUX_ONLY_WEIGHT;
    const remuxOffset = hasLoudnorm ? LOUDNORM_PASS1_WEIGHT : 0;

    const loudnormByStreamOrder = hasLoudnorm
      ? await this.#measureLoudnormForItem(
          item,
          norm.downmixStereo,
          (fraction, label, activeTrackTasks): void => {
            onProgress(activeTrackTasks, fraction * LOUDNORM_PASS1_WEIGHT, 'remuxing', label);
          }
        )
      : undefined;

    if (this.#cancelledByUnlock) {
      return false;
    }

    const remuxStageLabel = hasLoudnorm ? 'Loudnorm Pass 2/2 (Remuxing)' : 'Remuxing';
    const args = buildFfmpegRemuxArgs(item, tempMkvPath, subInputs, loudnormByStreamOrder);
    await runFfmpegRemux(
      args,
      item.probe.durationSeconds,
      (percent): void => {
        onProgress(
          {
            slot,
            itemId: item.id,
            fileName: hasLoudnorm ? `${item.fileName} · Pass 2/2` : item.fileName,
            percent
          },
          remuxOffset + (percent / PERCENT_MAX) * remuxWeight,
          'remuxing',
          remuxStageLabel
        );
      },
      this.#createChildTracker()
    );

    if (this.#cancelledByUnlock) {
      return false;
    }

    const destFileName = path.basename(destPath);
    onProgress(
      { slot, itemId: item.id, fileName: `${destFileName} · Verifying` },
      VERIFY_STAGE_FRACTION,
      'verifying',
      'Verifying'
    );
    await probeMedia(tempMkvPath);

    onProgress(
      { slot, itemId: item.id, fileName: `${destFileName} · Moving`, percent: 0 },
      VERIFY_STAGE_FRACTION,
      'moving',
      'Moving'
    );
    this.#emitLog('info', `Moving ${destFileName} to ${item.category}`);

    await moveTempOutputFile(tempMkvPath, destPath, allowOverwrite, (movePercent): void => {
      onProgress(
        { slot, itemId: item.id, fileName: `${destFileName} · Moving`, percent: movePercent },
        VERIFY_STAGE_FRACTION + (movePercent / PERCENT_MAX) * MOVE_STAGE_WEIGHT,
        'moving',
        'Moving'
      );
    });

    if (allowOverwrite && oldExistingPath && !isSameResolvedPath(oldExistingPath, destPath)) {
      await fs.rm(oldExistingPath, { force: true });
      await this.#pruneEmptyOldParentDirs(oldExistingPath);
    }

    onProgress(undefined, 1, 'moving', 'Moved');
    return true;
  }

  async #executeJob(
    jobId: JobId,
    toProcess: readonly ScannedItem[],
    projectedByItemId: Readonly<Partial<Record<ItemId, string>>>,
    conflictResolutions: Readonly<Partial<Record<ItemId, ConflictDecision>>>,
    existingCollisionByItemId: Readonly<Partial<Record<ItemId, string>>>
  ): Promise<void> {
    const movedItems: ScannedItem[] = [];
    const createdTempSubs: string[] = [];

    try {
      const purged = await purgeExpiredBackups(this.#config.backupDir);
      if (purged.removedFiles > 0) {
        this.#emitLog(
          'info',
          `Purged ${String(purged.removedFiles)} expired backup file(s) older than 7 days.`
        );
      }

      const workerCount = Math.min(PROCESS_JOB_CONCURRENCY, Math.max(1, toProcess.length));
      const slotStates: Array<{
        tasks: readonly ActiveParallelTask[];
        stage?: ProcessItemStage;
        stageLabel?: string;
      }> = Array.from({ length: workerCount }, () => ({ tasks: [] }));
      const itemBytes = toProcess.map((item) => Math.max(1, item.probe.sizeBytes));
      const totalBytes = itemBytes.reduce((sum, b) => sum + b, 0);
      const itemFractions = toProcess.map(() => 0);
      const jobStartedAtMs = performance.now();
      let completedCount = 0;

      const resolveActiveStage = (
        fallbackStage: ProcessItemStage,
        fallbackLabel: string
      ): {
        readonly stage: ProcessItemStage;
        readonly stageLabel: string;
      } => {
        for (const candidate of ['remuxing', 'verifying', 'moving'] as const) {
          const activeSlot = slotStates.find(
            (state) => state.tasks.length > 0 && state.stage === candidate
          );
          if (activeSlot) {
            return {
              stage: candidate,
              stageLabel: activeSlot.stageLabel ?? fallbackLabel
            };
          }
        }
        return { stage: fallbackStage, stageLabel: fallbackLabel };
      };

      const emitJobProgress = (fallbackStage: ProcessItemStage, fallbackLabel: string): void => {
        if (this.#cancelledByUnlock) {
          return;
        }
        let doneBytes = 0;
        for (let i = 0; i < itemBytes.length; i++) {
          doneBytes += (itemBytes[i] ?? 0) * (itemFractions[i] ?? 0);
        }
        const overallFraction =
          totalBytes > 0 ? Math.max(0, Math.min(1, doneBytes / totalBytes)) : 1;
        const percent = Math.min(PERCENT_MAX, Math.round(overallFraction * PERCENT_MAX));
        const elapsedSec = (performance.now() - jobStartedAtMs) / MS_PER_SECOND;
        const etaSeconds =
          overallFraction > MIN_ETA_FRACTION &&
          completedCount < toProcess.length &&
          elapsedSec >= MIN_ETA_ELAPSED_SECONDS
            ? Math.max(0, Math.round((elapsedSec * (1 - overallFraction)) / overallFraction))
            : undefined;
        const activeTasks = slotStates
          .flatMap((state) => state.tasks)
          .map((task, index) => ({ ...task, slot: index }));
        const resolved = resolveActiveStage(fallbackStage, fallbackLabel);
        this.#updateProgress({
          jobId,
          activeTasks,
          totalItems: toProcess.length,
          completedItems: completedCount,
          percent,
          stage: resolved.stage,
          stageLabel: resolved.stageLabel,
          etaSeconds
        });
      };

      await runSlotWorkerPool(
        toProcess,
        workerCount,
        async (item, idx, slot): Promise<void> => {
          const destPath = projectedByItemId[item.id];
          if (!destPath) {
            throw new Error(`Missing projected destination for ${item.id}`);
          }
          const completed = await this.#processSingleJobItem({
            jobId,
            item,
            slot,
            destPath,
            allowOverwrite: conflictResolutions[item.id] === 'overwrite',
            oldExistingPath: existingCollisionByItemId[item.id],
            createdTempSubs,
            onProgress: (slotTasks, itemFraction, stage, stageLabel): void => {
              const tasks = Array.isArray(slotTasks) ? slotTasks : slotTasks ? [slotTasks] : [];
              slotStates[slot] = tasks.length > 0 ? { tasks, stage, stageLabel } : { tasks: [] };
              itemFractions[idx] = itemFraction;
              emitJobProgress(stage, stageLabel);
            }
          });
          slotStates[slot] = { tasks: [] };
          if (!completed || this.#cancelledByUnlock) {
            return;
          }
          itemFractions[idx] = 1;
          completedCount += 1;
          movedItems.push(item);
          emitJobProgress('moving', 'Moved');
        },
        () => this.#cancelledByUnlock
      );

      if (this.#cancelledByUnlock) {
        await this.#finalizeMovedItems(movedItems);
        return;
      }

      this.#emitLog(
        'info',
        `Backing up & cleaning up ${String(movedItems.length)} processed source item(s)...`
      );
      await backupAndCleanupAfterJob(
        movedItems,
        this.#config.inputDir,
        this.#config.backupDir,
        (cleaned, total, fileName): void => {
          const cleanPercent =
            total > 0 ? Math.round((cleaned / total) * PERCENT_MAX) : PERCENT_MAX;
          this.#updateProgress({
            jobId,
            activeTasks: [{ slot: 0, fileName }],
            totalItems: total,
            completedItems: cleaned,
            percent: cleanPercent,
            stage: 'cleanup',
            stageLabel: 'Cleaning up'
          });
        }
      );
      await this.#finalizeMovedItems(movedItems);
      this.#activeJob = null;
      this.#phase = 'IDLE';
      this.#lockOwnerClientId = null;
      this.#revision += 1;
      await this.#persistQueue();
      this.#emitLog(
        'info',
        `Job ${jobId} completed: ${String(movedItems.length)} file(s) organized.`
      );
      this.#emitState();
    } catch (err) {
      if (this.#cancelledByUnlock) {
        await this.#finalizeMovedItems(movedItems);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.#phase = 'ERROR';
      this.#activeJob = null;
      this.#revision += 1;
      await cleanupOrphanTempFiles(this.#config.inputDir);
      this.#emitLog('error', `Job ${jobId} failed: ${msg}`);
      this.#emitState();
    } finally {
      for (const tempSub of createdTempSubs) {
        await fs.rm(tempSub, { force: true });
      }
    }
  }

  public async unlock(clientId: ClientId, force: boolean): Promise<OrganizerStatePayload> {
    if (!force) {
      this.#assertLockOwner(clientId);
    }
    const wasRunning = this.#phase === 'SCANNING' || this.#phase === 'PROCESSING';
    this.#cancelledByUnlock = true;
    for (const child of this.#activeChildren) {
      child.kill('SIGKILL');
    }
    this.#activeChildren.clear();
    if (this.#activeRunPromise) {
      await this.#activeRunPromise;
    }
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
        activeTasks: []
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

  async #runVerifierScan(recalculateTags = false): Promise<void> {
    try {
      const result = await scanLibrariesForCompliance(
        this.#config,
        (level, message): void => {
          this.#emitLog(level, message);
        },
        undefined,
        (progress): void => {
          this.#verifier = {
            ...this.#verifier,
            progress
          };
          this.#emitState();
        },
        this.#preferredLanguages,
        recalculateTags
      );
      this.#verifier = {
        scanning: false,
        fixing: false,
        progress: null,
        summary: result.summary,
        entries: result.entries,
        lastFixResult: null
      };
      this.#revision += 1;
      this.#emitLog(
        'info',
        `Verifier scan complete: ${String(result.summary.issueCount)} issue(s) across ${String(result.summary.totalRootsAnalyzed)} folder(s) and ${String(result.summary.totalFilesAnalyzed)} file(s).`
      );
      this.#emitState();
    } catch (err) {
      this.#failVerifierOperation('scan', err);
    }
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
        activeTasks: []
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
    try {
      const fixResult = await applyVerifierRenames(
        this.#config,
        selected,
        (level, message): void => {
          this.#emitLog(level, message);
        },
        (progress): void => {
          this.#verifier = {
            ...this.#verifier,
            progress
          };
          this.#emitState();
        },
        conflictResolutions
      );
      this.#emitLog(
        fixResult.failures.length > 0 ? 'warn' : 'info',
        `Verifier fix finished: ${String(fixResult.fixedEntries)}/${String(selected.length)} fixed (${String(fixResult.renamedSteps)} rename steps).`
      );
      const rescan = await scanLibrariesForCompliance(
        this.#config,
        (level, message): void => {
          this.#emitLog(level, message);
        },
        undefined,
        (progress): void => {
          this.#verifier = {
            ...this.#verifier,
            progress: {
              ...progress,
              stageLabel: `Re-verifying · ${progress.stageLabel}`
            }
          };
          this.#emitState();
        },
        this.#preferredLanguages
      );
      this.#verifier = {
        scanning: false,
        fixing: false,
        progress: null,
        summary: rescan.summary,
        entries: rescan.entries,
        lastFixResult: {
          renamedFiles: fixResult.renamedFiles,
          renamedDirs: fixResult.renamedDirs,
          errors: fixResult.failures.map((f): string => `${f.currentRootName}: ${f.error}`)
        }
      };
      this.#revision += 1;
      this.#emitState();
    } catch (err) {
      this.#failVerifierOperation('fix', err);
    }
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
