import fs from 'node:fs/promises';
import path from 'node:path';

import { runSlotWorkerPool } from '../../domain/concurrency.ts';
import {
  CASE_TMP_SUFFIX,
  DEFAULT_PREFERRED_LANGUAGES,
  OUTPUT_CATEGORIES,
  isActivePartialDownloadName,
  isHiddenOrTempEntryName,
  isVideoExtension
} from '../../domain/constants.ts';
import {
  buildMovieVerificationEntry,
  buildTvVerificationEntry,
  parseLibraryRootName,
  type SeasonDirFiles
} from '../../domain/libraryVerifier.ts';
import { resolveContainedOutputPath } from '../../domain/plexFormatter.ts';
import {
  asVerifierEntryId,
  collectActiveTasks,
  type ActiveParallelTask,
  type ConflictComparison,
  type ConflictDecision,
  type MediaProbeSummary,
  type MetadataCandidate,
  type MetadataLanguageCode,
  type MetadataLookupOptions,
  type OutputCategory,
  type VerifierEntry,
  type VerifierEntryId,
  type VerifierProgress,
  type VerifierRenameKind,
  type VerifierRenameStep,
  type VerifierSummary
} from '../../domain/types.ts';
import { buildMountPathsMap, type AppConfig } from '../config.ts';
import { buildExistingFileConflictComparison } from './libraryCollision.ts';
import { probeMedia } from './media/ffmpegRunner.ts';
import { lookupMovieByImdbId, searchMovies } from './metadata/imdbClient.ts';
import {
  fetchEpisodeTitleMap,
  lookupSeriesByTvdbId,
  searchTvShows
} from './metadata/tvdbClient.ts';
import { type ScanCacheDb, openScanCacheDb, probeVideoWithCache } from './scanCacheDb.ts';

const VERIFIER_CONCURRENCY = 4;

function isTvCategory(category: OutputCategory): boolean {
  return category === 'tv-shows' || category === 'animated-series';
}

function stepOrder(kind: VerifierRenameKind): number {
  if (kind === 'file') {
    return 0;
  }
  if (kind === 'season-dir') {
    return 1;
  }
  return 2;
}

export type VerifierLogCallback = (level: 'info' | 'warn' | 'error', message: string) => void;
export type VerifierProgressCallback = (progress: VerifierProgress) => void;

export interface VerifierMetadataDeps {
  readonly lookupSeriesByTvdbId?: typeof lookupSeriesByTvdbId;
  readonly searchTvShows?: typeof searchTvShows;
  readonly fetchEpisodeTitleMap?: typeof fetchEpisodeTitleMap;
  readonly lookupMovieByImdbId?: typeof lookupMovieByImdbId;
  readonly searchMovies?: typeof searchMovies;
}

export interface VerifierScanResult {
  readonly summary: VerifierSummary;
  readonly entries: readonly VerifierEntry[];
}

export interface VerifierFixFailure {
  readonly id: VerifierEntry['id'];
  readonly currentRootName: string;
  readonly error: string;
}

export interface VerifierFixResult {
  readonly fixedEntries: number;
  readonly renamedSteps: number;
  readonly renamedFiles: number;
  readonly renamedDirs: number;
  readonly failures: readonly VerifierFixFailure[];
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

const MIN_FALLBACK_TITLE_SIMILARITY = 0.75;

function normalizeTitleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token): boolean => token.length > 0);
}

function isPlausibleTitleFallback(queryTitle: string, candidateTitle: string): boolean {
  const qTokens = normalizeTitleTokens(queryTitle);
  const cTokens = normalizeTitleTokens(candidateTitle);
  if (qTokens.length === 0 || cTokens.length === 0) {
    return false;
  }
  if (qTokens.join(' ') === cTokens.join(' ')) {
    return true;
  }
  const qSet = new Set(qTokens);
  const cSet = new Set(cTokens);
  let intersection = 0;
  for (const token of qSet) {
    if (cSet.has(token)) {
      intersection++;
    }
  }
  const union = new Set([...qSet, ...cSet]).size;
  return union > 0 && intersection / union >= MIN_FALLBACK_TITLE_SIMILARITY;
}

function pickBestCandidate(
  candidates: readonly MetadataCandidate[],
  preferredYear?: number
): MetadataCandidate | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  if (preferredYear !== undefined) {
    const yearMatch = candidates.find((c): boolean => c.year === preferredYear);
    if (yearMatch) {
      return yearMatch;
    }
  }
  return candidates[0];
}

