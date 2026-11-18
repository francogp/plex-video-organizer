import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  OUTPUT_CATEGORIES,
  isHiddenOrTempEntryName,
  isVideoExtension
} from '../../domain/constants.ts';
import {
  IMDB_TAG_REGEX,
  SEASON_DIR_REGEX,
  TMDB_TAG_REGEX,
  TVDB_TAG_REGEX,
  YEAR_PAREN_REGEX
} from '../../domain/libraryVerifier.ts';
import {
  asImdbId,
  asTmdbId,
  asTvdbId,
  type ConflictComparison,
  type ImdbId,
  type MediaProbeSummary,
  type MetadataCandidate,
  type MountPathsMap,
  type OutputCategory,
  type ScannedItem,
  type TmdbId,
  type TvdbId
} from '../../domain/types.ts';

export interface LibraryRootEntry {
  readonly dirName: string;
  readonly absPath: string;
  readonly tvdbId?: TvdbId;
  readonly tmdbId?: TmdbId;
  readonly imdbId?: ImdbId;
  readonly year?: number;
  readonly normalizedTitle: string;
}

const EXTRA_SUFFIX_REGEX =
  /-(trailer|behindthescenes|deleted|featurette|interview|scene|short|other)\.[^.]+$/iu;

function normalizeTitleForCollision(rawTitle: string): string {
  return rawTitle
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036f]/gu, '')
    .replaceAll(/\{[^}]*\}/gu, ' ')
    .replaceAll(/\[[^\]]*\]/gu, ' ')
    .replaceAll(/\(\d{4}\)/gu, ' ')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, ' ')
    .trim();
}

function parseLibraryRootEntry(dirName: string, absPath: string): LibraryRootEntry {
  const tvdbMatch = TVDB_TAG_REGEX.exec(dirName);
  const tmdbMatch = TMDB_TAG_REGEX.exec(dirName);
  const imdbMatch = IMDB_TAG_REGEX.exec(dirName);
  const yearMatch = YEAR_PAREN_REGEX.exec(dirName);

  return {
    dirName,
    absPath,
    tvdbId: tvdbMatch?.[1] ? asTvdbId(tvdbMatch[1]) : undefined,
    tmdbId: tmdbMatch?.[1] ? asTmdbId(tmdbMatch[1]) : undefined,
    imdbId: imdbMatch?.[1] ? asImdbId(imdbMatch[1].toLowerCase()) : undefined,
    year: yearMatch?.[1] ? Number(yearMatch[1]) : undefined,
    normalizedTitle: normalizeTitleForCollision(dirName)
  };
}

/** Scans a category root directory once and extracts IDs and normalized titles for collision lookup. */
export async function buildLibraryRootIndex(
  libraryRoot: string
): Promise<readonly LibraryRootEntry[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(libraryRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const roots: LibraryRootEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || isHiddenOrTempEntryName(entry.name)) {
      continue;
    }
    roots.push(parseLibraryRootEntry(entry.name, path.join(libraryRoot, entry.name)));
  }
  return roots;
}

function yearsAreCompatible(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) {
    return true;
  }
  return Math.abs(a - b) <= 1;
}

function hasConflictingExternalId(
  meta: ScannedItem['selectedMetadata'],
  entry: LibraryRootEntry
): boolean {
  if (!meta) {
    return false;
  }
  if (meta.tvdbId !== undefined && entry.tvdbId !== undefined && meta.tvdbId !== entry.tvdbId) {
    return true;
  }
  if (meta.tmdbId !== undefined && entry.tmdbId !== undefined && meta.tmdbId !== entry.tmdbId) {
    return true;
  }
  if (
    meta.imdbId !== undefined &&
    entry.imdbId !== undefined &&
    meta.imdbId.toLowerCase() !== entry.imdbId
  ) {
    return true;
  }
  return false;
}

