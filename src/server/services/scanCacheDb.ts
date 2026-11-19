import crypto from 'node:crypto';
import { promises as fs, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import * as v from 'valibot';

import {
  ETA_MAX_SAMPLES_PER_KEY,
  ETA_ORPHAN_HOST_TTL_MS,
  MAX_SERVER_LOG_ENTRIES,
  SCAN_CACHE_RETENTION_MS,
  isPermissionOrReadOnlyError
} from '../../domain/constants.ts';
import {
  EtaChannelProfileSchema,
  EtaWorkTypeSchema,
  sanitizeConflictResolutions,
  type AudioLanguageCode,
  type AudioTrackAnalysis,
  type ConflictDecision,
  type EtaChannelProfile,
  type EtaWorkType,
  type ItemId,
  type LogLevel,
  type MediaProbeSummary,
  type MetadataLanguageCode,
  type ScannedItem,
  type SseLogEvent
} from '../../domain/types.ts';
import { isDirUnwritable } from './fileMover.ts';

export interface PersistedPreferences {
  readonly preferredLanguages?: readonly MetadataLanguageCode[];
  readonly audioPreferredLanguages?: readonly AudioLanguageCode[];
}

const APP_DB_FILENAME = 'plex-video-organizer.sqlite';
const PREVIOUS_SCAN_CACHE_DB_FILENAME = 'scan-cache.sqlite';

/** Returns a deterministic per-configDir fallback SQLite path inside `os.tmpdir()`. */
function getFallbackAppDbPath(configDir: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(path.resolve(configDir || 'default'))
    .digest('hex')
    .slice(0, 8);
  return path.join(os.tmpdir(), `plex-video-organizer-${hash}.sqlite`);
}
const LEGACY_PROBE_CACHE_FILENAME = 'probe-cache.json';
const LEGACY_AUDIO_CACHE_FILENAME = 'audio-cache.json';
const LEGACY_QUEUE_FILENAME = 'queue.json';
const LEGACY_METADATA_CACHE_FILENAME = 'metadata-cache.json';
const MIGRATION_INITIAL_SCAN_CACHE = '20261114150000_create_scan_cache_tables';
const MIGRATION_QUEUE_AND_METADATA = '20261114152000_add_queue_and_metadata_tables';

function nowEpochMs(): number {
  return Temporal.Now.instant().epochMilliseconds;
}

export interface ScanCacheFileMeta {
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

export interface ScanCachePruneResult {
  readonly probeDeleted: number;
  readonly audioDeleted: number;
}

export interface EtaSampleInput {
  readonly hostKey: string;
  readonly workType: EtaWorkType;
  readonly profile: EtaChannelProfile;
  readonly throughput: number;
  readonly workUnits: number;
  readonly durationMs: number;
  readonly createdAt?: number;
}

export interface EtaHostSampleGroup {
  readonly workType: EtaWorkType;
  readonly profile: EtaChannelProfile;
  readonly samples: readonly number[];
}

const MIGRATION_ETA_SAMPLES = '20261116195000_add_eta_samples_table';
const MIGRATION_SERVER_LOGS = '20261117201500_add_server_logs_table';

interface MigrationSpec {
  readonly id: string;
  readonly upSql: string;
}

const MIGRATIONS: readonly MigrationSpec[] = [
  {
    id: MIGRATION_INITIAL_SCAN_CACHE,
    upSql: `
      CREATE TABLE IF NOT EXISTS probe_cache (
        cache_key TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_probe_cache_last_seen ON probe_cache(last_seen_at);

      CREATE TABLE IF NOT EXISTS audio_cache (
        cache_key TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_audio_cache_last_seen ON audio_cache(last_seen_at);
    `
  },
  {
    id: MIGRATION_QUEUE_AND_METADATA,
    upSql: `
      CREATE TABLE IF NOT EXISTS queue_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL,
        items_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS metadata_cache (
        bucket TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (bucket, cache_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_metadata_cache_expires_at ON metadata_cache(expires_at);
    `
  },
  {
    id: MIGRATION_ETA_SAMPLES,
    upSql: `
      CREATE TABLE IF NOT EXISTS eta_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host_key TEXT NOT NULL,
        work_type TEXT NOT NULL,
        profile TEXT NOT NULL,
        throughput REAL NOT NULL CHECK (throughput > 0),
        work_units REAL NOT NULL CHECK (work_units > 0),
        duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_eta_samples_lookup
        ON eta_samples(host_key, work_type, profile, id DESC);
    `
  },
  {
    id: MIGRATION_SERVER_LOGS,
    upSql: `
      CREATE TABLE IF NOT EXISTS server_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        timestamp TEXT NOT NULL
      ) STRICT;
    `
  }
];

function parseStatKeyMeta(key: string): ScanCacheFileMeta {
  const parts = key.split('::');
  if (parts.length >= 3) {
    const mtimeMs = Number(parts.at(-1));
    const sizeBytes = Number(parts.at(-2));
    const relativePath = parts.slice(0, -2).join('::');
    if (Number.isFinite(sizeBytes) && Number.isFinite(mtimeMs)) {
      return {
        relativePath,
        sizeBytes: Math.trunc(sizeBytes),
        mtimeMs: Math.trunc(mtimeMs)
      };
    }
  }
  return { relativePath: key, sizeBytes: 0, mtimeMs: 0 };
}

async function readLegacyEntries<T>(filePath: string): Promise<readonly (readonly [string, T])[]> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const valid: [string, T][] = [];
    for (const entry of parsed) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] !== undefined) {
        valid.push([entry[0], entry[1] as T]);
      }
    }
    return valid;
  } catch {
    return [];
  }
}