async function resolvePlausibleFallback(
  searchFn: () => Promise<readonly MetadataCandidate[]>,
  resolvedTitle: string,
  parsedYear: number | undefined
): Promise<{ readonly title: string; readonly year: number | undefined }> {
  const candidates = await searchFn();
  const best = pickBestCandidate(
    candidates.filter((c) => isPlausibleTitleFallback(resolvedTitle, c.title)),
    parsedYear
  );
  if (!best) {
    return { title: resolvedTitle, year: parsedYear };
  }
  return {
    title: best.title || resolvedTitle,
    year: parsedYear ?? best.year
  };
}

async function resolveTvMetadata(
  folderName: string,
  config: AppConfig,
  deps: Required<VerifierMetadataDeps>,
  onLog?: VerifierLogCallback,
  lookupOptions?: MetadataLookupOptions
): Promise<{
  readonly resolvedTitle: string;
  readonly resolvedYear?: number;
  readonly tvdbId?: ReturnType<typeof parseLibraryRootName>['tvdbId'];
  readonly tmdbId?: ReturnType<typeof parseLibraryRootName>['tmdbId'];
  readonly edition?: string;
  readonly episodeTitles?: ReadonlyMap<string, string>;
  readonly unresolvedMetadata: boolean;
}> {
  const parsed = parseLibraryRootName(folderName);
  let resolvedTitle = parsed.cleanTitle || folderName;
  let resolvedYear = parsed.year;
  let tvdbId = parsed.tvdbId;
  const tmdbId = parsed.tmdbId;
  let unresolvedMetadata = false;

  if (tvdbId) {
    if (!resolvedYear || !parsed.cleanTitle) {
      const lookedUp = await deps.lookupSeriesByTvdbId(
        tvdbId,
        config.tvdbApiKey,
        fetch,
        lookupOptions
      );
      if (lookedUp) {
        resolvedTitle = lookedUp.title || resolvedTitle;
        resolvedYear = resolvedYear ?? lookedUp.year;
      } else if (parsed.cleanTitle) {
        const fallback = await resolvePlausibleFallback(
          () => deps.searchTvShows(resolvedTitle, config.tvdbApiKey, fetch, lookupOptions),
          resolvedTitle,
          parsed.year
        );
        resolvedTitle = fallback.title;
        resolvedYear = resolvedYear ?? fallback.year;
      }
      if (!resolvedYear) {
        unresolvedMetadata = true;
      }
    }
  } else if (!tmdbId) {
    const candidates = await deps.searchTvShows(
      resolvedTitle,
      config.tvdbApiKey,
      fetch,
      lookupOptions
    );
    const best = pickBestCandidate(candidates, parsed.year);
    if (best) {
      resolvedTitle = best.title;
      resolvedYear = resolvedYear ?? best.year;
      tvdbId = best.tvdbId;
    } else {
      unresolvedMetadata = true;
    }
  }

  let episodeTitles: ReadonlyMap<string, string> | undefined;
  if (tvdbId) {
    try {
      episodeTitles = await deps.fetchEpisodeTitleMap(
        tvdbId,
        'aired',
        config.tvdbApiKey,
        fetch,
        lookupOptions
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onLog?.('warn', `Failed to fetch episode titles for ${folderName}: ${msg}`);
    }
  }

  return {
    resolvedTitle,
    resolvedYear,
    tvdbId,
    tmdbId,
    edition: parsed.edition,
    episodeTitles,
    unresolvedMetadata
  };
}

async function resolveMovieMetadata(
  folderName: string,
  config: AppConfig,
  deps: Required<VerifierMetadataDeps>,
  lookupOptions?: MetadataLookupOptions
): Promise<{
  readonly resolvedTitle: string;
  readonly resolvedYear?: number;
  readonly imdbId?: ReturnType<typeof parseLibraryRootName>['imdbId'];
  readonly tmdbId?: ReturnType<typeof parseLibraryRootName>['tmdbId'];
  readonly edition?: string;
  readonly unresolvedMetadata: boolean;
}> {
  const parsed = parseLibraryRootName(folderName);
  let resolvedTitle = parsed.cleanTitle || folderName;
  let resolvedYear = parsed.year;
  let imdbId = parsed.imdbId;
  let tmdbId = parsed.tmdbId;
  let unresolvedMetadata = false;

  if (imdbId) {
    if (!resolvedYear || !parsed.cleanTitle) {
      const lookedUp = await deps.lookupMovieByImdbId(
        imdbId,
        config.omdbApiKey,
        fetch,
        lookupOptions
      );
      if (lookedUp) {
        resolvedTitle = lookedUp.title || resolvedTitle;
        resolvedYear = resolvedYear ?? lookedUp.year;
      } else if (parsed.cleanTitle) {
        const fallback = await resolvePlausibleFallback(
          () =>
            deps.searchMovies(resolvedTitle, parsed.year, config.omdbApiKey, fetch, lookupOptions),
          resolvedTitle,
          parsed.year
        );
        resolvedTitle = fallback.title;
        resolvedYear = resolvedYear ?? fallback.year;
      }
      if (!resolvedYear) {
        unresolvedMetadata = true;
      }
    }
  } else if (!tmdbId || !resolvedYear) {
    const candidates = await deps.searchMovies(
      resolvedTitle,
      parsed.year,
      config.omdbApiKey,
      fetch,
      lookupOptions
    );
    const best = pickBestCandidate(candidates, parsed.year);
    if (best) {
      resolvedTitle = best.title;
      resolvedYear = resolvedYear ?? best.year;
      imdbId = best.imdbId;
      tmdbId = tmdbId ?? best.tmdbId;
    } else {
      unresolvedMetadata = true;
    }
  }

  return {
    resolvedTitle,
    resolvedYear,
    imdbId,
    tmdbId,
    edition: parsed.edition,
    unresolvedMetadata
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, slot: number) => Promise<R>
): Promise<readonly R[]> {
  const results: R[] = [];
  await runSlotWorkerPool(items, limit, async (item, idx, slot) => {
    results[idx] = await worker(item, slot);
  });
  return results;
}

function computePercent(completed: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round((completed / total) * 100)));
}