/** Finds all root folders in a library that match the item's external IDs or normalized titles. */
export function findMatchingLibraryFolders(
  item: ScannedItem,
  rootEntries: readonly LibraryRootEntry[]
): readonly LibraryRootEntry[] {
  const meta = item.selectedMetadata ?? item.candidates[0];
  const itemYear = meta?.year ?? item.parsedYear;

  const titleCandidates = new Set<string>();
  const primaryTitle = meta?.title ?? item.parsedTitle;
  if (primaryTitle) {
    const normalized = normalizeTitleForCollision(primaryTitle);
    if (normalized) {
      titleCandidates.add(normalized);
    }
  }
  if (item.parsedTitle) {
    const normalizedParsed = normalizeTitleForCollision(item.parsedTitle);
    if (normalizedParsed) {
      titleCandidates.add(normalizedParsed);
    }
  }

  const matches: LibraryRootEntry[] = [];
  for (const entry of rootEntries) {
    const idMatch =
      (meta?.tvdbId !== undefined && entry.tvdbId === meta.tvdbId) ||
      (meta?.tmdbId !== undefined && entry.tmdbId === meta.tmdbId) ||
      (meta?.imdbId !== undefined && entry.imdbId === meta.imdbId.toLowerCase());

    if (idMatch) {
      matches.push(entry);
      continue;
    }

    if (hasConflictingExternalId(meta, entry)) {
      continue;
    }

    if (
      entry.normalizedTitle.length > 0 &&
      titleCandidates.has(entry.normalizedTitle) &&
      yearsAreCompatible(itemYear, entry.year)
    ) {
      matches.push(entry);
    }
  }

  return matches;
}

function listVideoFilesInDir(entries: readonly Dirent[]): readonly Dirent[] {
  return entries.filter(
    (entry): boolean =>
      entry.isFile() &&
      !isHiddenOrTempEntryName(entry.name) &&
      isVideoExtension(path.extname(entry.name).toLowerCase())
  );
}

function matchesTvEpisodeFileName(fileName: string, item: ScannedItem): boolean {
  const ep = item.episode ?? { seasonNumber: 1, episodeStart: 1 };
  if (ep.airDate) {
    return fileName.toLowerCase().includes(ep.airDate.toLowerCase());
  }
  const episodeRegex = new RegExp(
    `(?:^|[^a-z0-9])s0*${String(ep.seasonNumber)}e0*${String(ep.episodeStart)}(?:[^0-9]|$)`,
    'iu'
  );
  return episodeRegex.test(fileName);
}

async function searchTvEpisodeInDir(dirPath: string, item: ScannedItem): Promise<string | null> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }
  const match = listVideoFilesInDir(entries).find((entry): boolean =>
    matchesTvEpisodeFileName(entry.name, item)
  );
  return match ? path.join(dirPath, match.name) : null;
}

/** Searches a matched library root folder for an existing colliding video file. */
export async function findExistingVideoInLibraryFolder(
  item: ScannedItem,
  folderAbsPath: string
): Promise<string | null> {
  let rootEntries: Dirent[];
  try {
    rootEntries = await fs.readdir(folderAbsPath, { withFileTypes: true });
  } catch {
    return null;
  }

  if (item.mediaKind !== 'tv') {
    const mainMovie = listVideoFilesInDir(rootEntries).find(
      (entry): boolean => !EXTRA_SUFFIX_REGEX.test(entry.name)
    );
    return mainMovie ? path.join(folderAbsPath, mainMovie.name) : null;
  }

  const seasonNumber = item.episode?.seasonNumber ?? 1;
  const candidateDirs: string[] = [];

  for (const entry of rootEntries) {
    if (!entry.isDirectory() || isHiddenOrTempEntryName(entry.name)) {
      continue;
    }
    if (seasonNumber === 0 && entry.name.toLowerCase() === 'specials') {
      candidateDirs.push(path.join(folderAbsPath, entry.name));
      continue;
    }
    const seasonMatch = SEASON_DIR_REGEX.exec(entry.name);
    if (seasonMatch?.[1] && Number(seasonMatch[1]) === seasonNumber) {
      candidateDirs.push(path.join(folderAbsPath, entry.name));
    }
  }

  for (const dirPath of candidateDirs) {
    const found = await searchTvEpisodeInDir(dirPath, item);
    if (found) {
      return found;
    }
  }

  // Also check root folder in case legacy files live directly under the show directory
  const rootMatch = listVideoFilesInDir(rootEntries).find((entry): boolean =>
    matchesTvEpisodeFileName(entry.name, item)
  );
  return rootMatch ? path.join(folderAbsPath, rootMatch.name) : null;
}

