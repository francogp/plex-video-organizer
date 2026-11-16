import type { ChildProcess } from 'node:child_process';
import path from 'node:path';

import { runSlotWorkerPool } from '../../domain/concurrency.ts';
import { parseProviderReference } from '../../domain/plexFormatter.ts';
import { extractPlexTags } from '../../domain/plexTagExtractor.ts';
import {
  asJobId,
  asTvdbId,
  collectActiveTasks,
  type ActiveParallelTask,
  type AudioLanguageCode,
  type EpisodeOrderMode,
  type ExternalSubtitleFile,
  type ItemId,
  type ItemPatch,
  type JobId,
  type LogLevel,
  type MediaKind,
  type MetadataCandidate,
  type MetadataDiagnostic,
  type MetadataLanguageCode,
  type MetadataLookupOptions,
  type OutputCategory,
  type ScannedItem,
  type SseProgressEvent,
  type SubtitleCandidate,
  type TvdbId
} from '../../domain/types.ts';
import type { AppConfig } from '../config.ts';
import { analyzeAudioVolume, probeMedia } from './media/ffmpegRunner.ts';
import { lookupMovieByImdbId, searchMovies } from './metadata/imdbClient.ts';
import {
  fetchEpisodeTitleMap,
  lookupSeriesByTvmazeId,
  lookupSeriesByTvdbId,
  searchTvShows
} from './metadata/tvdbClient.ts';
import { enrichItemsWithAudioAnalysis, scanInputDirectory } from './scanner.ts';
import {
  downloadSubtitleCandidateForItem,
  hasSpanishSubtitles,
  searchSpanishSubtitlesForItem
} from './subtitles/subtitleService.ts';

const PERCENT_MAX = 100;
const MS_PER_SECOND = 1000;
const MIN_ETA_FRACTION = 0.001;
const MIN_ETA_ELAPSED_SECONDS = 1;
const SUBTITLE_DOWNLOAD_CONCURRENCY = 3;

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