/** Scans all configured output libraries and returns only non-compliant entries plus full analysis counts. */
function computeEtaSeconds(
  startedAtMs: number,
  completed: number,
  total: number
): number | undefined {
  if (completed <= 0 || completed >= total) {
    return undefined;
  }
  const elapsedSeconds = (performance.now() - startedAtMs) / 1000;
  if (elapsedSeconds <= 0) {
    return undefined;
  }
  const remaining = total - completed;
  return Math.max(0, Math.round((elapsedSeconds / completed) * remaining));
}

export async function scanLibrariesForCompliance(
  config: AppConfig,
  onLog?: VerifierLogCallback,
  metadataDeps: VerifierMetadataDeps = {},
  onProgress?: VerifierProgressCallback,
  preferredLanguages: readonly MetadataLanguageCode[] = DEFAULT_PREFERRED_LANGUAGES,
  recalculateTags = false
): Promise<VerifierScanResult> {
  const deps: Required<VerifierMetadataDeps> = {
    lookupSeriesByTvdbId: metadataDeps.lookupSeriesByTvdbId ?? lookupSeriesByTvdbId,
    searchTvShows: metadataDeps.searchTvShows ?? searchTvShows,
    fetchEpisodeTitleMap: metadataDeps.fetchEpisodeTitleMap ?? fetchEpisodeTitleMap,
    lookupMovieByImdbId: metadataDeps.lookupMovieByImdbId ?? lookupMovieByImdbId,
    searchMovies: metadataDeps.searchMovies ?? searchMovies
  };

  const mountPaths = buildMountPathsMap(config);
  const discovered: {
    readonly category: OutputCategory;
    readonly libraryRoot: string;
    readonly rootDirs: readonly string[];
  }[] = [];
  let totalRootFolders = 0;

  for (const category of OUTPUT_CATEGORIES) {
    const libraryRoot = mountPaths[category];
    try {
      const dirents = await fs.readdir(libraryRoot, { withFileTypes: true });
      const rootDirs = dirents
        .filter((d): boolean => d.isDirectory() && !isHiddenOrTempEntryName(d.name))
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b));
      discovered.push({ category, libraryRoot, rootDirs });
      totalRootFolders += rootDirs.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onLog?.('warn', `Skipping inaccessible library ${category} (${libraryRoot}): ${msg}`);
    }
  }

  const totalLibraries = discovered.length;
  const totalUnits = totalRootFolders > 0 ? totalRootFolders : Math.max(1, totalLibraries);
  const startedAtMs = performance.now();
  let completedUnits = 0;
  onProgress?.({
    completed: 0,
    total: totalUnits,
    percent: 0,
    stageLabel: 'Discovering libraries...',
    activeTasks: []
  });

  const allEntries: VerifierEntry[] = [];
  const reportedDiagnostics = new Set<string>();
  const lookupOptions: MetadataLookupOptions = {
    preferredLanguages,
    onLog: (level, message) => onLog?.(level, message),
    onDiagnostic: (diagnostic) => {
      const key = `${diagnostic.provider}:${diagnostic.kind}`;
      if (!reportedDiagnostics.has(key)) {
        reportedDiagnostics.add(key);
        onLog?.('error', diagnostic.message);
      }
    }
  };
  let totalSeasonFolders = 0;
  let totalFiles = 0;
  const probeDb: ScanCacheDb | undefined = recalculateTags
    ? await openScanCacheDb(config.configDir)
    : undefined;

  try {
    for (const { category, libraryRoot, rootDirs } of discovered) {
      onLog?.('info', `Scanning ${category}: ${String(rootDirs.length)} folder(s)`);

      const isTv = isTvCategory(category);
      const slotCount = Math.min(VERIFIER_CONCURRENCY, Math.max(1, rootDirs.length));
      const activeBySlot = Array.from<ActiveParallelTask | undefined>({ length: slotCount });
      const emitFolderProgress = (): void => {
        if (totalRootFolders <= 0) {
          return;
        }
        onProgress?.({
          completed: completedUnits,
          total: totalUnits,
          percent: computePercent(completedUnits, totalUnits),
          stageLabel: category,
          activeTasks: collectActiveTasks(activeBySlot),
          etaSeconds: computeEtaSeconds(startedAtMs, completedUnits, totalUnits)
        });
      };

      const categoryEntries = await mapWithConcurrency(
        rootDirs,
        VERIFIER_CONCURRENCY,
        async (rootName, slot): Promise<VerifierEntry | null> => {
          activeBySlot[slot] = { slot, fileName: rootName };
          emitFolderProgress();

          const rootPath = path.join(libraryRoot, rootName);
          if (await isDirectoryEmptyRecursive(rootPath)) {
            activeBySlot[slot] = undefined;
            completedUnits += 1;
            emitFolderProgress();
            return {
              id: asVerifierEntryId(`${category}:${rootName}`),
              category,
              mediaKind: isTv ? 'tv' : 'movie',
              currentRootName: rootName,
              expectedRootName: 'Delete empty directory',
              issues: ['EMPTY_DIRECTORY'],
              steps: [
                {
                  kind: 'delete-dir',
                  fromRelative: rootName,
                  toRelative: '(delete)'
                }
              ]
            };
          }

          const childDirents = await fs.readdir(rootPath, { withFileTypes: true });

          let entry: VerifierEntry | null;
          if (isTv) {
            const seasonSubdirs = childDirents
              .filter((d): boolean => d.isDirectory() && !isHiddenOrTempEntryName(d.name))
              .map((d) => d.name)
              .sort((a, b) => a.localeCompare(b));
            totalSeasonFolders += seasonSubdirs.length;
            totalFiles += childDirents.filter(
              (d): boolean => d.isFile() && !isHiddenOrTempEntryName(d.name)
            ).length;

            const seasonDirs: SeasonDirFiles[] = [];
            for (const seasonName of seasonSubdirs) {
              const seasonPath = path.join(rootPath, seasonName);
              const seasonChildren = await fs.readdir(seasonPath, { withFileTypes: true });
              const files = seasonChildren
                .filter((d): boolean => d.isFile() && !isHiddenOrTempEntryName(d.name))
                .map((d) => d.name);
              totalFiles += files.length;
              seasonDirs.push({ dirName: seasonName, files });
            }

            const meta = await resolveTvMetadata(rootName, config, deps, onLog, lookupOptions);
            entry = buildTvVerificationEntry({
              category,
              currentRootName: rootName,
              resolvedTitle: meta.resolvedTitle,
              resolvedYear: meta.resolvedYear,
              tvdbId: meta.tvdbId,
              tmdbId: meta.tmdbId,
              edition: meta.edition,
              episodeTitles: meta.episodeTitles,
              seasonDirs,
              unresolvedMetadata: meta.unresolvedMetadata
            });
          } else {
            const files = childDirents
              .filter((d): boolean => d.isFile() && !isHiddenOrTempEntryName(d.name))
              .map((d) => d.name);
            totalFiles += files.length;
            const meta = await resolveMovieMetadata(rootName, config, deps, lookupOptions);
            let probe;
            if (recalculateTags) {
              const firstVideo = files.find((f) => isVideoExtension(path.extname(f).toLowerCase()));
              if (firstVideo) {
                const videoPath = path.join(rootPath, firstVideo);
                try {
                  const relativePath = `${category}/${rootName}/${firstVideo}`;
                  probe = await probeVideoWithCache(
                    probeDb,
                    videoPath,
                    relativePath,
                    probeMedia,
                    'verifier:'
                  );
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  onLog?.('warn', `FFprobe failed for ${rootName}/${firstVideo}: ${msg}`);
                }
              }
            }
            entry = buildMovieVerificationEntry({
              category,
              currentRootName: rootName,
              resolvedTitle: meta.resolvedTitle,
              resolvedYear: meta.resolvedYear,
              imdbId: meta.imdbId,
              tmdbId: meta.tmdbId,
              edition: meta.edition,
              files,
              unresolvedMetadata: meta.unresolvedMetadata,
              probe,
              recalculateTags
            });
          }

          activeBySlot[slot] = undefined;
          completedUnits += 1;
          emitFolderProgress();
          return entry;
        }
      );

      if (totalRootFolders === 0) {
        completedUnits += 1;
        onProgress?.({
          completed: completedUnits,
          total: totalUnits,
          percent: computePercent(completedUnits, totalUnits),
          stageLabel: `Scanned ${category} (0 folders)`,
          activeTasks: []
        });
      }

      for (const entry of await annotateDestinationCollisions(
        libraryRoot,
        rootDirs,
        categoryEntries,
        category,
        probeDb,
        config.configDir,
        onLog
      )) {
        allEntries.push(entry);
      }
    }
  } finally {
    probeDb?.close();
  }

  allEntries.sort((a, b) => {
    const catCmp = a.category.localeCompare(b.category);
    return catCmp !== 0 ? catCmp : a.currentRootName.localeCompare(b.currentRootName);
  });

  const issueCount = allEntries.length;
  const summary: VerifierSummary = {
    librariesScanned: totalLibraries,
    totalRootsAnalyzed: totalRootFolders,
    totalSeasonDirsAnalyzed: totalSeasonFolders,
    totalFilesAnalyzed: totalFiles,
    compliantRoots: Math.max(0, totalRootFolders - issueCount),
    issueCount,
    scannedAt: Temporal.Now.instant().toString()
  };

  return { summary, entries: allEntries };
}

