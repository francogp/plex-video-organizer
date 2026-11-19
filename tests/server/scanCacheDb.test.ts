import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import { SCAN_CACHE_RETENTION_MS } from '../../src/domain/constants.ts';
import {
  asIso639_2Code,
  asItemId,
  type AudioTrackAnalysis,
  type MediaProbeSummary
} from '../../src/domain/types.ts';
import { openScanCacheDb } from '../../src/server/services/scanCacheDb.ts';
import {
  enrichItemsWithAudioAnalysis,
  scanInputDirectory
} from '../../src/server/services/scanner.ts';

const SAMPLE_PROBE: MediaProbeSummary = {
  formatName: 'matroska',
  durationSeconds: 120,
  sizeBytes: 1024,
  bitrateBps: 500_000,
  videoStreams: [{ index: 0, codecName: 'h264', width: 1920, height: 1080 }],
  audioStreams: [
    {
      index: 1,
      streamOrder: 0,
      codecName: 'aac',
      language: asIso639_2Code('eng'),
      channels: 2,
      isDefault: true
    }
  ],
  subtitleStreams: []
};

const SAMPLE_AUDIO: readonly AudioTrackAnalysis[] = [
  {
    streamOrder: 0,
    meanVolumeDb: -18.5,
    maxVolumeDb: -2.0,
    recommendedGainDb: 2.5,
    suggestion: 'ok'
  }
];

