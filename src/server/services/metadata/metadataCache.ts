import { METADATA_CACHE_TTL_MS } from '../../../domain/constants.ts';
import type { MetadataCandidate } from '../../../domain/types.ts';
import { openScanCacheDb, withAppDbPathSync } from '../scanCacheDb.ts';

export type MetadataCacheBucket =
  | 'movieSearch'
  | 'movieById'
  | 'tvSearch'
  | 'seriesById'
  | 'episodeMaps';

interface CacheEnvelope<T> {
  readonly value: T;
  readonly expiresAt: number;
}

interface BucketValueMap {
  readonly movieSearch: readonly MetadataCandidate[];
  readonly movieById: MetadataCandidate;
  readonly tvSearch: readonly MetadataCandidate[];
  readonly seriesById: MetadataCandidate;
  readonly episodeMaps: readonly (readonly [string, string])[];
}

let resolvedDbPath: string | undefined;

const memoryCache: {
  movieSearch: Map<string, CacheEnvelope<readonly MetadataCandidate[]>>;
  movieById: Map<string, CacheEnvelope<MetadataCandidate>>;
  tvSearch: Map<string, CacheEnvelope<readonly MetadataCandidate[]>>;
  seriesById: Map<string, CacheEnvelope<MetadataCandidate>>;
  episodeMaps: Map<string, CacheEnvelope<readonly (readonly [string, string])[]>>;
} = {
  movieSearch: new Map(),
  movieById: new Map(),
  tvSearch: new Map(),
  seriesById: new Map(),
  episodeMaps: new Map()
};

function clearAllBuckets(): void {
  memoryCache.movieSearch.clear();
  memoryCache.movieById.clear();
  memoryCache.tvSearch.clear();
  memoryCache.seriesById.clear();
  memoryCache.episodeMaps.clear();
}

function isBucketName(value: string): value is MetadataCacheBucket {
  return (
    value === 'movieSearch' ||
    value === 'movieById' ||
    value === 'tvSearch' ||
    value === 'seriesById' ||
    value === 'episodeMaps'
  );
}

/** Configures persistent SQLite metadata caching in `configDir` and hydrates valid entries. */
export async function configureMetadataCache(
  configDir: string,
  onFallbackWarning?: (warning: string) => void
): Promise<void> {
  resolvedDbPath = undefined;
  clearAllBuckets();

  const db = await openScanCacheDb(configDir, undefined, onFallbackWarning);
  try {
    resolvedDbPath = db.dbPath;
    const nowMs = Temporal.Now.instant().epochMilliseconds;
    for (const row of db.getAllValidMetadata(nowMs)) {
      if (!isBucketName(row.bucket)) {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(row.payloadJson);
        const map = memoryCache[row.bucket] as Map<string, CacheEnvelope<unknown>>;
        map.set(row.cacheKey, { value: parsed, expiresAt: row.expiresAt });
      } catch {
        // Skip malformed cached JSON payload
      }
    }
  } finally {
    db.close();
  }
}

/** Reads a non-expired cached entry from memory/SQLite store. */
export function getCachedMetadata<K extends MetadataCacheBucket>(
  bucket: K,
  key: string
): BucketValueMap[K] | undefined {
  const map = memoryCache[bucket] as Map<string, CacheEnvelope<BucketValueMap[K]>>;
  const entry = map.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Temporal.Now.instant().epochMilliseconds) {
    map.delete(key);
    return undefined;
  }
  return entry.value;
}

/** Stores a metadata result with TTL and persists it immediately to SQLite if configured. */
export function setCachedMetadata<K extends MetadataCacheBucket>(
  bucket: K,
  key: string,
  value: BucketValueMap[K],
  ttlMs = METADATA_CACHE_TTL_MS
): void {
  const nowMs = Temporal.Now.instant().epochMilliseconds;
  const expiresAt = nowMs + ttlMs;
  const map = memoryCache[bucket] as Map<string, CacheEnvelope<BucketValueMap[K]>>;
  map.set(key, { value, expiresAt });
  if (resolvedDbPath) {
    try {
      withAppDbPathSync(resolvedDbPath, (db) => {
        db.setMetadata(bucket, key, JSON.stringify(value), expiresAt, nowMs);
      });
    } catch (err) {
      console.warn('Metadata cache SQLite persistence failed:', err);
    }
  }
}