export interface BuildConflictComparisonOptions<TId extends string> {
  readonly itemId: TId;
  readonly sourceFileName: string;
  readonly destinationPath: string;
  readonly existingPath: string;
  readonly displayPath?: string;
  readonly incoming: MediaProbeSummary;
  readonly existing: MediaProbeSummary;
}

/** Shared builder for existing-file ConflictComparison records across Organizer and Verifier. */
export function buildExistingFileConflictComparison<TId extends string>(
  options: BuildConflictComparisonOptions<TId>
): ConflictComparison<TId> {
  return {
    itemId: options.itemId,
    sourceFileName: options.sourceFileName,
    kind: 'existing-file',
    destinationPath: options.destinationPath,
    existingPath: options.existingPath,
    ...(options.displayPath ? { displayPath: options.displayPath } : {}),
    incoming: options.incoming,
    existing: options.existing
  };
}

export interface MountLibraryLookup {
  readonly byTvdbId: ReadonlyMap<TvdbId, OutputCategory>;
  readonly byImdbId: ReadonlyMap<ImdbId, OutputCategory>;
  readonly byTmdbId: ReadonlyMap<TmdbId, OutputCategory>;
  readonly byNormalizedTitle: ReadonlyMap<
    string,
    readonly { readonly category: OutputCategory; readonly year?: number }[]
  >;
}

/** Builds an O(1) lookup index of existing titles and provider IDs across all output mount libraries. */
export async function buildAllMountLibraryLookup(
  mountPaths: MountPathsMap
): Promise<MountLibraryLookup> {
  const byTvdbId = new Map<TvdbId, OutputCategory>();
  const byImdbId = new Map<ImdbId, OutputCategory>();
  const byTmdbId = new Map<TmdbId, OutputCategory>();
  const byNormalizedTitle = new Map<
    string,
    Array<{ readonly category: OutputCategory; readonly year?: number }>
  >();

  const perCategory = await Promise.all(
    OUTPUT_CATEGORIES.map(async (category) => ({
      category,
      roots: await buildLibraryRootIndex(mountPaths[category])
    }))
  );

  for (const { category, roots } of perCategory) {
    for (const root of roots) {
      if (root.tvdbId && !byTvdbId.has(root.tvdbId)) {
        byTvdbId.set(root.tvdbId, category);
      }
      if (root.imdbId && !byImdbId.has(root.imdbId)) {
        byImdbId.set(root.imdbId, category);
      }
      if (root.tmdbId && !byTmdbId.has(root.tmdbId)) {
        byTmdbId.set(root.tmdbId, category);
      }
      if (root.normalizedTitle) {
        const list = byNormalizedTitle.get(root.normalizedTitle) ?? [];
        list.push({ category, year: root.year });
        byNormalizedTitle.set(root.normalizedTitle, list);
      }
    }
  }

  return { byTvdbId, byImdbId, byTmdbId, byNormalizedTitle };
}

/** Returns the output library category if `candidate` already exists in any indexed mount. */
export function findCandidateInMounts(
  candidate: MetadataCandidate,
  lookup: MountLibraryLookup
): OutputCategory | undefined {
  const idLookups: readonly [string | undefined, ReadonlyMap<string, OutputCategory>][] = [
    [candidate.tvdbId, lookup.byTvdbId],
    [candidate.imdbId, lookup.byImdbId],
    [candidate.tmdbId, lookup.byTmdbId]
  ];
  for (const [id, map] of idLookups) {
    const hit = id ? map.get(id) : undefined;
    if (hit) {
      return hit;
    }
  }
  const normalized = normalizeTitleForCollision(candidate.title);
  const titleHits = normalized ? lookup.byNormalizedTitle.get(normalized) : undefined;
  if (!titleHits) {
    return undefined;
  }
  for (const hit of titleHits) {
    if (yearsAreCompatible(hit.year, candidate.year)) {
      return hit.category;
    }
  }
  return undefined;
}
