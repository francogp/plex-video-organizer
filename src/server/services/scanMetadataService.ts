import type { ChildProcess } from 'node:child_process';
import path from 'node:path';

import { runSlotWorkerPool } from '../../domain/concurrency.ts';
import { computeLinearFallbackEta } from '../../domain/eta.ts';
import { mergeDeduplicatedCandidates, parseProviderReference } from '../../domain/plexFormatter.ts';
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
import { buildMountPathsMap, type AppConfig } from '../config.ts';
import type { EtaPredictor } from './etaPredictor.ts';
import {
  buildAllMountLibraryLookup,
  findCandidateInMounts,
  type MountLibraryLookup
} from './libraryCollision.ts';
import { analyzeAudioVolume, probeMedia } from './media/ffmpegRunner.ts';
import { lookupMovieByImdbId, searchMovies } from './metadata/imdbClient.ts';
import {
  fetchEpisodeTitleMap,
  lookupSeriesByTvmazeId,
  lookupSeriesByTvdbId,
  searchTvShows
} from './metadata/tvdbClient.ts';
import { cleanTitleFromName, enrichItemsWithAudioAnalysis, scanInputDirectory } from './scanner.ts';
import {
  downloadSubtitleCandidateForItem,
  hasSpanishSubtitles,
  searchSpanishSubtitlesForItem
} from './subtitles/subtitleService.ts';

const PERCENT_MAX = 100;
const MS_PER_SECOND = 1000;
const SUBTITLE_DOWNLOAD_CONCURRENCY = 3;

function tvYearMatchScore(candidateYear: number | undefined, parsedYear: number): number {
  if (candidateYear === parsedYear) {
    return 0;
  }
  if (candidateYear !== undefined && Math.abs(candidateYear - parsedYear) <= 1) {
    return 1;
  }
  return 2;
}

function rankTvCandidatesByYear(
  candidates: readonly MetadataCandidate[],
  parsedYear?: number
): readonly MetadataCandidate[] {
  if (!parsedYear || candidates.length <= 1) {
    return candidates;
  }
  return [...candidates].sort(
    (a, b) => tvYearMatchScore(a.year, parsedYear) - tvYearMatchScore(b.year, parsedYear)
  );
}

function annotateCandidateWithMount(
  cand: MetadataCandidate,
  mountLookup: MountLibraryLookup
): MetadataCandidate {
  const presentInLibrary = cand.presentInLibrary ?? findCandidateInMounts(cand, mountLookup);
  return presentInLibrary ? { ...cand, presentInLibrary } : cand;
}

function annotateAndPrioritizeCandidates(
  candidates: readonly MetadataCandidate[],
  mountLookup: MountLibraryLookup,
  mediaKind: MediaKind,
  parsedYear?: number
): MetadataCandidate[] {
  const annotated = candidates.map((cand) => annotateCandidateWithMount(cand, mountLookup));
  const yearRanked = mediaKind === 'tv' ? rankTvCandidatesByYear(annotated, parsedYear) : annotated;
  return [...yearRanked].sort(
    (a, b) => (a.presentInLibrary ? 0 : 1) - (b.presentInLibrary ? 0 : 1)
  );
}

function annotateSelectedMetadata(
  selected: MetadataCandidate | undefined,
  mountLookup: MountLibraryLookup
): MetadataCandidate | undefined {
  return selected ? annotateCandidateWithMount(selected, mountLookup) : undefined;
}

/** Annotates persisted queue items' candidates and selectedMetadata with live mount presence. */
export async function annotateQueueItemsWithMounts(
  items: readonly ScannedItem[],
  config: AppConfig
): Promise<ScannedItem[]> {
  if (items.length === 0) {
    return [];
  }
  const mountLookup = await buildAllMountLibraryLookup(buildMountPathsMap(config));
  return items.map((item): ScannedItem => {
    const candidates = annotateAndPrioritizeCandidates(
      item.candidates,
      mountLookup,
      item.mediaKind,
      item.parsedYear
    );
    const selectedMetadata = annotateSelectedMetadata(item.selectedMetadata, mountLookup);
    return { ...item, candidates, selectedMetadata };
  });
}