export function attachDownloadedSubtitle(
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

async function enrichEpisodeTitle(
  tvdbId: TvdbId,
  order: EpisodeOrderMode,
  episode: NonNullable<ScannedItem['episode']>,
  tvdbApiKey: string | undefined,
  options?: MetadataLookupOptions
): Promise<NonNullable<ScannedItem['episode']>> {
  const epMap = await fetchEpisodeTitleMap(tvdbId, order, tvdbApiKey, fetch, options);
  const title = epMap.get(`${String(episode.seasonNumber)}:${String(episode.episodeStart)}`);
  return title ? { ...episode, episodeTitle: title } : episode;
}

export async function applyPatchToItem(
  current: ScannedItem,
  patch: ItemPatch,
  tvdbApiKey: string | undefined,
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
      nextEpisode = await enrichEpisodeTitle(nextMeta.tvdbId, nextOrder, nextEpisode, tvdbApiKey);
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

export async function applyBulkPatchToItems(
  items: readonly ScannedItem[],
  itemIds: readonly ItemId[],
  patch: ItemPatch,
  tvdbApiKey: string | undefined,
  preferredLanguages: readonly MetadataLanguageCode[]
): Promise<{ readonly nextItems: ScannedItem[]; readonly updatedCount: number }> {
  const idSet = new Set(itemIds);
  if (idSet.size === 0) {
    throw new Error('Bulk patch requires at least one item ID.');
  }

  let prefetchedEpisodeMap: ReadonlyMap<string, string> | undefined;
  if (
    patch.selectedMetadata?.tvdbId &&
    items.some((i) => idSet.has(i.id) && (patch.mediaKind ?? i.mediaKind) === 'tv' && i.episode)
  ) {
    const order = patch.episodeOrder ?? 'aired';
    prefetchedEpisodeMap = await fetchEpisodeTitleMap(
      patch.selectedMetadata.tvdbId,
      order,
      tvdbApiKey,
      fetch,
      { preferredLanguages }
    );
  }

  let updatedCount = 0;
  const nextItems: ScannedItem[] = [];
  for (const current of items) {
    if (!idSet.has(current.id)) {
      nextItems.push(current);
      continue;
    }
    nextItems.push(await applyPatchToItem(current, patch, tvdbApiKey, prefetchedEpisodeMap));
    updatedCount += 1;
  }

  if (updatedCount === 0) {
    throw new Error('No matching queue items found for bulk patch.');
  }
  return { nextItems, updatedCount };
}

export async function searchMetadataCatalog(
  config: AppConfig,
  preferredLanguages: readonly MetadataLanguageCode[],
  params: {
    readonly query: string;
    readonly year?: number;
    readonly kind: MediaKind;
    readonly imdbId?: string;
    readonly tvdbId?: string;
    readonly episodeOrder?: EpisodeOrderMode;
  }
): Promise<readonly MetadataCandidate[]> {
  const lookupOptions: MetadataLookupOptions = {
    throwOnFailure: true,
    preferredLanguages
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
    const found = await lookupMovieByImdbId(imdbRef, config.omdbApiKey, fetch, lookupOptions);
    return found ? [found] : [];
  }
  if (tvmazeRef) {
    const found = await lookupSeriesByTvmazeId(tvmazeRef, fetch, lookupOptions);
    return found ? [found] : [];
  }
  if (tvdbRef && /^\d+$/.test(tvdbRef)) {
    const found = await lookupSeriesByTvdbId(
      asTvdbId(tvdbRef),
      config.tvdbApiKey,
      fetch,
      lookupOptions
    );
    return found ? [found] : [];
  }
  if (params.kind === 'movie') {
    return searchMovies(params.query, params.year, config.omdbApiKey, fetch, lookupOptions);
  }
  return searchTvShows(params.query, config.tvdbApiKey, fetch, lookupOptions);
}

export interface ExecuteScanWorkflowOptions {
  readonly config: AppConfig;
  readonly preferredLanguages: readonly MetadataLanguageCode[];
  readonly audioPreferredLanguages: readonly AudioLanguageCode[];
  readonly autoDownloadSubtitles: boolean;
  readonly isCancelled: () => boolean;
  readonly isItemSkipped: (itemId: ItemId) => boolean;
  readonly createChildTracker: () => (child: ChildProcess | null) => void;
  readonly createScanChildTracker: (itemId: ItemId) => (child: ChildProcess | null) => void;
  readonly searchSubtitles: typeof searchSpanishSubtitlesForItem;
  readonly downloadSubtitle: typeof downloadSubtitleCandidateForItem;
  readonly onLog: (level: LogLevel, message: string) => void;
  readonly onProgress: (progress: SseProgressEvent) => void;
  readonly onInitMetadataStage: (totalItems: number) => void;
  readonly onCancelledItems: (items: readonly ScannedItem[]) => void;
  readonly onCompleted: (items: readonly ScannedItem[]) => Promise<void>;
  readonly onError: (message: string) => void;
}

async function resolveSingleItemMetadata(
  item: ScannedItem,
  config: AppConfig,
  preferredLanguages: readonly MetadataLanguageCode[],
  lookupCache: Map<string, readonly MetadataCandidate[]>,
  reportedDiagnostics: Set<string>,
  onLog: (level: LogLevel, message: string) => void
): Promise<ScannedItem> {
  const itemDiagnostics: MetadataDiagnostic[] = [];
  const lookupOptions: MetadataLookupOptions = {
    preferredLanguages,
    onLog,
    onDiagnostic: (diagnostic) => {
      itemDiagnostics.push(diagnostic);
      const dedupKey = `${diagnostic.provider}:${diagnostic.kind}`;
      if (!reportedDiagnostics.has(dedupKey)) {
        reportedDiagnostics.add(dedupKey);
        onLog('error', diagnostic.message);
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
            config.omdbApiKey,
            fetch,
            lookupOptions
          )
        : await searchTvShows(item.parsedTitle, config.tvdbApiKey, fetch, lookupOptions);
    if (fetched.length > 0 || itemDiagnostics.length === 0) {
      lookupCache.set(lookupKey, fetched);
    }
  }

  const candidates = [...item.candidates, ...fetched];
  const selectedMetadata = item.selectedMetadata ?? candidates[0];
  let episode = item.episode;
  if (item.mediaKind === 'tv' && selectedMetadata?.tvdbId && episode) {
    episode = await enrichEpisodeTitle(
      selectedMetadata.tvdbId,
      item.episodeOrder,
      episode,
      config.tvdbApiKey,
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

async function autoDownloadMissingSpanishSubtitles(
  scanJobId: JobId,
  items: readonly ScannedItem[],
  options: ExecuteScanWorkflowOptions
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
  const workerCount = Math.min(SUBTITLE_DOWNLOAD_CONCURRENCY, missingIndices.length);
  const slotTasks: Array<ActiveParallelTask | undefined> = Array.from(
    { length: workerCount },
    () => undefined
  );
  let completed = 0;
  const total = missingIndices.length;

  const emitSubProgress = (): void => {
    options.onProgress({
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
    SUBTITLE_DOWNLOAD_CONCURRENCY,
    async (idx, _poolIdx, slot) => {
      const item = result[idx]!;
      slotTasks[slot] = { slot, fileName: item.fileName, itemId: item.id };
      emitSubProgress();
      try {
        const candidates = await options.searchSubtitles(
          item,
          options.config,
          undefined,
          options.onLog
        );
        const best = candidates[0];
        if (!best) {
          result[idx] = { ...item, subtitleStatus: { status: 'not_found' } };
        } else {
          const downloaded = await options.downloadSubtitle(item, best, options.config);
          result[idx] = attachDownloadedSubtitle(item, downloaded, best);
          options.onLog(
            'info',
            `Auto-downloaded spa subtitle for ${item.fileName} (${best.provider}, ${best.variant})`
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result[idx] = { ...item, subtitleStatus: { status: 'failed', message: msg } };
        options.onLog('warn', `Subtitle auto-download skipped for ${item.fileName}: ${msg}`);
      } finally {
        slotTasks[slot] = undefined;
        completed += 1;
        emitSubProgress();
      }
    },
    options.isCancelled
  );
  return result;
}

export async function executeScanWorkflow(options: ExecuteScanWorkflowOptions): Promise<void> {
  const scanJobId = asJobId('scan');
  const lookupCache = new Map<string, readonly MetadataCandidate[]>();
  try {
    options.onLog('info', `Scanning ${options.config.inputDir}...`);
    const rawScanned = await scanInputDirectory(
      options.config.inputDir,
      probeMedia,
      options.isCancelled,
      {
        configDir: options.config.configDir,
        audioPreferredLanguages: options.audioPreferredLanguages,
        onProgress: (completed, total): void => {
          if (options.isCancelled()) {
            return;
          }
          options.onProgress({
            jobId: scanJobId,
            activeTasks: [],
            totalItems: total,
            completedItems: completed,
            percent:
              total > 0 ? Math.min(PERCENT_MAX, Math.round((completed / total) * PERCENT_MAX)) : 0,
            stage: 'scanning',
            stageLabel: `Probing media (${String(completed)}/${String(total)})`
          });
        }
      }
    );
    if (options.isCancelled()) {
      options.onCancelledItems(rawScanned);
      return;
    }

    const scanStartedAtMs = performance.now();
    const scanned = await enrichItemsWithAudioAnalysis(
      rawScanned,
      options.config.configDir,
      async (filePath, streamOrder, durationSeconds, onProgress, itemId) => {
        const tracker =
          itemId !== undefined
            ? options.createScanChildTracker(itemId)
            : options.createChildTracker();
        try {
          return await analyzeAudioVolume(
            filePath,
            streamOrder,
            durationSeconds,
            onProgress,
            tracker
          );
        } catch (err) {
          if (itemId !== undefined && options.isItemSkipped(itemId)) {
            throw err;
          }
          const msg = err instanceof Error ? err.message : String(err);
          options.onLog(
            'warn',
            `Audio analysis skipped for "${path.basename(filePath)}" (stream #${String(streamOrder)}): ${msg}`
          );
          throw err;
        }
      },
      (completed, total, activeTasks, overallFraction, activeFraction): void => {
        if (options.isCancelled()) {
          return;
        }
        const effectiveFraction = overallFraction ?? (total > 0 ? completed / total : 1);
        const etaFraction = activeFraction ?? effectiveFraction;
        const percent = Math.min(PERCENT_MAX, Math.round(effectiveFraction * PERCENT_MAX));
        const elapsedSec = (performance.now() - scanStartedAtMs) / MS_PER_SECOND;
        const etaSeconds =
          etaFraction > MIN_ETA_FRACTION &&
          completed < total &&
          elapsedSec >= MIN_ETA_ELAPSED_SECONDS
            ? Math.max(0, Math.round((elapsedSec * (1 - etaFraction)) / etaFraction))
            : undefined;
        options.onProgress({
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
      options.isCancelled,
      (stats): void => {
        const prunedSuffix = stats.pruned > 0 ? `, ${String(stats.pruned)} expired pruned` : '';
        options.onLog(
          'info',
          `Audio scan cache: ${String(stats.cacheHits)} cached, ${String(stats.analyzed)} analyzed${prunedSuffix}.`
        );
      },
      options.isItemSkipped
    );
    if (options.isCancelled()) {
      options.onCancelledItems(scanned);
      return;
    }

    const enriched: ScannedItem[] = [];
    const reportedDiagnostics = new Set<string>();
    options.onInitMetadataStage(scanned.length);

    for (const item of scanned) {
      if (options.isCancelled()) {
        break;
      }
      const startPercent =
        scanned.length > 0 ? Math.round((enriched.length / scanned.length) * PERCENT_MAX) : 0;
      options.onProgress({
        jobId: scanJobId,
        activeTasks: [{ slot: 0, itemId: item.id, fileName: item.fileName }],
        totalItems: scanned.length,
        completedItems: enriched.length,
        percent: startPercent,
        stage: 'scanning',
        stageLabel: `Fetching metadata (${String(enriched.length)}/${String(scanned.length)})`
      });

      const updatedItem = await resolveSingleItemMetadata(
        item,
        options.config,
        options.preferredLanguages,
        lookupCache,
        reportedDiagnostics,
        options.onLog
      );
      if (options.isCancelled()) {
        break;
      }
      enriched.push(updatedItem);

      const donePercent =
        scanned.length > 0
          ? Math.round((enriched.length / scanned.length) * PERCENT_MAX)
          : PERCENT_MAX;
      options.onProgress({
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

    if (options.isCancelled()) {
      options.onCancelledItems(enriched);
      return;
    }

    const withSubtitles = options.autoDownloadSubtitles
      ? await autoDownloadMissingSpanishSubtitles(scanJobId, enriched, options)
      : [...enriched];

    if (options.isCancelled()) {
      options.onCancelledItems(withSubtitles);
      return;
    }

    await options.onCompleted(withSubtitles);
  } catch (err) {
    if (options.isCancelled()) {
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    options.onError(msg);
  }
}