const RM_RETRY_ATTEMPTS = 3;
const RM_RETRY_DELAY_MS = 40;

async function findFirstVideoInSubdir(
  rootDir: string,
  dirName: string
): Promise<{ readonly absPath: string; readonly relName: string } | null> {
  const subEntries = await fs.readdir(path.join(rootDir, dirName), { withFileTypes: true });
  subEntries.sort((a, b) => a.name.localeCompare(b.name));
  for (const sub of subEntries) {
    if (
      sub.isFile() &&
      !isHiddenOrTempEntryName(sub.name) &&
      isVideoExtension(path.extname(sub.name).toLowerCase())
    ) {
      return {
        absPath: path.join(rootDir, dirName, sub.name),
        relName: path.posix.join(dirName, sub.name)
      };
    }
  }
  return null;
}

async function findPrimaryVideoFile(
  rootDir: string
): Promise<{ readonly absPath: string; readonly relName: string } | null> {
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (isHiddenOrTempEntryName(entry.name)) {
        continue;
      }
      if (entry.isFile() && isVideoExtension(path.extname(entry.name).toLowerCase())) {
        return { absPath: path.join(rootDir, entry.name), relName: entry.name };
      }
    }
    const subdirEntries = entries.filter(
      (entry) => entry.isDirectory() && !isHiddenOrTempEntryName(entry.name)
    );
    const subdirMatches = await Promise.all(
      subdirEntries.map((entry) => findFirstVideoInSubdir(rootDir, entry.name))
    );
    return subdirMatches.find((match) => match !== null) ?? null;
  } catch {
    return null;
  }
}