describe('scanCacheDb (node:sqlite)', () => {
  it('initializes versioned STRICT tables in-memory, supports upsert/touch, and prunes expired rows', async () => {
    const db = await openScanCacheDb('', ':memory:');
    try {
      expect(db.getDbVersion()).toBe('20261117201500_add_server_logs_table');

      const t0 = 1_700_000_000_000;
      db.setProbe(
        'Movie.mkv::1024::1000',
        { relativePath: 'Movie.mkv', sizeBytes: 1024, mtimeMs: 1000 },
        SAMPLE_PROBE,
        t0
      );
      db.setAudio(
        'Movie.mkv::1024::1000',
        { relativePath: 'Movie.mkv', sizeBytes: 1024, mtimeMs: 1000 },
        SAMPLE_AUDIO,
        t0
      );

      // Touching only probe at t0 + 10 days refreshes its last_seen_at; audio stays at t0
      const t10Days = t0 + 10 * 24 * 60 * 60 * 1000;
      expect(db.getProbe('Movie.mkv::1024::1000', t10Days)?.durationSeconds).toBe(120);

      // At t0 + 15 days (> 14 days), stale audio is pruned while recently-seen probe survives
      const t15Days = t0 + SCAN_CACHE_RETENTION_MS + 24 * 60 * 60 * 1000;
      const pruned = db.pruneExpired(SCAN_CACHE_RETENTION_MS, t15Days);
      expect(pruned).toEqual({ probeDeleted: 0, audioDeleted: 1 });
      expect(db.getProbe('Movie.mkv::1024::1000', t15Days)).toBeDefined();
      expect(db.getAudio('Movie.mkv::1024::1000', t15Days)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('migrates legacy probe-cache.json and audio-cache.json on first open', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-sqlite-migrate-'));
    try {
      await fs.writeFile(
        path.join(tmpDir, 'probe-cache.json'),
        JSON.stringify([['Old.mkv::500::123', SAMPLE_PROBE]]),
        'utf8'
      );
      await fs.writeFile(
        path.join(tmpDir, 'audio-cache.json'),
        JSON.stringify([['Old.mkv::500::123', SAMPLE_AUDIO]]),
        'utf8'
      );

      const db = await openScanCacheDb(tmpDir);
      try {
        expect(db.getProbe('Old.mkv::500::123')).toEqual(SAMPLE_PROBE);
        expect(db.getAudio('Old.mkv::500::123')).toEqual(SAMPLE_AUDIO);
      } finally {
        db.close();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('preserves completed audio analyses in SQLite when a scan is cancelled mid-way', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-sqlite-cancel-'));
    const inputDir = path.join(tmpDir, 'input');
    const configDir = path.join(tmpDir, 'config');
    try {
      await fs.mkdir(inputDir, { recursive: true });
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(inputDir, 'A (2020).mkv'), 'a');
      await fs.writeFile(path.join(inputDir, 'B (2021).mkv'), 'b');

      const items = await scanInputDirectory(inputDir, async () => SAMPLE_PROBE, undefined, {
        configDir
      });
      expect(items).toHaveLength(2);

      let cancelled = false;
      const firstRunAnalyzed: string[] = [];
      await enrichItemsWithAudioAnalysis(
        items,
        configDir,
        async (filePath, streamOrder) => {
          firstRunAnalyzed.push(path.basename(filePath));
          cancelled = true;
          return {
            streamOrder,
            meanVolumeDb: -16,
            maxVolumeDb: -1,
            recommendedGainDb: 0,
            suggestion: 'ok'
          };
        },
        undefined,
        () => cancelled
      );
      expect(firstRunAnalyzed.length).toBeGreaterThanOrEqual(1);

      const secondRunAnalyzed: string[] = [];
      let reportedStats: { cacheHits: number; analyzed: number; pruned: number } | undefined;
      await enrichItemsWithAudioAnalysis(
        items,
        configDir,
        async (filePath, streamOrder) => {
          secondRunAnalyzed.push(path.basename(filePath));
          return {
            streamOrder,
            meanVolumeDb: -16,
            maxVolumeDb: -1,
            recommendedGainDb: 0,
            suggestion: 'ok'
          };
        },
        undefined,
        undefined,
        (stats) => {
          reportedStats = stats;
        }
      );

      // Every file completed before cancellation must be reused from SQLite without re-running FFmpeg
      for (const alreadyAnalyzed of firstRunAnalyzed) {
        expect(secondRunAnalyzed).not.toContain(alreadyAnalyzed);
      }
      expect(reportedStats?.cacheHits).toBe(firstRunAnalyzed.length);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('auto-migrates legacy queue.json, metadata-cache.json, and scan-cache.sqlite and supports queue/metadata CRUD', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-appdb-mig-'));
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const prevSqlite = new DatabaseSync(path.join(tmpDir, 'scan-cache.sqlite'));
      prevSqlite.exec(`
        CREATE TABLE probe_cache (
          cache_key TEXT PRIMARY KEY,
          relative_path TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          mtime_ms INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
        CREATE TABLE audio_cache (
          cache_key TEXT PRIMARY KEY,
          relative_path TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          mtime_ms INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
      `);
      prevSqlite
        .prepare('INSERT INTO probe_cache VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('Old.mkv::10::20', 'Old.mkv', 10, 20, JSON.stringify(SAMPLE_PROBE), 100, 200);
      prevSqlite
        .prepare('INSERT INTO audio_cache VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('Old.mkv::10::20', 'Old.mkv', 10, 20, JSON.stringify(SAMPLE_AUDIO), 100, 200);
      prevSqlite.close();

      await fs.writeFile(
        path.join(tmpDir, 'queue.json'),
        JSON.stringify({ revision: 7, items: [] }),
        'utf8'
      );
      const futureExp = Temporal.Now.instant().epochMilliseconds + 60_000;
      await fs.writeFile(
        path.join(tmpDir, 'metadata-cache.json'),
        JSON.stringify({
          version: 2,
          movieSearch: [['matrix', { value: [], expiresAt: futureExp }]],
          movieById: [],
          tvSearch: [],
          seriesById: [],
          episodeMaps: []
        }),
        'utf8'
      );

      const db = await openScanCacheDb(tmpDir);
      try {
        expect(db.getProbe('Old.mkv::10::20')).toEqual(SAMPLE_PROBE);
        expect(db.getAudio('Old.mkv::10::20')).toEqual(SAMPLE_AUDIO);
        expect(db.getQueueState()).toEqual({ revision: 7, items: [] });
        expect(db.getAllValidMetadata()).toHaveLength(1);

        db.saveQueueState(8, []);
        expect(db.getQueueState()?.revision).toBe(8);

        db.setMetadata('movieById', 'tt0133093', '{"title":"The Matrix"}', futureExp);
        expect(db.getAllValidMetadata()).toHaveLength(2);
        db.clearMetadata();
        expect(db.getAllValidMetadata()).toHaveLength(0);

        db.saveConflictResolutions({
          [asItemId('item-1')]: 'overwrite',
          [asItemId('item-2')]: 'ignore'
        });
        expect(db.getConflictResolutions()).toEqual({
          'item-1': 'overwrite',
          'item-2': 'ignore'
        });
      } finally {
        db.close();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('persists server logs in SQLite, caps at 500 entries, and clears cleanly', async () => {
    const db = await openScanCacheDb('', ':memory:');
    try {
      for (let i = 1; i <= 505; i += 1) {
        db.appendLog({
          level: i % 10 === 0 ? 'error' : 'info',
          message: `log-${String(i)}`,
          timestamp: `2026-11-17T20:00:${String(i % 60).padStart(2, '0')}Z`
        });
      }

      const loaded = db.loadRecentLogs();
      expect(loaded).toHaveLength(500);
      expect(loaded[0]?.message).toBe('log-6');
      expect(loaded[499]?.message).toBe('log-505');

      db.clearLogs();
      expect(db.loadRecentLogs()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('returns typed ETA sample groups and ignores retired or unknown work types from legacy SQLite rows', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-eta-legacy-'));
    const dbPath = path.join(tmpDir, 'plex-video-organizer.sqlite');
    const db = await openScanCacheDb(tmpDir);
    try {
      db.recordEtaSamplesBatch([
        {
          hostKey: 'env:nas',
          workType: 'finalize_io',
          profile: 'default',
          throughput: 40_000_000,
          workUnits: 40_000_000,
          durationMs: 1000
        }
      ]);
      db.close();

      const { DatabaseSync } = await import('node:sqlite');
      const raw = new DatabaseSync(dbPath);
      raw
        .prepare(
          'INSERT INTO eta_samples (host_key, work_type, profile, throughput, work_units, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run('env:nas', 'move_exdev', 'default', 25_000_000, 25_000_000, 1000, 1_700_000_000_000);
      raw.close();

      const reopened = await openScanCacheDb(tmpDir);
      try {
        expect(reopened.getAllEtaSamplesForHost('env:nas')).toEqual([
          { workType: 'finalize_io', profile: 'default', samples: [40_000_000] }
        ]);
      } finally {
        reopened.close();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
