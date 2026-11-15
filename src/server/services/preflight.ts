import fs from 'node:fs/promises';
import path from 'node:path';

import {
  formatMovieRelativePath,
  formatTvRelativePath,
  resolveContainedOutputPath
} from '../../domain/plexFormatter.ts';
import type {
  ConflictComparison,
  DiskSpaceCheck,
  ItemId,
  MediaProbeSummary,
  MountPathsMap,
  OutputCategory,
  ScannedItem
} from '../../domain/types.ts';
import {
  buildExistingFileConflictComparison,
  buildLibraryRootIndex,
  findExistingVideoInLibraryFolder,
  findMatchingLibraryFolders,
  type LibraryRootEntry
} from './libraryCollision.ts';

/** Computes the projected absolute destination path for a queue item. */
export function computeProjectedDestination(item: ScannedItem, mountPaths: MountPathsMap): string {
  const root = mountPaths[item.category];
  const meta = item.selectedMetadata ?? item.candidates[0];
  const title = meta?.title ?? item.parsedTitle;
  const year = meta?.year ?? item.parsedYear;

  const relPath =
    item.mediaKind === 'tv'
      ? formatTvRelativePath({
          showTitle: title,
          year,
          tvdbId: meta?.tvdbId,
          tmdbId: meta?.tmdbId,
          edition: item.edition,
          episode: item.episode ?? { seasonNumber: 1, episodeStart: 1 },
          splitPart: item.splitPart
        })
      : formatMovieRelativePath({
          title,
          year,
          imdbId: meta?.imdbId,
          tmdbId: meta?.tmdbId,
          edition: item.edition,
          tags: item.tags,
          splitPart: item.splitPart
        });

  return resolveContainedOutputPath(root, relPath);
}

export interface PreflightReport {
  readonly ok: boolean;
  readonly diskSpace: readonly DiskSpaceCheck[];
  readonly conflicts: readonly ConflictComparison[];
  readonly projectedByItemId: Readonly<Partial<Record<ItemId, string>>>;
}

function toDisplayHostPath(
  targetPath: string,
  category: OutputCategory,
  mountPaths: MountPathsMap
): string {
  const containerRoot = mountPaths[category];
  const rel = path.relative(containerRoot, targetPath);
  return `${category}/${rel.replaceAll('\\', '/')}`;
}

function getSiblingCategory(category: OutputCategory): OutputCategory {
  if (category === 'movies') {
    return 'animated-movies';
  }
  if (category === 'animated-movies') {
    return 'movies';
  }
  return category === 'tv-shows' ? 'animated-series' : 'tv-shows';
}

async function getRootIndex(
  category: OutputCategory,
  mountPaths: MountPathsMap,
  cache: Map<OutputCategory, readonly LibraryRootEntry[]>
): Promise<readonly LibraryRootEntry[]> {
  const cached = cache.get(category);
  if (cached) {
    return cached;
  }
  const index = await buildLibraryRootIndex(mountPaths[category]);
  cache.set(category, index);
  return index;
}

interface ExistingCollisionMatch {
  readonly existingPath: string;
  readonly category: OutputCategory;
}

async function findExistingCollision(
  item: ScannedItem,
  dest: string,
  mountPaths: MountPathsMap,
  rootIndexCache: Map<OutputCategory, readonly LibraryRootEntry[]>
): Promise<ExistingCollisionMatch | null> {
  try {
    await fs.access(dest);
    return { existingPath: dest, category: item.category };
  } catch {
    // Exact path does not exist; check destination folder and library-wide aliases/IDs
  }

  const destShowOrMovieDir =
    item.mediaKind === 'tv' ? path.dirname(path.dirname(dest)) : path.dirname(dest);
  const directMatch = await findExistingVideoInLibraryFolder(item, destShowOrMovieDir);
  if (directMatch) {
    return { existingPath: directMatch, category: item.category };
  }

  for (const category of [item.category, getSiblingCategory(item.category)] as const) {
    const rootIndex = await getRootIndex(category, mountPaths, rootIndexCache);
    const matchedFolders = findMatchingLibraryFolders(item, rootIndex);
    for (const folder of matchedFolders) {
      if (folder.absPath === destShowOrMovieDir) {
        continue;
      }
      const found = await findExistingVideoInLibraryFolder(item, folder.absPath);
      if (found) {
        return { existingPath: found, category };
      }
    }
  }

  return null;
}

/** Runs blocking pre-flight checks: destination resolution, intra-batch collisions, existing files, and disk space. */
export async function runPreflightCheck(
  items: readonly ScannedItem[],
  mountPaths: MountPathsMap,
  probeFile: (filePath: string) => Promise<MediaProbeSummary>
): Promise<PreflightReport> {
  const included = items.filter((item) => item.include);
  const projectedByItemId: Partial<Record<ItemId, string>> = {};
  const destGroups = new Map<string, ScannedItem[]>();
  const requiredByCategory = new Map<OutputCategory, number>();

  for (const item of included) {
    const dest = computeProjectedDestination(item, mountPaths);
    projectedByItemId[item.id] = dest;
    const list = destGroups.get(dest) ?? [];
    list.push(item);
    destGroups.set(dest, list);
    requiredByCategory.set(
      item.category,
      (requiredByCategory.get(item.category) ?? 0) + item.probe.sizeBytes
    );
  }

  const conflicts: ConflictComparison[] = [];
  const rootIndexCache = new Map<OutputCategory, readonly LibraryRootEntry[]>();

  for (const [dest, group] of destGroups.entries()) {
    if (group.length > 1) {
      for (const item of group) {
        conflicts.push({
          itemId: item.id,
          sourceFileName: item.fileName,
          kind: 'intra-batch',
          destinationPath: dest,
          displayPath: toDisplayHostPath(dest, item.category, mountPaths),
          incoming: item.probe,
          collidingItemIds: group.filter((g): boolean => g.id !== item.id).map((g) => g.id)
        });
      }
      continue;
    }

    const single = group[0];
    if (!single) {
      continue;
    }
    const collision = await findExistingCollision(single, dest, mountPaths, rootIndexCache);
    if (collision) {
      const existingProbe = await probeFile(collision.existingPath);
      conflicts.push(
        buildExistingFileConflictComparison({
          itemId: single.id,
          sourceFileName: single.fileName,
          destinationPath: dest,
          existingPath: collision.existingPath,
          displayPath: toDisplayHostPath(collision.existingPath, collision.category, mountPaths),
          incoming: single.probe,
          existing: existingProbe
        })
      );
    }
  }

  const diskSpace: DiskSpaceCheck[] = [];
  for (const [category, requiredBytes] of requiredByCategory.entries()) {
    const targetRoot = mountPaths[category];
    try {
      const stats = await fs.statfs(targetRoot);
      const availableBytes = Number(stats.bavail) * Number(stats.bsize);
      diskSpace.push({
        category,
        targetRoot,
        availableBytes,
        requiredBytes,
        sufficient: availableBytes >= requiredBytes
      });
    } catch {
      diskSpace.push({
        category,
        targetRoot,
        availableBytes: 0,
        requiredBytes,
        sufficient: false
      });
    }
  }

  const hasInsufficientSpace = diskSpace.some((d): boolean => !d.sufficient);
  return {
    ok: conflicts.length === 0 && !hasInsufficientSpace,
    diskSpace,
    conflicts,
    projectedByItemId
  };
}