async function buildVerifierCollisionComparison(
  libraryRoot: string,
  category: OutputCategory,
  entry: VerifierEntry,
  collisionTarget: string,
  probeDb: ScanCacheDb | undefined
): Promise<ConflictComparison<VerifierEntryId> | undefined> {
  const sourceRoot = path.join(libraryRoot, entry.currentRootName);
  const destRoot = path.join(libraryRoot, collisionTarget);
  const [sourceVideo, destVideo] = await Promise.all([
    findPrimaryVideoFile(sourceRoot),
    findPrimaryVideoFile(destRoot)
  ]);
  if (!sourceVideo || !destVideo) {
    return undefined;
  }
  try {
    const [incomingProbe, existingProbe]: readonly [MediaProbeSummary, MediaProbeSummary] =
      await Promise.all([
        probeVideoWithCache(
          probeDb,
          sourceVideo.absPath,
          path.posix.join(category, entry.currentRootName, sourceVideo.relName),
          probeMedia,
          'verifier:'
        ),
        probeVideoWithCache(
          probeDb,
          destVideo.absPath,
          path.posix.join(category, collisionTarget, destVideo.relName),
          probeMedia,
          'verifier:'
        )
      ]);
    return buildExistingFileConflictComparison({
      itemId: entry.id,
      sourceFileName: path.posix.join(entry.currentRootName, sourceVideo.relName),
      destinationPath: destVideo.absPath,
      existingPath: destVideo.absPath,
      incoming: incomingProbe,
      existing: existingProbe
    });
  } catch {
    return undefined;
  }
}