export class ScanCacheDb {
  public readonly dbPath: string;
  readonly #db: DatabaseSync;
  readonly #getProbeStmt: StatementSync;
  readonly #touchProbeStmt: StatementSync;
  readonly #upsertProbeStmt: StatementSync;
  readonly #getAudioStmt: StatementSync;
  readonly #touchAudioStmt: StatementSync;
  readonly #upsertAudioStmt: StatementSync;
  readonly #pruneProbeStmt: StatementSync;
  readonly #pruneAudioStmt: StatementSync;
  readonly #pruneMetadataStmt: StatementSync;
  readonly #getQueueStateStmt: StatementSync;
  readonly #saveQueueStateStmt: StatementSync;
  readonly #getValidMetadataStmt: StatementSync;
  readonly #upsertMetadataStmt: StatementSync;
  readonly #clearMetadataStmt: StatementSync;
  readonly #getDbVersionStmt: StatementSync;
  readonly #getPreferencesStmt: StatementSync;
  readonly #upsertPreferencesStmt: StatementSync;
  readonly #getConflictResolutionsStmt: StatementSync;
  readonly #upsertConflictResolutionsStmt: StatementSync;
  readonly #insertServerLogStmt: StatementSync;
  readonly #pruneServerLogsStmt: StatementSync;
  readonly #loadServerLogsStmt: StatementSync;
  readonly #clearServerLogsStmt: StatementSync;
  #closed = false;