function buildFallbackSearchQueries(parsedTitle: string, fileName: string): readonly string[] {
  const seen = new Set<string>();
  const queries: string[] = [];
  const pushQuery = (q: string): void => {
    const trimmed = q.trim();
    if (!trimmed || /^\d+$/.test(trimmed)) {
      return;
    }
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      queries.push(trimmed);
    }
  };

  pushQuery(parsedTitle);
  const baseNoExt = path.basename(fileName, path.extname(fileName));
  const fileTitle = cleanTitleFromName(baseNoExt).title;
  pushQuery(fileTitle);

  const words = parsedTitle.trim().split(/\s+/).filter(Boolean);
  for (let len = words.length - 1; len >= 1; len -= 1) {
    pushQuery(words.slice(0, len).join(' '));
  }
  for (let start = 1; start < words.length; start += 1) {
    pushQuery(words.slice(start).join(' '));
  }
  return queries;
}

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
  if (patch.candidates || patch.selectedMetadata) {
    nextCandidates = mergeDeduplicatedCandidates(
      patch.selectedMetadata ? [patch.selectedMetadata] : [],
      patch.candidates ?? [],
      current.candidates
    );
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

const PROVIDER_PRIORITY_TV: Readonly<Record<MetadataCandidate['source'], number>> = {
  tvdb: 0,
  tvmaze: 1,
  imdb: 2,
  omdb: 3,
  plexmatch: 4,
  manual: 5
};

const PROVIDER_PRIORITY_MOVIE: Readonly<Record<MetadataCandidate['source'], number>> = {
  imdb: 0,
  omdb: 1,
  tvdb: 2,
  tvmaze: 3,
  plexmatch: 4,
  manual: 5
};

function sortCandidatesByMediaKind(
  candidates: readonly MetadataCandidate[],
  kind: MediaKind
): MetadataCandidate[] {
  const priorityMap = kind === 'tv' ? PROVIDER_PRIORITY_TV : PROVIDER_PRIORITY_MOVIE;
  return [...candidates].sort((a, b) => priorityMap[a.source] - priorityMap[b.source]);
}

function unifyTvSeriesMetadataByTvdbId(items: readonly ScannedItem[]): readonly ScannedItem[] {
  const byTvdbId = new Map<TvdbId, ScannedItem[]>();
  for (const item of items) {
    const tvdbId = item.mediaKind === 'tv' ? item.selectedMetadata?.tvdbId : undefined;
    if (!tvdbId) {
      continue;
    }
    const group = byTvdbId.get(tvdbId) ?? [];
    group.push(item);
    byTvdbId.set(tvdbId, group);
  }

  const canonicalByTvdbId = new Map<
    TvdbId,
    {
      readonly selected: MetadataCandidate;
      readonly candidates: readonly MetadataCandidate[];
    }
  >();
  for (const [tvdbId, group] of byTvdbId.entries()) {
    if (group.length < 2) {
      continue;
    }
    const allCandidates = mergeDeduplicatedCandidates(
      ...group.map((g) => g.candidates),
      group.map((g) => g.selectedMetadata).filter((c): c is MetadataCandidate => c !== undefined)
    );
    const preferred =
      group.find((g) => g.selectedMetadata?.source === 'tvdb')?.selectedMetadata ??
      allCandidates.find((c) => c.source === 'tvdb') ??
      group[0]?.selectedMetadata;
    if (!preferred) {
      continue;
    }
    canonicalByTvdbId.set(tvdbId, {
      selected: preferred,
      candidates: allCandidates
    });
  }

  if (canonicalByTvdbId.size === 0) {
    return items;
  }
  return items.map((item) => {
    const tvdbId = item.mediaKind === 'tv' ? item.selectedMetadata?.tvdbId : undefined;
    const unified = tvdbId ? canonicalByTvdbId.get(tvdbId) : undefined;
    if (!unified) {
      return item;
    }
    return {
      ...item,
      selectedMetadata: unified.selected,
      candidates: unified.candidates,
      category: resolveCategoryFromMetadata(item.mediaKind, unified.selected, item.category)
    };
  });
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

  const mountLookup = await buildAllMountLibraryLookup(buildMountPathsMap(config));
  const finalizeSearch = (list: readonly MetadataCandidate[]): readonly MetadataCandidate[] =>
    annotateAndPrioritizeCandidates(list, mountLookup, params.kind, params.year);

  if (imdbRef && (params.kind === 'movie' || !params.query.trim())) {
    const found = await lookupMovieByImdbId(imdbRef, config.omdbApiKey, fetch, lookupOptions);
    if (found) {
      return finalizeSearch([found]);
    }
    const titleQuery = params.query.trim();
    if (!titleQuery || params.kind !== 'movie') {
      return [];
    }
    const byTitle = await searchMovies(titleQuery, params.year, config.omdbApiKey, fetch, {
      ...lookupOptions,
      throwOnFailure: false
    });
    return finalizeSearch(sortCandidatesByMediaKind(byTitle, 'movie'));
  }
  if (tvmazeRef) {
    const found = await lookupSeriesByTvmazeId(tvmazeRef, fetch, lookupOptions);
    return found ? finalizeSearch([found]) : [];
  }
  if (tvdbRef && /^\d+$/.test(tvdbRef)) {
    const typedTvdbId = asTvdbId(tvdbRef);
    const [primaryFound, tvmazeFound, byTitle] = await Promise.all([
      lookupSeriesByTvdbId(typedTvdbId, config.tvdbApiKey, fetch, lookupOptions),
      config.tvdbApiKey
        ? lookupSeriesByTvdbId(typedTvdbId, undefined, fetch, {
            ...lookupOptions,
            throwOnFailure: false
          })
        : Promise.resolve(undefined),
      params.query.trim() && params.kind === 'tv'
        ? searchTvShows(params.query.trim(), config.tvdbApiKey, fetch, {
            ...lookupOptions,
            throwOnFailure: false
          })
        : Promise.resolve([])
    ]);
    const merged = mergeDeduplicatedCandidates(
      primaryFound ? [primaryFound] : [],
      tvmazeFound ? [tvmazeFound] : [],
      byTitle
    );
    return finalizeSearch(sortCandidatesByMediaKind(merged, 'tv'));
  }
  if (params.kind === 'movie') {
    const movies = await searchMovies(
      params.query,
      params.year,
      config.omdbApiKey,
      fetch,
      lookupOptions
    );
    return finalizeSearch(sortCandidatesByMediaKind(movies, 'movie'));
  }
  const [tvPrimary, tvSecondary] = await Promise.all([
    searchTvShows(params.query, config.tvdbApiKey, fetch, lookupOptions),
    config.tvdbApiKey
      ? searchTvShows(params.query, undefined, fetch, {
          ...lookupOptions,
          throwOnFailure: false
        })
      : Promise.resolve([])
  ]);
  return finalizeSearch(
    sortCandidatesByMediaKind(mergeDeduplicatedCandidates(tvPrimary, tvSecondary), 'tv')
  );
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
  readonly etaPredictor?: EtaPredictor;
}

async function resolveSingleItemMetadata(
  item: ScannedItem,
  config: AppConfig,
  preferredLanguages: readonly MetadataLanguageCode[],
  lookupCache: Map<string, readonly MetadataCandidate[]>,
  mountLookup: MountLibraryLookup,
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

  const queries = buildFallbackSearchQueries(item.parsedTitle, item.fileName);
  let fetched: readonly MetadataCandidate[] = [];
  for (const query of queries) {
    const lookupKey = `${item.mediaKind}:${query.toLowerCase()}:${String(item.parsedYear ?? '')}`;
    let result = lookupCache.get(lookupKey);
    if (result === undefined) {
      const rawResult =
        item.mediaKind === 'movie'
          ? await searchMovies(query, item.parsedYear, config.omdbApiKey, fetch, lookupOptions)
          : await searchTvShows(query, config.tvdbApiKey, fetch, lookupOptions);
      result = annotateAndPrioritizeCandidates(
        rawResult,
        mountLookup,
        item.mediaKind,
        item.parsedYear
      );
      if (result.length > 0 || itemDiagnostics.length === 0) {
        lookupCache.set(lookupKey, result);
      }
    }
    if (result.length > 0) {
      fetched = result;
      break;
    }
  }

  const candidates = annotateAndPrioritizeCandidates(
    [...item.candidates, ...fetched],
    mountLookup,
    item.mediaKind,
    item.parsedYear
  );
  const selectedMetadata = annotateSelectedMetadata(
    item.selectedMetadata ?? candidates[0],
    mountLookup
  );
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
        etaPredictor: options.etaPredictor,
        onProgress: (completed, total): void => {
          if (options.isCancelled()) {
            return;
          }
          const etaEstimate = options.etaPredictor?.getEstimate();
          options.onProgress({
            jobId: scanJobId,
            activeTasks: [],
            totalItems: total,
            completedItems: completed,
            percent:
              total > 0 ? Math.min(PERCENT_MAX, Math.round((completed / total) * PERCENT_MAX)) : 0,
            stage: 'scanning',
            stageLabel: `Probing media (${String(completed)}/${String(total)})`,
            etaSeconds: etaEstimate?.etaSeconds,
            etaState: etaEstimate?.etaState
          });
        }
      }
    );
    if (options.isCancelled()) {
      options.onCancelledItems(rawScanned);
      return;
    }
    if (options.etaPredictor) {
      options.onLog('info', options.etaPredictor.formatBaselineSummaryLog());
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
        const etaEstimate = options.etaPredictor?.getEstimate();
        const etaSeconds = options.etaPredictor
          ? etaEstimate?.etaSeconds
          : computeLinearFallbackEta(etaFraction, completed, total, elapsedSec);
        options.onProgress({
          jobId: scanJobId,
          activeTasks,
          totalItems: total,
          completedItems: completed,
          percent,
          stage: 'scanning',
          stageLabel: `Analyzing audio (${String(completed)}/${String(total)})`,
          etaSeconds,
          etaState: etaEstimate?.etaState
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
      options.isItemSkipped,
      options.etaPredictor
    );
    if (options.isCancelled()) {
      options.onCancelledItems(scanned);
      return;
    }

    const enriched: ScannedItem[] = [];
    const mountLookup = await buildAllMountLibraryLookup(buildMountPathsMap(options.config));
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
        mountLookup,
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

    const unifiedEnriched = unifyTvSeriesMetadataByTvdbId(enriched);
    const withSubtitles = options.autoDownloadSubtitles
      ? await autoDownloadMissingSpanishSubtitles(scanJobId, unifiedEnriched, options)
      : unifiedEnriched;

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