interface CollisionEvalContext {
  readonly libraryRoot: string;
  readonly category: OutputCategory;
  readonly existingByLower: ReadonlyMap<string, string>;
  readonly targetCounts: ReadonlyMap<string, number>;
  readonly configDir: string;
  readonly getProbeDb: (needDb: boolean) => Promise<ScanCacheDb | undefined>;
  readonly onLog?: VerifierLogCallback;
}

async function annotateSingleEntryCollision(
  entry: VerifierEntry,
  ctx: CollisionEvalContext
): Promise<VerifierEntry> {
  if (
    entry.issues.includes('EMPTY_DIRECTORY') ||
    entry.currentRootName === entry.expectedRootName
  ) {
    return entry;
  }
  const currentLower = entry.currentRootName.toLowerCase();
  const expectedLower = entry.expectedRootName.toLowerCase();
  const isCaseOnlyRename = currentLower === expectedLower;
  const existingMatch = ctx.existingByLower.get(expectedLower);
  const hasExistingCollision = !isCaseOnlyRename && existingMatch !== undefined;
  const hasPeerCollision = (ctx.targetCounts.get(expectedLower) ?? 0) > 1;
  if (!hasExistingCollision && !hasPeerCollision) {
    return entry;
  }
  const collisionTarget = existingMatch ?? entry.expectedRootName;
  ctx.onLog?.(
    'warn',
    `Destination collision detected in ${ctx.category}: ${entry.currentRootName} -> ${collisionTarget} already exists`
  );
  const activeDb = await ctx.getProbeDb(hasExistingCollision);
  const collisionComparison = hasExistingCollision
    ? await buildVerifierCollisionComparison(
        ctx.libraryRoot,
        ctx.category,
        entry,
        collisionTarget,
        activeDb
      )
    : undefined;
  return {
    ...entry,
    issues: [...entry.issues, 'DESTINATION_COLLISION'],
    collisionTarget,
    ...(collisionComparison ? { collisionComparison } : {})
  };
}

async function annotateDestinationCollisions(
  libraryRoot: string,
  rootDirs: readonly string[],
  categoryEntries: readonly (VerifierEntry | null)[],
  category: OutputCategory,
  probeDb: ScanCacheDb | undefined,
  configDir: string,
  onLog?: VerifierLogCallback
): Promise<VerifierEntry[]> {
  let lazyDb: ScanCacheDb | undefined;
  const existingByLower = new Map<string, string>();
  for (const dirName of rootDirs) {
    existingByLower.set(dirName.toLowerCase(), dirName);
  }

  const targetCounts = new Map<string, number>();
  for (const entry of categoryEntries) {
    if (!entry || entry.issues.includes('EMPTY_DIRECTORY')) {
      continue;
    }
    const expectedLower = entry.expectedRootName.toLowerCase();
    targetCounts.set(expectedLower, (targetCounts.get(expectedLower) ?? 0) + 1);
  }

  const ctx: CollisionEvalContext = {
    libraryRoot,
    category,
    existingByLower,
    targetCounts,
    configDir,
    onLog,
    getProbeDb: async (needDb: boolean) => {
      if (!needDb) {
        return probeDb ?? lazyDb;
      }
      if (!probeDb && !lazyDb) {
        lazyDb = await openScanCacheDb(configDir);
      }
      return probeDb ?? lazyDb;
    }
  };

  const annotated: VerifierEntry[] = [];
  try {
    for (const entry of categoryEntries) {
      if (entry) {
        annotated.push(await annotateSingleEntryCollision(entry, ctx));
      }
    }
  } finally {
    lazyDb?.close();
  }
  return annotated;
}

async function removeDirectoryRobust(dirPath: string): Promise<void> {
  for (let attempt = 1; attempt <= RM_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const isRetryable = code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY';
      if (!isRetryable || attempt === RM_RETRY_ATTEMPTS) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, RM_RETRY_DELAY_MS * attempt));
    }
  }
}