  public constructor(db: DatabaseSync, dbPath = ':memory:') {
    this.dbPath = dbPath;
    this.#db = db;
    this.#configurePragmas();
    this.#applyMigrations();

    this.#getProbeStmt = this.#db.prepare(
      'SELECT payload_json FROM probe_cache WHERE cache_key = ?'
    );
    this.#touchProbeStmt = this.#db.prepare(
      'UPDATE probe_cache SET last_seen_at = ? WHERE cache_key = ?'
    );
    this.#upsertProbeStmt = this.#db.prepare(`
      INSERT INTO probe_cache (
        cache_key, relative_path, size_bytes, mtime_ms, payload_json, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        relative_path = excluded.relative_path,
        size_bytes = excluded.size_bytes,
        mtime_ms = excluded.mtime_ms,
        payload_json = excluded.payload_json,
        last_seen_at = excluded.last_seen_at
    `);

    this.#getAudioStmt = this.#db.prepare(
      'SELECT payload_json FROM audio_cache WHERE cache_key = ?'
    );
    this.#touchAudioStmt = this.#db.prepare(
      'UPDATE audio_cache SET last_seen_at = ? WHERE cache_key = ?'
    );
    this.#upsertAudioStmt = this.#db.prepare(`
      INSERT INTO audio_cache (
        cache_key, relative_path, size_bytes, mtime_ms, payload_json, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        relative_path = excluded.relative_path,
        size_bytes = excluded.size_bytes,
        mtime_ms = excluded.mtime_ms,
        payload_json = excluded.payload_json,
        last_seen_at = excluded.last_seen_at
    `);

    this.#pruneProbeStmt = this.#db.prepare('DELETE FROM probe_cache WHERE last_seen_at < ?');
    this.#pruneAudioStmt = this.#db.prepare('DELETE FROM audio_cache WHERE last_seen_at < ?');
    this.#pruneMetadataStmt = this.#db.prepare('DELETE FROM metadata_cache WHERE expires_at <= ?');
    this.#getQueueStateStmt = this.#db.prepare(
      'SELECT revision, items_json FROM queue_state WHERE id = 1'
    );
    this.#saveQueueStateStmt = this.#db.prepare(`
      INSERT INTO queue_state (id, revision, items_json, updated_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        revision = excluded.revision,
        items_json = excluded.items_json,
        updated_at = excluded.updated_at
    `);
    this.#getValidMetadataStmt = this.#db.prepare(
      'SELECT bucket, cache_key, payload_json, expires_at FROM metadata_cache WHERE expires_at > ?'
    );
    this.#upsertMetadataStmt = this.#db.prepare(`
      INSERT INTO metadata_cache (bucket, cache_key, payload_json, expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(bucket, cache_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `);
    this.#clearMetadataStmt = this.#db.prepare('DELETE FROM metadata_cache');
    this.#getDbVersionStmt = this.#db.prepare(
      "SELECT value FROM system_config WHERE key = 'db_version'"
    );
    this.#getPreferencesStmt = this.#db.prepare(
      "SELECT value FROM system_config WHERE key = 'preferences'"
    );
    this.#upsertPreferencesStmt = this.#db.prepare(`
      INSERT INTO system_config (key, value) VALUES ('preferences', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this.#insertServerLogStmt = this.#db.prepare(
      'INSERT INTO server_logs (level, message, timestamp) VALUES (?, ?, ?)'
    );
    this.#pruneServerLogsStmt = this.#db.prepare(
      'DELETE FROM server_logs WHERE id <= (SELECT id FROM server_logs ORDER BY id DESC LIMIT 1 OFFSET ?)'
    );
    this.#loadServerLogsStmt = this.#db.prepare(
      'SELECT level, message, timestamp FROM server_logs ORDER BY id DESC LIMIT ?'
    );
    this.#clearServerLogsStmt = this.#db.prepare('DELETE FROM server_logs');
    this.#getConflictResolutionsStmt = this.#db.prepare(
      "SELECT value FROM system_config WHERE key = 'conflict_resolutions'"
    );
    this.#upsertConflictResolutionsStmt = this.#db.prepare(`
      INSERT INTO system_config (key, value) VALUES ('conflict_resolutions', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
  }

  #configurePragmas(): void {
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA temp_store = MEMORY;
      PRAGMA foreign_keys = ON;
    `);
  }

  #applyMigrations(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS system_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `);

    const isAppliedStmt = this.#db.prepare('SELECT 1 AS ok FROM _migrations WHERE id = ?');
    const recordMigrationStmt = this.#db.prepare(
      'INSERT INTO _migrations (id, applied_at) VALUES (?, ?)'
    );
    const upsertVersionStmt = this.#db.prepare(`
      INSERT INTO system_config (key, value) VALUES ('db_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    for (const migration of MIGRATIONS) {
      const existing = isAppliedStmt.get(migration.id);
      if (existing) {
        continue;
      }
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        this.#db.exec(migration.upSql);
        recordMigrationStmt.run(migration.id, nowEpochMs());
        upsertVersionStmt.run(migration.id);
        this.#db.exec('COMMIT');
      } catch (err) {
        this.#db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  public getDbVersion(): string | null {
    const row = this.#getDbVersionStmt.get();
    return row && typeof row.value === 'string' ? row.value : null;
  }

  public getProbe(key: string, nowMs: number = nowEpochMs()): MediaProbeSummary | undefined {
    const row = this.#getProbeStmt.get(key);
    if (!row || typeof row.payload_json !== 'string') {
      return undefined;
    }
    this.#touchProbeStmt.run(nowMs, key);
    return JSON.parse(row.payload_json) as MediaProbeSummary;
  }

  public setProbe(
    key: string,
    meta: ScanCacheFileMeta,
    summary: MediaProbeSummary,
    nowMs: number = nowEpochMs()
  ): void {
    this.#upsertProbeStmt.run(
      key,
      meta.relativePath,
      Math.trunc(meta.sizeBytes),
      Math.trunc(meta.mtimeMs),
      JSON.stringify(summary),
      nowMs,
      nowMs
    );
  }

  public getAudio(
    key: string,
    nowMs: number = nowEpochMs()
  ): readonly AudioTrackAnalysis[] | undefined {
    const row = this.#getAudioStmt.get(key);
    if (!row || typeof row.payload_json !== 'string') {
      return undefined;
    }
    this.#touchAudioStmt.run(nowMs, key);
    return JSON.parse(row.payload_json) as readonly AudioTrackAnalysis[];
  }

  public setAudio(
    key: string,
    meta: ScanCacheFileMeta,
    analyses: readonly AudioTrackAnalysis[],
    nowMs: number = nowEpochMs()
  ): void {
    this.#upsertAudioStmt.run(
      key,
      meta.relativePath,
      Math.trunc(meta.sizeBytes),
      Math.trunc(meta.mtimeMs),
      JSON.stringify(analyses),
      nowMs,
      nowMs
    );
  }

  public pruneExpired(
    maxAgeMs: number = SCAN_CACHE_RETENTION_MS,
    nowMs: number = nowEpochMs()
  ): ScanCachePruneResult {
    const cutoff = nowMs - maxAgeMs;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const probeRes = this.#pruneProbeStmt.run(cutoff);
      const audioRes = this.#pruneAudioStmt.run(cutoff);
      this.#pruneMetadataStmt.run(nowMs);
      this.#db.exec('COMMIT');
      return {
        probeDeleted: Number(probeRes.changes),
        audioDeleted: Number(audioRes.changes)
      };
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  public getQueueState(): {
    readonly revision: number;
    readonly items: readonly ScannedItem[];
  } | null {
    const row = this.#getQueueStateStmt.get();
    if (!row || typeof row.revision !== 'number' || typeof row.items_json !== 'string') {
      return null;
    }
    const parsed: unknown = JSON.parse(row.items_json);
    return {
      revision: row.revision,
      items: Array.isArray(parsed) ? (parsed as readonly ScannedItem[]) : []
    };
  }

  public saveQueueState(
    revision: number,
    items: readonly ScannedItem[],
    nowMs: number = nowEpochMs()
  ): void {
    const itemsJson = JSON.stringify(items);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#saveQueueStateStmt.run(Math.trunc(revision), itemsJson, nowMs);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  #readSystemConfigObject(stmt: StatementSync): Record<string, unknown> | null {
    const row = stmt.get();
    if (!row || typeof row.value !== 'string') {
      return null;
    }
    const parsed: unknown = JSON.parse(row.value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  }

  #writeSystemConfigObject(stmt: StatementSync, payload: unknown): void {
    const json = JSON.stringify(payload);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      stmt.run(json);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  public getPreferences(): PersistedPreferences | null {
    return this.#readSystemConfigObject(this.#getPreferencesStmt);
  }

  public savePreferences(prefs: PersistedPreferences): void {
    this.#writeSystemConfigObject(this.#upsertPreferencesStmt, prefs);
  }

  public getConflictResolutions(): Partial<Record<ItemId, ConflictDecision>> {
    const parsed = this.#readSystemConfigObject(this.#getConflictResolutionsStmt);
    return parsed ? sanitizeConflictResolutions(parsed) : {};
  }

  public saveConflictResolutions(
    resolutions: Readonly<Partial<Record<ItemId, ConflictDecision>>>
  ): void {
    this.#writeSystemConfigObject(this.#upsertConflictResolutionsStmt, resolutions);
  }

  public getAllValidMetadata(nowMs: number = nowEpochMs()): readonly {
    readonly bucket: string;
    readonly cacheKey: string;
    readonly payloadJson: string;
    readonly expiresAt: number;
  }[] {
    const rows = this.#getValidMetadataStmt.all(nowMs);
    const result: {
      readonly bucket: string;
      readonly cacheKey: string;
      readonly payloadJson: string;
      readonly expiresAt: number;
    }[] = [];
    for (const row of rows) {
      if (
        typeof row.bucket === 'string' &&
        typeof row.cache_key === 'string' &&
        typeof row.payload_json === 'string' &&
        typeof row.expires_at === 'number'
      ) {
        result.push({
          bucket: row.bucket,
          cacheKey: row.cache_key,
          payloadJson: row.payload_json,
          expiresAt: row.expires_at
        });
      }
    }
    return result;
  }

  public setMetadata(
    bucket: string,
    cacheKey: string,
    payloadJson: string,
    expiresAt: number,
    nowMs: number = nowEpochMs()
  ): void {
    this.#upsertMetadataStmt.run(bucket, cacheKey, payloadJson, Math.trunc(expiresAt), nowMs);
  }

  public clearMetadata(): void {
    this.#clearMetadataStmt.run();
  }

  public async migrateLegacyJsonIfEmpty(
    configDir: string,
    nowMs: number = nowEpochMs()
  ): Promise<{ readonly importedProbes: number; readonly importedAudios: number }> {
    const probeCountRow = this.#db.prepare('SELECT COUNT(*) AS cnt FROM probe_cache').get();
    const audioCountRow = this.#db.prepare('SELECT COUNT(*) AS cnt FROM audio_cache').get();
    const queueCountRow = this.#db.prepare('SELECT COUNT(*) AS cnt FROM queue_state').get();
    const metaCountRow = this.#db.prepare('SELECT COUNT(*) AS cnt FROM metadata_cache').get();
    const probeEmpty = Number(probeCountRow?.cnt ?? 0) === 0;
    const audioEmpty = Number(audioCountRow?.cnt ?? 0) === 0;
    const queueEmpty = Number(queueCountRow?.cnt ?? 0) === 0;
    const metaEmpty = Number(metaCountRow?.cnt ?? 0) === 0;

    let importedProbes = 0;
    let importedAudios = 0;

    if (probeEmpty || audioEmpty) {
      const legacyProbes = probeEmpty
        ? await readLegacyEntries<MediaProbeSummary>(
            path.join(configDir, LEGACY_PROBE_CACHE_FILENAME)
          )
        : [];
      const legacyAudios = audioEmpty
        ? await readLegacyEntries<readonly AudioTrackAnalysis[]>(
            path.join(configDir, LEGACY_AUDIO_CACHE_FILENAME)
          )
        : [];
      if (legacyProbes.length > 0 || legacyAudios.length > 0) {
        this.#db.exec('BEGIN IMMEDIATE');
        try {
          for (const [key, summary] of legacyProbes) {
            this.setProbe(key, parseStatKeyMeta(key), summary, nowMs);
          }
          for (const [key, analyses] of legacyAudios) {
            this.setAudio(key, parseStatKeyMeta(key), analyses, nowMs);
          }
          this.#db.exec('COMMIT');
          importedProbes += legacyProbes.length;
          importedAudios += legacyAudios.length;
        } catch (err) {
          this.#db.exec('ROLLBACK');
          throw err;
        }
      }
      const prevSqliteCounts = await this.#migratePreviousScanCacheSqlite(
        path.join(configDir, PREVIOUS_SCAN_CACHE_DB_FILENAME),
        {
          needProbe: probeEmpty && importedProbes === 0,
          needAudio: audioEmpty && importedAudios === 0
        }
      );
      importedProbes += prevSqliteCounts.importedProbes;
      importedAudios += prevSqliteCounts.importedAudios;
    }

    if (queueEmpty) {
      await this.#migrateLegacyQueueJson(path.join(configDir, LEGACY_QUEUE_FILENAME), nowMs);
    }
    if (metaEmpty) {
      await this.#migrateLegacyMetadataJson(
        path.join(configDir, LEGACY_METADATA_CACHE_FILENAME),
        nowMs
      );
    }

    return { importedProbes, importedAudios };
  }

  async #migratePreviousScanCacheSqlite(
    prevPath: string,
    options: { readonly needProbe: boolean; readonly needAudio: boolean }
  ): Promise<{ readonly importedProbes: number; readonly importedAudios: number }> {
    const { needProbe, needAudio } = options;
    if (!needProbe && !needAudio) {
      return { importedProbes: 0, importedAudios: 0 };
    }
    try {
      await fs.access(prevPath);
    } catch {
      return { importedProbes: 0, importedAudios: 0 };
    }
    let prevDb: DatabaseSync | undefined;
    try {
      prevDb = new DatabaseSync(prevPath, { readOnly: true });
      let importedProbes = 0;
      let importedAudios = 0;
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        if (needProbe) {
          const rows = prevDb
            .prepare(
              'SELECT cache_key, relative_path, size_bytes, mtime_ms, payload_json, created_at, last_seen_at FROM probe_cache'
            )
            .all();
          const insertProbe = this.#db.prepare(`
            INSERT OR IGNORE INTO probe_cache (
              cache_key, relative_path, size_bytes, mtime_ms, payload_json, created_at, last_seen_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `);
          for (const row of rows) {
            insertProbe.run(
              row.cache_key ?? '',
              row.relative_path ?? '',
              row.size_bytes ?? 0,
              row.mtime_ms ?? 0,
              row.payload_json ?? '{}',
              row.created_at ?? 0,
              row.last_seen_at ?? 0
            );
            importedProbes += 1;
          }
        }
        if (needAudio) {
          const rows = prevDb
            .prepare(
              'SELECT cache_key, relative_path, size_bytes, mtime_ms, payload_json, created_at, last_seen_at FROM audio_cache'
            )
            .all();
          const insertAudio = this.#db.prepare(`
            INSERT OR IGNORE INTO audio_cache (
              cache_key, relative_path, size_bytes, mtime_ms, payload_json, created_at, last_seen_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `);
          for (const row of rows) {
            insertAudio.run(
              row.cache_key ?? '',
              row.relative_path ?? '',
              row.size_bytes ?? 0,
              row.mtime_ms ?? 0,
              row.payload_json ?? '[]',
              row.created_at ?? 0,
              row.last_seen_at ?? 0
            );
            importedAudios += 1;
          }
        }
        this.#db.exec('COMMIT');
      } catch (err) {
        this.#db.exec('ROLLBACK');
        throw err;
      }
      return { importedProbes, importedAudios };
    } catch {
      return { importedProbes: 0, importedAudios: 0 };
    } finally {
      prevDb?.close();
    }
  }

  async #migrateLegacyQueueJson(queuePath: string, nowMs: number): Promise<void> {
    try {
      const raw = await fs.readFile(queuePath, 'utf8');
      const parsed = JSON.parse(raw) as {
        readonly revision?: number;
        readonly items?: readonly ScannedItem[];
      };
      if (typeof parsed.revision === 'number' && Array.isArray(parsed.items)) {
        this.saveQueueState(parsed.revision, parsed.items, nowMs);
      }
    } catch {
      // No legacy queue.json or unreadable
    }
  }

  async #migrateLegacyMetadataJson(metaPath: string, nowMs: number): Promise<void> {
    try {
      const raw = await fs.readFile(metaPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 2) {
        return;
      }
      const buckets = [
        'movieSearch',
        'movieById',
        'tvSearch',
        'seriesById',
        'episodeMaps'
      ] as const;
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        for (const bucket of buckets) {
          const entries = parsed[bucket];
          if (Array.isArray(entries)) {
            this.#importMetadataBucketEntries(bucket, entries, nowMs);
          }
        }
        this.#db.exec('COMMIT');
      } catch (err) {
        this.#db.exec('ROLLBACK');
        throw err;
      }
    } catch {
      // No legacy metadata-cache.json or unreadable
    }
  }

  #importMetadataBucketEntries(bucket: string, entries: readonly unknown[], nowMs: number): void {
    for (const pair of entries) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        continue;
      }
      const [key, envelope] = pair as [unknown, unknown];
      if (typeof key !== 'string' || !envelope || typeof envelope !== 'object') {
        continue;
      }
      const candidate = envelope as {
        readonly value?: unknown;
        readonly expiresAt?: unknown;
      };
      if (
        typeof candidate.expiresAt === 'number' &&
        candidate.expiresAt > nowMs &&
        candidate.value !== undefined
      ) {
        this.setMetadata(bucket, key, JSON.stringify(candidate.value), candidate.expiresAt, nowMs);
      }
    }
  }

  public getEtaSamples(
    hostKey: string,
    workType: EtaWorkType,
    profile: EtaChannelProfile,
    limit = ETA_MAX_SAMPLES_PER_KEY
  ): readonly number[] {
    const safeLimit = Math.max(1, Math.min(ETA_MAX_SAMPLES_PER_KEY, Math.floor(limit)));
    const rows = this.#db
      .prepare(
        'SELECT throughput FROM eta_samples WHERE host_key = ? AND work_type = ? AND profile = ? ORDER BY id DESC LIMIT ?'
      )
      .all(hostKey, workType, profile, safeLimit) as Array<{ readonly throughput: number }>;
    return rows.map((row): number => row.throughput);
  }

  /** Preloads up to `limit` newest validated samples per `(work_type, profile)` for one host. */
  public getAllEtaSamplesForHost(
    hostKey: string,
    limitPerKey = ETA_MAX_SAMPLES_PER_KEY
  ): readonly EtaHostSampleGroup[] {
    const safeLimit = Math.max(1, Math.min(ETA_MAX_SAMPLES_PER_KEY, Math.floor(limitPerKey)));
    const rows = this.#db
      .prepare(
        'SELECT work_type, profile, throughput FROM eta_samples WHERE host_key = ? ORDER BY id DESC'
      )
      .all(hostKey) as Array<{
      readonly work_type: string;
      readonly profile: string;
      readonly throughput: number;
    }>;
    const groups: {
      readonly workType: EtaWorkType;
      readonly profile: EtaChannelProfile;
      samples: number[];
    }[] = [];
    const byKey = new Map<
      string,
      { readonly workType: EtaWorkType; readonly profile: EtaChannelProfile; samples: number[] }
    >();
    for (const row of rows) {
      const parsedWork = v.safeParse(EtaWorkTypeSchema, row.work_type);
      const parsedProfile = v.safeParse(EtaChannelProfileSchema, row.profile);
      if (!parsedWork.success || !parsedProfile.success) {
        continue;
      }
      const key = `${parsedWork.output}:${parsedProfile.output}`;
      let group = byKey.get(key);
      if (!group) {
        group = {
          workType: parsedWork.output,
          profile: parsedProfile.output,
          samples: []
        };
        byKey.set(key, group);
        groups.push(group);
      }
      if (group.samples.length < safeLimit) {
        group.samples.push(row.throughput);
      }
    }
    return groups;
  }

  public recordEtaSamplesBatch(
    samples: readonly EtaSampleInput[],
    maxPerKey = ETA_MAX_SAMPLES_PER_KEY,
    orphanTtlMs = ETA_ORPHAN_HOST_TTL_MS,
    nowMs = nowEpochMs()
  ): void {
    const validSamples = samples.filter(
      (sample): boolean =>
        Number.isFinite(sample.throughput) &&
        sample.throughput > 0 &&
        Number.isFinite(sample.workUnits) &&
        sample.workUnits > 0 &&
        Number.isFinite(sample.durationMs) &&
        sample.durationMs >= 1
    );
    if (validSamples.length === 0) {
      return;
    }
    const safeMax = Math.max(1, Math.floor(maxPerKey));
    const offset = safeMax - 1;
    const insertStmt = this.#db.prepare(`
      INSERT INTO eta_samples (
        host_key, work_type, profile, throughput, work_units, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const pruneStmt = this.#db.prepare(`
      DELETE FROM eta_samples
      WHERE host_key = ? AND work_type = ? AND profile = ?
        AND id < (
          SELECT id FROM eta_samples
          WHERE host_key = ? AND work_type = ? AND profile = ?
          ORDER BY id DESC LIMIT 1 OFFSET ?
        )
    `);
    const dirtyKeys = new Map<
      string,
      {
        readonly hostKey: string;
        readonly workType: EtaWorkType;
        readonly profile: EtaChannelProfile;
      }
    >();
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      for (const sample of validSamples) {
        insertStmt.run(
          sample.hostKey,
          sample.workType,
          sample.profile,
          sample.throughput,
          sample.workUnits,
          Math.max(1, Math.round(sample.durationMs)),
          sample.createdAt ?? nowMs
        );
        const key = `${sample.hostKey}::${sample.workType}::${sample.profile}`;
        if (!dirtyKeys.has(key)) {
          dirtyKeys.set(key, {
            hostKey: sample.hostKey,
            workType: sample.workType,
            profile: sample.profile
          });
        }
      }
      for (const dirty of dirtyKeys.values()) {
        pruneStmt.run(
          dirty.hostKey,
          dirty.workType,
          dirty.profile,
          dirty.hostKey,
          dirty.workType,
          dirty.profile,
          offset
        );
      }
      this.#db
        .prepare('DELETE FROM eta_samples WHERE created_at < ?')
        .run(nowMs - Math.max(1, orphanTtlMs));
      this.#db.exec('COMMIT;');
    } catch (err) {
      this.#db.exec('ROLLBACK;');
      throw err;
    }
  }

  /** Appends a server log entry and prunes older rows beyond `maxEntries`. */
  public appendLog(entry: SseLogEvent, maxEntries = MAX_SERVER_LOG_ENTRIES): void {
    if (this.#closed) {
      return;
    }
    const capped = Math.max(1, Math.trunc(maxEntries));
    this.#insertServerLogStmt.run(entry.level, entry.message, entry.timestamp);
    this.#pruneServerLogsStmt.run(capped);
  }

  /** Loads up to `limit` most recent server log entries in chronological order. */
  public loadRecentLogs(limit = MAX_SERVER_LOG_ENTRIES): SseLogEvent[] {
    if (this.#closed) {
      return [];
    }
    const capped = Math.max(1, Math.trunc(limit));
    const rows = this.#loadServerLogsStmt.all(capped) as Array<{
      readonly level: LogLevel;
      readonly message: string;
      readonly timestamp: string;
    }>;
    return rows.reverse().map((row) => ({
      level: row.level,
      message: row.message,
      timestamp: row.timestamp
    }));
  }

  /** Deletes all persisted server log entries. */
  public clearLogs(): void {
    if (this.#closed) {
      return;
    }
    this.#clearServerLogsStmt.run();
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      this.#db.exec('PRAGMA optimize;');
    } finally {
      this.#db.close();
    }
  }
}

function isUnwritableDbError(err: unknown): boolean {
  if (isPermissionOrReadOnlyError(err)) {
    return true;
  }
  const code =
    typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
      ? err.code
      : '';
  if (code === 'SQLITE_IOERR' || code === 'EIO') {
    return true;
  }
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    msg.includes('readonly') ||
    msg.includes('unable to open database file') ||
    msg.includes('permission denied') ||
    msg.includes('disk i/o error') ||
    msg.includes('sqlite_ioerr')
  );
}

/** Opens the unified SQLite database in `configDir`, falling back to `os.tmpdir()` when read-only. */
export async function openScanCacheDb(
  configDir: string,
  dbPathOverride?: string,
  onFallbackWarning?: (message: string) => void,
  skipLegacyMigration = false
): Promise<ScanCacheDb> {
  if (dbPathOverride === ':memory:') {
    return new ScanCacheDb(new DatabaseSync(':memory:'));
  }

  const primaryPath = dbPathOverride ?? path.join(configDir, APP_DB_FILENAME);
  const fallbackPath = getFallbackAppDbPath(configDir);
  let db: ScanCacheDb;
  try {
    if (!dbPathOverride && (await isDirUnwritable(configDir))) {
      throw new Error(`EACCES: directory ${configDir} is not writable`);
    }
    await fs.mkdir(path.dirname(primaryPath), { recursive: true });
    db = new ScanCacheDb(new DatabaseSync(primaryPath), primaryPath);
  } catch (err) {
    if (!isUnwritableDbError(err)) {
      throw err;
    }
    const uid = process.getuid?.() ?? 'unknown';
    const gid = process.getgid?.() ?? 'unknown';
    const warning = `CONFIG_DIR (${configDir} for uid=${String(uid)} gid=${String(gid)}) is not writable; falling back to ${fallbackPath}.`;
    if (onFallbackWarning) {
      onFallbackWarning(warning);
    } else {
      console.warn(warning);
    }
    db = new ScanCacheDb(new DatabaseSync(fallbackPath), fallbackPath);
  }

  if (!skipLegacyMigration) {
    await db.migrateLegacyJsonIfEmpty(configDir);
  }
  return db;
}

/** Runs a short-lived synchronous operation against an already-resolved SQLite path and closes immediately. */
export function withAppDbPathSync<T>(dbPath: string, fn: (db: ScanCacheDb) => T): T {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new ScanCacheDb(new DatabaseSync(dbPath), dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export interface FileStatCacheEntry {
  readonly key: string;
  readonly meta: ScanCacheFileMeta;
}

/** Computes a portable stat-based cache key (`[prefix]relativePosix::sizeBytes::mtimeMs`). */
export async function buildFileStatCacheEntry(
  filePath: string,
  relativePosixPath: string,
  keyPrefix = ''
): Promise<FileStatCacheEntry | null> {
  try {
    const stat = await fs.stat(filePath);
    const sizeBytes = Math.trunc(stat.size);
    const mtimeMs = Math.round(stat.mtimeMs);
    return {
      key: `${keyPrefix}${relativePosixPath}::${String(sizeBytes)}::${String(mtimeMs)}`,
      meta: { relativePath: relativePosixPath, sizeBytes, mtimeMs }
    };
  } catch {
    return null;
  }
}

/** Reads a cached `ffprobe` summary from SQLite or probes the file and persists immediately. */
export async function probeVideoWithCache(
  db: ScanCacheDb | undefined | null,
  filePath: string,
  relativePosixPath: string,
  probeFile: (targetPath: string) => Promise<MediaProbeSummary>,
  keyPrefix = '',
  onCacheResult?: (hit: boolean) => void
): Promise<MediaProbeSummary> {
  const statEntry = db
    ? await buildFileStatCacheEntry(filePath, relativePosixPath, keyPrefix)
    : null;
  if (db && statEntry) {
    const hit = db.getProbe(statEntry.key);
    if (hit) {
      onCacheResult?.(true);
      return hit;
    }
  }
  onCacheResult?.(false);
  const fresh = await probeFile(filePath);
  if (db && statEntry) {
    db.setProbe(statEntry.key, statEntry.meta, fresh);
  }
  return fresh;
}
