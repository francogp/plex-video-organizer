import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vite-plus/test';

import {
  asIso639_2Code,
  asItemId,
  asJobId,
  type MediaProbeSummary,
  type ScannedItem
} from '../../src/domain/types.ts';
import {
  backupAndCleanupAfterJob,
  buildOrganizingTempFileName,
  cleanupOrphanTempFiles,
  moveTempOutputFile,
  purgeExpiredBackups
} from '../../src/server/services/fileMover.ts';

const EMPTY_PROBE: MediaProbeSummary = {
  formatName: 'matroska',
  durationSeconds: 100,
  sizeBytes: 100,
  bitrateBps: 100,
  videoStreams: [],
  audioStreams: [],
  subtitleStreams: []
};

describe('fileMover', () => {
  it('enforces TOCTOU guard, moves temp output, and runs deferred cleanup preserving unselected items', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-move-'));
    try {
      const inputDir = path.join(tmpDir, 'input');
      const outputDir = path.join(tmpDir, 'output');
      const movieDir = path.join(inputDir, 'MovieA');
      const subsDir = path.join(movieDir, 'Subs');
      const ignoredDir = path.join(inputDir, 'MovieB_Ignored');
      await fs.mkdir(subsDir, { recursive: true });
      await fs.mkdir(ignoredDir, { recursive: true });
      await fs.mkdir(outputDir, { recursive: true });

      const srcVideo = path.join(movieDir, 'MovieA.mkv');
      const subFile = path.join(subsDir, 'MovieA.es.srt');
      const posterFile = path.join(movieDir, 'poster.jpg');
      const torrentJunkDir = path.join(movieDir, 'Torrent Downloaded From');
      const torrentJunkFile = path.join(torrentJunkDir, 'info.txt');
      const ignoredVideo = path.join(ignoredDir, 'MovieB.mkv');
      const tempMkv = path.join(movieDir, 'MovieA.organizing.dev.j1.i1.tmp.mkv');
      const orphanTmp = path.join(ignoredDir, 'Other.organizing.dev.j0.i0.tmp.mkv');

      await fs.mkdir(torrentJunkDir, { recursive: true });
      await fs.writeFile(srcVideo, 'source');
      await fs.writeFile(subFile, '1');
      await fs.writeFile(posterFile, 'img');
      await fs.writeFile(torrentJunkFile, 'junk');
      await fs.writeFile(ignoredVideo, 'keep-me');
      await fs.writeFile(orphanTmp, 'orphan');

      const removedOrphans = await cleanupOrphanTempFiles(inputDir, { serverTag: 'dev' });
      expect(removedOrphans).toBe(1);

      await fs.writeFile(tempMkv, 'remuxed');

      const destPath = path.join(outputDir, 'MovieA (2020)', 'MovieA (2020).mkv');
      await moveTempOutputFile(tempMkv, destPath, false);
      await expect(fs.readFile(destPath, 'utf8')).resolves.toBe('remuxed');

      // TOCTOU guard blocks overwrite when allowOverwrite is false
      await fs.writeFile(tempMkv, 'remuxed2');
      await expect(moveTempOutputFile(tempMkv, destPath, false)).rejects.toThrow('TOCTOU guard');
      await fs.rm(tempMkv, { force: true });

      const movedItem: ScannedItem = {
        id: asItemId('i1'),
        sourcePath: srcVideo,
        relativePath: 'MovieA/MovieA.mkv',
        fileName: 'MovieA.mkv',
        mediaKind: 'movie',
        category: 'movies',
        include: true,
        parsedTitle: 'MovieA',
        tags: [],
        probe: EMPTY_PROBE,
        externalSubtitles: [
          {
            path: subFile,
            relativePath: 'MovieA/Subs/MovieA.es.srt',
            extension: '.srt',
            language: asIso639_2Code('spa'),
            isForced: false,
            isHearingImpaired: false,
            isLanguageAmbiguous: false
          }
        ],
        candidates: [],
        episodeOrder: 'aired',
        trackSelection: {
          audioTracks: [],
          subtitleMergeMode: 'keep-and-add',
          includedInternalSubtitles: [],
          externalSubtitleOrder: [subFile],
          needsUserPrompt: false
        },
        warnings: []
      };

      const backupDir = path.join(tmpDir, 'backup');
      await fs.mkdir(path.join(backupDir, 'MovieA'), { recursive: true });
      await fs.writeFile(path.join(backupDir, 'MovieA', 'MovieA.mkv'), 'older-different-bytes');
      await backupAndCleanupAfterJob([movedItem], inputDir, backupDir);

      // Moved folder removed, ignored folder & inputDir preserved, source + sub backed up (with collision suffix)
      await expect(fs.access(movieDir)).rejects.toThrow(/ENOENT/i);
      await expect(fs.readFile(ignoredVideo, 'utf8')).resolves.toBe('keep-me');
      await fs.access(inputDir);
      const movieABackups = await fs.readdir(path.join(backupDir, 'MovieA'));
      const suffixedBackup = movieABackups.find(
        (f) => f.startsWith('MovieA.') && f !== 'MovieA.mkv'
      );
      expect(suffixedBackup).toBeDefined();
      await expect(
        fs.readFile(path.join(backupDir, 'MovieA', suffixedBackup!), 'utf8')
      ).resolves.toBe('source');
      await expect(
        fs.readFile(path.join(backupDir, 'MovieA', 'Subs', 'MovieA.es.srt'), 'utf8')
      ).resolves.toBe('1');

      // Deduplication: identical content under a different name is not duplicated in backupDir
      const dupDir = path.join(inputDir, 'MovieA_Dup');
      await fs.mkdir(dupDir, { recursive: true });
      const dupVideo = path.join(dupDir, 'MovieA.renamed.mkv');
      await fs.writeFile(dupVideo, 'source');
      await backupAndCleanupAfterJob(
        [
          {
            ...movedItem,
            id: asItemId('i-dup'),
            sourcePath: dupVideo,
            relativePath: 'MovieA_Dup/MovieA.renamed.mkv',
            fileName: 'MovieA.renamed.mkv',
            externalSubtitles: []
          }
        ],
        inputDir,
        backupDir
      );
      await expect(
        fs.access(path.join(backupDir, 'MovieA_Dup', 'MovieA.renamed.mkv'))
      ).rejects.toThrow(/ENOENT/i);

      // Same relative path with different content creates timestamp-disambiguated backup
      await fs.mkdir(movieDir, { recursive: true });
      await fs.writeFile(srcVideo, 'source-modified');
      await backupAndCleanupAfterJob(
        [{ ...movedItem, externalSubtitles: [] }],
        inputDir,
        backupDir
      );
      const backupEntries = await fs.readdir(path.join(backupDir, 'MovieA'));
      expect(
        backupEntries.some((name) => name.startsWith('MovieA.') && name !== 'MovieA.mkv')
      ).toBe(true);

      // Retention purge: files older than 7 days are removed; fresh files are kept
      const eightDaysAgoSec = (Temporal.Now.instant().epochMilliseconds - 8 * 86_400_000) / 1000;
      const oldBackupFile = path.join(backupDir, 'MovieA', 'Subs', 'MovieA.es.srt');
      await fs.utimes(oldBackupFile, eightDaysAgoSec, eightDaysAgoSec);
      const purged = await purgeExpiredBackups(backupDir);
      expect(purged.removedFiles).toBe(1);
      await expect(fs.access(oldBackupFile)).rejects.toThrow(/ENOENT/i);
      await expect(
        fs.readFile(path.join(backupDir, 'MovieA', suffixedBackup!), 'utf8')
      ).resolves.toBe('source');

      const missingPurged = await purgeExpiredBackups(path.join(tmpDir, 'missing-backup'));
      expect(missingPurged.removedFiles).toBe(0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls back to copyFile + atomic rename when fs.rename throws EXDEV', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-exdev-'));
    try {
      const src = path.join(tmpDir, 'src.tmp.mkv');
      const dest = path.join(tmpDir, 'out', 'Movie (2024).mkv');
      await fs.writeFile(src, 'payload-bytes');

      const realRename = fs.rename.bind(fs);
      const spy = vi
        .spyOn(fs, 'rename')
        .mockRejectedValueOnce(Object.assign(new Error('cross-device'), { code: 'EXDEV' }))
        .mockImplementation(realRename);

      const progressUpdates: number[] = [];
      await moveTempOutputFile(src, dest, true, (pct) => {
        progressUpdates.push(pct);
      });
      await expect(fs.readFile(dest, 'utf8')).resolves.toBe('payload-bytes');
      await expect(fs.access(src)).rejects.toThrow(/ENOENT/i);
      expect(progressUpdates.at(-1)).toBe(100);
      spy.mockRestore();

      await fs.writeFile(src, 'new-bytes');
      await expect(moveTempOutputFile(src, dest, false)).rejects.toThrow(/TOCTOU guard/i);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('backupAndCleanupAfterJob removes folders containing only .@__thumb and .DS_Store leftovers while preserving folders with active .!qB downloads', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-clean-hidden-'));
    try {
      const inputDir = path.join(tmpDir, 'input');
      const backupDir = path.join(tmpDir, 'backup');
      const movieDir = path.join(inputDir, 'MovieA');
      const showDir = path.join(inputDir, 'ShowB');
      await fs.mkdir(path.join(movieDir, '.@__thumb'), { recursive: true });
      await fs.mkdir(showDir, { recursive: true });

      const movieSrc = path.join(movieDir, 'MovieA.mkv');
      const ep1Src = path.join(showDir, 'S01E01.mkv');
      const activePartial = path.join(showDir, 'InProgress', 'S01E02.mkv.!qB');
      await fs.mkdir(path.dirname(activePartial), { recursive: true });
      await fs.mkdir(path.join(inputDir, '@Recycle'), { recursive: true });
      const recycleOrphan = path.join(inputDir, '@Recycle', 'Old.organizing.dev.j1.i1.tmp.mkv');
      const regularOrphan = path.join(inputDir, 'Regular.organizing.dev.j1.i1.tmp.mkv');
      await fs.writeFile(recycleOrphan, 'keep-recycle');
      await fs.writeFile(regularOrphan, 'remove-orphan');
      await fs.writeFile(movieSrc, 'movie-bytes');
      await fs.writeFile(path.join(movieDir, '.@__thumb', 'defaultMovieA.mkv'), 'thumb');
      await fs.writeFile(path.join(movieDir, '.DS_Store'), 'junk');
      await fs.writeFile(ep1Src, 'ep1-bytes');
      await fs.writeFile(activePartial, 'active-download');

      const items: ScannedItem[] = [
        {
          id: asItemId('m1'),
          sourcePath: movieSrc,
          relativePath: 'MovieA/MovieA.mkv',
          fileName: 'MovieA.mkv',
          mediaKind: 'movie',
          category: 'movies',
          include: true,
          parsedTitle: 'MovieA',
          tags: [],
          episodeOrder: 'aired',
          probe: EMPTY_PROBE,
          externalSubtitles: [],
          candidates: [],
          trackSelection: {
            audioTracks: [],
            subtitleMergeMode: 'keep-and-add',
            includedInternalSubtitles: [],
            externalSubtitleOrder: [],
            needsUserPrompt: false
          },
          warnings: []
        },
        {
          id: asItemId('s1'),
          sourcePath: ep1Src,
          relativePath: 'ShowB/S01E01.mkv',
          fileName: 'S01E01.mkv',
          mediaKind: 'tv',
          category: 'tv-shows',
          include: true,
          parsedTitle: 'ShowB',
          tags: [],
          episodeOrder: 'aired',
          probe: EMPTY_PROBE,
          externalSubtitles: [],
          candidates: [],
          trackSelection: {
            audioTracks: [],
            subtitleMergeMode: 'keep-and-add',
            includedInternalSubtitles: [],
            externalSubtitleOrder: [],
            needsUserPrompt: false
          },
          warnings: []
        }
      ];

      await backupAndCleanupAfterJob(items, inputDir, backupDir);
      await expect(fs.access(movieDir)).rejects.toThrow(/ENOENT/);
      await expect(fs.readFile(activePartial, 'utf8')).resolves.toBe('active-download');
      const cleanedCount = await cleanupOrphanTempFiles(inputDir, { serverTag: 'dev' });
      expect(cleanedCount).toBe(1);
      await expect(fs.readFile(recycleOrphan, 'utf8')).resolves.toBe('keep-recycle');
      await expect(fs.access(regularOrphan)).rejects.toThrow(/ENOENT/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('isolates cleanupOrphanTempFiles by serverTag and optional jobId without touching other servers or untagged temps', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-temp-iso-'));
    try {
      const inputDir = path.join(tmpDir, 'input');
      const showDir = path.join(inputDir, 'Foundation');
      await fs.mkdir(showDir, { recursive: true });

      const devJob1Name = buildOrganizingTempFileName(
        'Ep1',
        'dev',
        asJobId('job1'),
        asItemId('i1')
      );
      const devJob2Name = buildOrganizingTempFileName(
        'Ep2',
        'dev',
        asJobId('job2'),
        asItemId('i2')
      );
      const nasJob1Name = buildOrganizingTempFileName(
        'Ep3',
        'nas',
        asJobId('b04e90cd'),
        asItemId('i3')
      );
      expect(devJob1Name).toBe('Ep1.organizing.dev.job1.i1.tmp.mkv');
      expect(nasJob1Name).toBe('Ep3.organizing.nas.b04e90cd.i3.tmp.mkv');

      const devJob1 = path.join(showDir, devJob1Name);
      const devJob2 = path.join(showDir, devJob2Name);
      const nasJob1 = path.join(showDir, nasJob1Name);
      const legacyUntagged = path.join(showDir, 'Ep4.organizing.b04e90cd.9fbcdb12dec4.tmp.mkv');

      await Promise.all([
        fs.writeFile(devJob1, 'dev1'),
        fs.writeFile(devJob2, 'dev2'),
        fs.writeFile(nasJob1, 'nas1'),
        fs.writeFile(legacyUntagged, 'legacy')
      ]);

      const scopedDeleted = await cleanupOrphanTempFiles(inputDir, {
        serverTag: 'dev',
        jobId: asJobId('job1')
      });
      expect(scopedDeleted).toBe(1);
      await expect(fs.access(devJob1)).rejects.toThrow(/ENOENT/);
      await expect(fs.readFile(devJob2, 'utf8')).resolves.toBe('dev2');
      await expect(fs.readFile(nasJob1, 'utf8')).resolves.toBe('nas1');
      await expect(fs.readFile(legacyUntagged, 'utf8')).resolves.toBe('legacy');

      const serverDeleted = await cleanupOrphanTempFiles(inputDir, { serverTag: 'dev' });
      expect(serverDeleted).toBe(1);
      await expect(fs.access(devJob2)).rejects.toThrow(/ENOENT/);
      await expect(fs.readFile(nasJob1, 'utf8')).resolves.toBe('nas1');
      await expect(fs.readFile(legacyUntagged, 'utf8')).resolves.toBe('legacy');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