function sortStepsBottomUp(steps: readonly VerifierRenameStep[]): readonly VerifierRenameStep[] {
  return [...steps].sort((a, b): number => stepOrder(a.kind) - stepOrder(b.kind));
}

async function isDirectoryEmptyRecursive(dirPath: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (isActivePartialDownloadName(entry.name)) {
        return false;
      }
      if (isHiddenOrTempEntryName(entry.name)) {
        continue;
      }
      if (!entry.isDirectory()) {
        return false;
      }
      if (!(await isDirectoryEmptyRecursive(path.join(dirPath, entry.name)))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function moveDirectoryContentsFallback(fromAbs: string, toAbs: string): Promise<void> {
  await fs.mkdir(toAbs, { recursive: true });
  const children = await fs.readdir(fromAbs, { withFileTypes: true });
  for (const child of children) {
    const childFrom = path.join(fromAbs, child.name);
    const childTo = path.join(toAbs, child.name);
    if (isHiddenOrTempEntryName(child.name) && !isActivePartialDownloadName(child.name)) {
      await fs.rm(childFrom, { recursive: true, force: true });
      continue;
    }
    if (child.isDirectory()) {
      if (await isDirectoryEmptyRecursive(childFrom)) {
        await removeDirectoryRobust(childFrom);
      } else {
        await renamePathStrict(childFrom, childTo);
      }
    } else {
      await fs.rename(childFrom, childTo);
    }
  }
  await removeDirectoryRobust(fromAbs);
}

async function renamePathStrict(fromAbs: string, toAbs: string): Promise<void> {
  try {
    await fs.rename(fromAbs, toAbs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
      const stats = await fs.lstat(fromAbs);
      if (stats.isDirectory()) {
        // Windows Docker bind mounts can block MoveFileEx on non-empty directories; move children safely without touching NAS ACLs.
        await moveDirectoryContentsFallback(fromAbs, toAbs);
        return;
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${detail} (Check mount write permissions or PUID/PGID ownership on the host/NAS)`,
        { cause: err }
      );
    }
    throw err;
  }
}

async function renameSingleStep(
  libraryRoot: string,
  step: VerifierRenameStep,
  onLog?: VerifierLogCallback
): Promise<boolean> {
  const fromAbs = resolveContainedOutputPath(libraryRoot, step.fromRelative);
  if (step.kind === 'delete-dir') {
    if (!(await pathExists(fromAbs))) {
      return false;
    }
    if (!(await isDirectoryEmptyRecursive(fromAbs))) {
      throw new Error(`Cannot delete non-empty directory: ${step.fromRelative}`);
    }
    await removeDirectoryRobust(fromAbs);
    onLog?.('info', `Removed empty directory (${step.kind}): ${step.fromRelative}`);
    return true;
  }

  const toAbs = resolveContainedOutputPath(libraryRoot, step.toRelative);
  if (fromAbs === toAbs) {
    return false;
  }

  if (
    step.kind !== 'file' &&
    (await pathExists(fromAbs)) &&
    (await isDirectoryEmptyRecursive(fromAbs))
  ) {
    await removeDirectoryRobust(fromAbs);
    onLog?.('info', `Removed empty directory (${step.kind}): ${step.fromRelative}`);
    return true;
  }

  const isCaseOnlyRename = fromAbs.toLowerCase() === toAbs.toLowerCase() && fromAbs !== toAbs;
  if (!isCaseOnlyRename && (await pathExists(toAbs))) {
    throw new Error(`Destination already exists: ${step.toRelative}`);
  }

  if (isCaseOnlyRename) {
    const tmpAbs = `${fromAbs}${CASE_TMP_SUFFIX}`;
    await renamePathStrict(fromAbs, tmpAbs);
    await renamePathStrict(tmpAbs, toAbs);
  } else {
    await renamePathStrict(fromAbs, toAbs);
  }

  onLog?.('info', `Renamed (${step.kind}): ${step.fromRelative} -> ${step.toRelative}`);
  return true;
}

async function findRootDirCollision(
  libraryRoot: string,
  entry: VerifierEntry
): Promise<{ readonly rootStep: VerifierRenameStep; readonly toAbs: string } | null> {
  const rootStep = entry.steps.find((s) => s.kind === 'root-dir');
  if (!rootStep) {
    return null;
  }
  const fromAbs = resolveContainedOutputPath(libraryRoot, rootStep.fromRelative);
  const toAbs = resolveContainedOutputPath(libraryRoot, rootStep.toRelative);
  const isCaseOnlyRename = fromAbs.toLowerCase() === toAbs.toLowerCase() && fromAbs !== toAbs;
  if (fromAbs !== toAbs && !isCaseOnlyRename && (await pathExists(toAbs))) {
    return { rootStep, toAbs };
  }
  return null;
}

async function assertRootDestinationAvailable(
  libraryRoot: string,
  entry: VerifierEntry
): Promise<void> {
  const collision = await findRootDirCollision(libraryRoot, entry);
  if (collision) {
    throw new Error(`Destination already exists: ${collision.rootStep.toRelative}`);
  }
}

async function applyEntrySteps(
  libraryRoot: string,
  entry: VerifierEntry,
  onLog?: VerifierLogCallback,
  overwriteDestination = false
): Promise<{ readonly renamedFiles: number; readonly renamedDirs: number }> {
  if (overwriteDestination) {
    const collision = await findRootDirCollision(libraryRoot, entry);
    if (collision) {
      await removeDirectoryRobust(collision.toAbs);
      onLog?.(
        'warn',
        `Removed colliding destination directory for overwrite: ${collision.rootStep.toRelative}`
      );
    }
  }
  await assertRootDestinationAvailable(libraryRoot, entry);
  let renamedFiles = 0;
  let renamedDirs = 0;
  for (const step of sortStepsBottomUp(entry.steps)) {
    const didRename = await renameSingleStep(libraryRoot, step, onLog);
    if (!didRename) {
      continue;
    }
    if (step.kind === 'file') {
      renamedFiles += 1;
    } else {
      renamedDirs += 1;
    }
  }
  return { renamedFiles, renamedDirs };
}

function emitVerifierFixProgress(
  onProgress: VerifierProgressCallback | undefined,
  completed: number,
  total: number,
  entry: VerifierEntry,
  startedAtMs: number
): void {
  onProgress?.({
    completed,
    total,
    percent: computePercent(completed, total),
    stageLabel: entry.category,
    activeTasks: completed < total ? [{ slot: 0, fileName: entry.currentRootName }] : [],
    etaSeconds: computeEtaSeconds(startedAtMs, completed, total)
  });
}

/** Applies selected verification fixes using strict bottom-up rename order (`file` -> `season-dir` -> `root-dir`). */
export async function applyVerifierRenames(
  config: AppConfig,
  entries: readonly VerifierEntry[],
  onLog?: VerifierLogCallback,
  onProgress?: VerifierProgressCallback,
  conflictResolutions?: Readonly<Partial<Record<VerifierEntryId, ConflictDecision>>>
): Promise<VerifierFixResult> {
  const mountPaths = buildMountPathsMap(config);
  let fixedEntries = 0;
  let renamedSteps = 0;
  let renamedFiles = 0;
  let renamedDirs = 0;
  const failures: VerifierFixFailure[] = [];
  const total = entries.length;
  const startedAtMs = performance.now();

  onProgress?.({
    completed: 0,
    total,
    percent: 0,
    stageLabel: 'Applying bottom-up renames...',
    activeTasks: []
  });

  for (const [index, entry] of entries.entries()) {
    emitVerifierFixProgress(onProgress, index, total, entry, startedAtMs);
    const hasCollision = entry.issues.includes('DESTINATION_COLLISION');
    const decision = hasCollision ? conflictResolutions?.[entry.id] : undefined;
    if (hasCollision && decision === 'ignore') {
      onLog?.('info', `Skipped conflict entry (${entry.currentRootName}) per user decision.`);
      emitVerifierFixProgress(onProgress, index + 1, total, entry, startedAtMs);
      continue;
    }

    const libraryRoot = mountPaths[entry.category];
    try {
      const counts = await applyEntrySteps(
        libraryRoot,
        entry,
        onLog,
        hasCollision && decision === 'overwrite'
      );
      renamedFiles += counts.renamedFiles;
      renamedDirs += counts.renamedDirs;
      renamedSteps += counts.renamedFiles + counts.renamedDirs;
      fixedEntries += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onLog?.('error', `Failed to fix ${entry.currentRootName}: ${msg}`);
      failures.push({
        id: entry.id,
        currentRootName: entry.currentRootName,
        error: msg
      });
    }
    emitVerifierFixProgress(onProgress, index + 1, total, entry, startedAtMs);
  }

  return { fixedEntries, renamedSteps, renamedFiles, renamedDirs, failures };
}
