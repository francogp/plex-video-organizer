import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it, vi } from 'vite-plus/test';

import {
  asIso639_2Code,
  type ActiveParallelTask,
  type MediaProbeSummary
} from '../../src/domain/types.ts';
import {
  enrichItemsWithAudioAnalysis,
  scanInputDirectory
} from '../../src/server/services/scanner.ts';

const MOCK_PROBE: MediaProbeSummary = {
  formatName: 'matroska',
  durationSeconds: 3600,
  sizeBytes: 1_500_000_000,
  bitrateBps: 3_000_000,
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

describe('scanner', () => {
  it('classifies movies, TV shows, subtitles in Subs/, and enforces Plex exclusions', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-scan-'));
    try {
      // Movie + Subs folder + .vtt + .forced.srt
      const movieDir = path.join(tmpDir, 'Inception (2010)');
      await fs.mkdir(path.join(movieDir, 'Subs'), { recursive: true });
      await fs.writeFile(path.join(movieDir, 'Inception.2010.1080p.mkv'), 'video');
      await fs.writeFile(path.join(movieDir, 'Subs', 'Inception.2010.1080p.es.forced.srt'), '1');
      await fs.writeFile(path.join(movieDir, 'Subs', 'Inception.2010.1080p.en.vtt'), 'WEBVTT');
      await fs.writeFile(path.join(movieDir, 'Inception.2010.1080p-trailer.mkv'), 'trailer');
      await fs.writeFile(path.join(movieDir, 'Inception.sample.mkv'), 'small sample');

      // TV show with Temporada + .plexmatch + Behind The Scenes extra
      const showDir = path.join(tmpDir, 'Fallout');
      await fs.mkdir(path.join(showDir, 'Temporada 1'), { recursive: true });
      await fs.mkdir(path.join(showDir, 'Behind The Scenes'), { recursive: true });
      await fs.writeFile(
        path.join(showDir, '.plexmatch'),
        'Title: Fallout\nYear: 2024\ntvdbid: 416744\n'
      );
      await fs.writeFile(path.join(showDir, 'Temporada 1', 'Fallout - 1x01.mp4'), 'ep1');
      await fs.writeFile(path.join(showDir, 'Behind The Scenes', 'making.mkv'), 'extra');

      // .plexignore and .iso exclusion
      await fs.writeFile(path.join(tmpDir, '.plexignore'), '*ignored*\n');
      await fs.writeFile(path.join(tmpDir, 'ignored-movie.mkv'), 'skip');
      await fs.writeFile(path.join(tmpDir, 'backup.iso'), 'iso');

      // Orphan temp file
      await fs.writeFile(path.join(tmpDir, 'Test.organizing.j1.i1.tmp.mkv'), 'tmp');

      const items = await scanInputDirectory(tmpDir, async () => MOCK_PROBE);
      expect(items).toHaveLength(2);

      const movie = items.find((i) => i.mediaKind === 'movie');
      expect(movie?.parsedTitle).toBe('Inception');
      expect(movie?.parsedYear).toBe(2010);
      expect(movie?.externalSubtitles).toHaveLength(2);
      expect(movie?.externalSubtitles.some((s) => s.isForced && s.language === 'spa')).toBe(true);
      expect(
        movie?.externalSubtitles.some((s) => s.extension === '.vtt' && s.language === 'eng')
      ).toBe(true);

      const tv = items.find((i) => i.mediaKind === 'tv');
      expect(tv?.parsedTitle).toBe('Fallout');
      expect(tv?.parsedYear).toBe(2024);
      expect(tv?.episode?.seasonNumber).toBe(1);
      expect(tv?.episode?.episodeStart).toBe(1);
      expect(tv?.selectedMetadata?.tvdbId).toBe('416744');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('handles date-based episodes, Specials, .idx+.sub VobSub pairs, and subtitle ambiguity', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-scan-edge-'));
    try {
      // Date-based TV show
      const dailyDir = path.join(tmpDir, 'Daily Show');
      await fs.mkdir(path.join(dailyDir, 'Specials'), { recursive: true });
      await fs.writeFile(path.join(dailyDir, 'Daily Show - 2024-03-15.mkv'), 'ymd');
      await fs.writeFile(path.join(dailyDir, 'Daily Show - 16-03-2024.mkv'), 'dmy');
      await fs.writeFile(path.join(dailyDir, 'Specials', 'Bonus.mkv'), 'special');

      // Movie with .idx+.sub pair AND binary .sub missing .idx AND duplicate language
      const movieDir = path.join(tmpDir, 'Matrix (1999)');
      await fs.mkdir(movieDir, { recursive: true });
      await fs.writeFile(path.join(movieDir, 'Matrix (1999).mkv'), 'video');
      await fs.writeFile(path.join(movieDir, 'Matrix (1999).en.sub'), Buffer.from([0x00, 0x01]));
      await fs.writeFile(path.join(movieDir, 'Matrix (1999).en.idx'), 'idx');
      await fs.writeFile(path.join(movieDir, 'Matrix (1999).fr.sub'), Buffer.from([0x00, 0x02]));

      const probeWithEngSub: MediaProbeSummary = {
        ...MOCK_PROBE,
        subtitleStreams: [
          {
            index: 2,
            streamOrder: 0,
            codecName: 'subrip',
            language: asIso639_2Code('eng'),
            isForced: false,
            isHearingImpaired: false
          }
        ]
      };

      const items = await scanInputDirectory(tmpDir, async () => probeWithEngSub);
      const ymdEp = items.find((i) => i.sourcePath.includes('2024-03-15'));
      expect(ymdEp?.mediaKind).toBe('tv');
      expect(ymdEp?.episode?.airDate).toBe('2024-03-15');

      const dmyEp = items.find((i) => i.sourcePath.includes('16-03-2024'));
      expect(dmyEp?.episode?.airDate).toBe('2024-03-16');

      const specialEp = items.find((i) => i.sourcePath.includes('Bonus.mkv'));
      expect(specialEp?.episode?.seasonNumber).toBe(0);

      const matrix = items.find((i) => i.sourcePath.includes('Matrix'));
      expect(matrix?.trackSelection.needsUserPrompt).toBe(true);
      const pairedSub = matrix?.externalSubtitles.find((s) => s.language === 'eng');
      expect(pairedSub?.idxPairPath).toContain('.idx');
      const orphanBinary = matrix?.externalSubtitles.find((s) => s.language === 'fra');
      expect(orphanBinary?.missingIdxWarning).toContain('missing its companion .idx');

      // MicroDVD text .sub + .plexignore negation + tags + splitPart
      await fs.writeFile(path.join(tmpDir, '.plexignore'), '# comment\n*.tmp.mkv\n!keep.mkv\n');
      const uhdDir = path.join(tmpDir, 'Blade Runner (1982)');
      await fs.mkdir(uhdDir, { recursive: true });
      await fs.writeFile(
        path.join(uhdDir, 'Blade Runner (1982) 2160p HDR Directors Cut - pt1.mkv'),
        'uhd'
      );
      await fs.writeFile(
        path.join(uhdDir, 'Blade Runner (1982) 2160p HDR Directors Cut - pt1.en.sub'),
        '{1}{100}Hello MicroDVD'
      );
      const uhdItems = await scanInputDirectory(uhdDir, async () => MOCK_PROBE);
      expect(uhdItems).toHaveLength(1);
      expect(uhdItems[0]?.splitPart).toBe('pt1');
      expect(uhdItems[0]?.externalSubtitles[0]?.missingIdxWarning).toBeUndefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('cascades .plexmatch hints, parses guid/pattern tokens, and applies episode overrides', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-plexmatch-'));
    try {
      const showDir = path.join(tmpDir, 'Arcane');
      const seasonDir = path.join(showDir, 'Season 02');
      await fs.mkdir(seasonDir, { recursive: true });
      await fs.writeFile(
        path.join(showDir, '.plexmatch'),
        ['title: Arcane', 'year: 2021', 'guid: tvdb://371028'].join('\n')
      );
      await fs.writeFile(
        path.join(seasonDir, '.plexmatch'),
        ['season: 2', 'pattern: {episode}', 'ep: S02E05: custom_file.mkv'].join('\n')
      );
      await fs.writeFile(path.join(seasonDir, 'custom_file.mkv'), 'ep');

      const items = await scanInputDirectory(tmpDir, async () => MOCK_PROBE);
      expect(items).toHaveLength(1);
      expect(items[0]?.parsedTitle).toBe('Arcane');
      expect(items[0]?.parsedYear).toBe(2021);
      expect(items[0]?.selectedMetadata?.tvdbId).toBe('371028');
      expect(items[0]?.episode?.seasonNumber).toBe(2);
      expect(items[0]?.episode?.episodeStart).toBe(5);

      const releaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-rel-'));
      try {
        await fs.writeFile(
          path.join(
            releaseDir,
            'Even.the.Student.Council.Has.Its.Holes.S01E01.1080p.UNCENSORED.OV.WEB-DL.ENG.AAC2.0.H.264.ESub-ToonsHub.mkv'
          ),
          'ep'
        );
        const relItems = await scanInputDirectory(releaseDir, async () => MOCK_PROBE);
        expect(relItems[0]?.parsedTitle).toBe('Even the Student Council Has Its Holes');
        expect(relItems[0]?.episode?.seasonNumber).toBe(1);
        expect(relItems[0]?.episode?.episodeStart).toBe(1);
      } finally {
        await fs.rm(releaseDir, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('analyzes audio tracks and reuses persistent audio-cache.json on unchanged files', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-audiocache-'));
    try {
      const inputDir = path.join(tmpDir, 'input');
      const configDir = path.join(tmpDir, 'config');
      await fs.mkdir(inputDir, { recursive: true });
      await fs.writeFile(path.join(inputDir, 'Movie.2024.1080p.mkv'), 'video-bytes');

      const items = await scanInputDirectory(inputDir, async () => MOCK_PROBE);
      expect(items).toHaveLength(1);

      let analyzeCalls = 0;
      const firstPass = await enrichItemsWithAudioAnalysis(items, configDir, async () => {
        analyzeCalls += 1;
        return {
          streamOrder: 0,
          meanVolumeDb: -19,
          maxVolumeDb: -5,
          suggestion: 'peak-gain',
          recommendedGainDb: 4
        };
      });
      expect(analyzeCalls).toBe(1);
      expect(firstPass[0]?.probe.audioAnalysis?.[0]?.suggestion).toBe('peak-gain');

      const secondPass = await enrichItemsWithAudioAnalysis(items, configDir, async () => {
        analyzeCalls += 1;
        return null;
      });
      expect(analyzeCalls).toBe(1);
      expect(secondPass[0]?.probe.audioAnalysis?.[0]?.recommendedGainDb).toBe(4);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not prompt when adding a new external subtitle language, and prompts on same-language collision', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-subcollision-'));
    try {
      const probeWithEngSub: MediaProbeSummary = {
        ...MOCK_PROBE,
        subtitleStreams: [
          {
            index: 2,
            streamOrder: 0,
            codecName: 'subrip',
            language: asIso639_2Code('eng'),
            isForced: false,
            isHearingImpaired: false
          }
        ]
      };

      // Case 1: Embedded eng + external spa -> no conflict
      const newLangDir = path.join(tmpDir, 'Star Trek (1966)');
      await fs.mkdir(newLangDir, { recursive: true });
      await fs.writeFile(path.join(newLangDir, 'Star.Trek.S01E01.mkv'), 'video');
      await fs.writeFile(
        path.join(newLangDir, 'Star.Trek.S01E01.es.srt'),
        '1\n00:00:01,000 --> 00:00:02,000\nHola'
      );

      // Case 2: Embedded eng + external eng -> real collision
      const sameLangDir = path.join(tmpDir, 'Arrival (2016)');
      await fs.mkdir(sameLangDir, { recursive: true });
      await fs.writeFile(path.join(sameLangDir, 'Arrival (2016).mkv'), 'video');
      await fs.writeFile(
        path.join(sameLangDir, 'Arrival (2016).en.srt'),
        '1\n00:00:01,000 --> 00:00:02,000\nHi'
      );

      const items = await scanInputDirectory(tmpDir, async () => probeWithEngSub);
      const starTrek = items.find((i) => i.sourcePath.includes('Star.Trek'));
      const arrival = items.find((i) => i.sourcePath.includes('Arrival'));

      expect(starTrek?.trackSelection.needsUserPrompt).toBe(false);
      expect(starTrek?.trackSelection.promptReason).toBeUndefined();

      expect(arrival?.trackSelection.needsUserPrompt).toBe(true);
      expect(arrival?.trackSelection.promptReason).toContain('existing embedded subtitle');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('reports byte-weighted intra-file progress during audio analysis', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-scan-eta-'));
    try {
      const f1 = path.join(tmpDir, 'Movie.A.2020.mkv');
      const f2 = path.join(tmpDir, 'Movie.B.2021.mkv');
      await fs.writeFile(f1, 'a');
      await fs.writeFile(f2, 'b');

      const items = await scanInputDirectory(tmpDir, async (filePath) => ({
        ...MOCK_PROBE,
        sizeBytes: filePath.includes('Movie.A') ? 100 : 300
      }));

      const fractions: number[] = [];
      await expect(enrichItemsWithAudioAnalysis([], tmpDir, async () => null)).resolves.toEqual([]);
      await enrichItemsWithAudioAnalysis(
        items,
        tmpDir,
        async (
          filePath: string,
          streamOrder: number,
          _duration?: number,
          onProgress?: (update: { readonly percent: number; readonly etaSeconds?: number }) => void
        ) => {
          onProgress?.({ percent: 50, etaSeconds: 5 });
          return {
            streamOrder,
            meanVolumeDb: filePath.includes('Movie.A') ? -18 : -16,
            maxVolumeDb: -1,
            recommendedGainDb: 0,
            suggestion: 'ok'
          };
        },
        (_completed, _total, _activeTasks, overallFraction) => {
          if (overallFraction !== undefined) {
            fractions.push(Number(overallFraction.toFixed(3)));
          }
        }
      );

      expect(fractions.length).toBeGreaterThanOrEqual(3);
      expect(fractions[fractions.length - 1]).toBe(1);

      let cancelled = false;
      const partial = await enrichItemsWithAudioAnalysis(
        [...items, items[0]!],
        path.join(tmpDir, 'cancel-cache'),
        async (_filePath, streamOrder, _dur, onProgress) => {
          onProgress?.({ percent: 50 });
          if (cancelled) {
            onProgress?.({ percent: 75 });
          }
          return {
            streamOrder,
            meanVolumeDb: -18,
            maxVolumeDb: -1,
            recommendedGainDb: 0,
            suggestion: 'ok'
          };
        },
        (completed) => {
          if (completed >= 1) {
            cancelled = true;
          }
        },
        () => cancelled
      );
      expect(partial).toHaveLength(1);

      const abortedScan = await scanInputDirectory(
        tmpDir,
        async () => MOCK_PROBE,
        () => true
      );
      expect(abortedScan).toEqual([]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('preserves leading bracketed titles like [REC] when scanning input files', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-scan-rec-'));
    try {
      await fs.writeFile(path.join(tmpDir, '[REC] 2 (2009) [1080p].mkv'), 'video');
      const items = await scanInputDirectory(tmpDir, async () => MOCK_PROBE);
      expect(items).toHaveLength(1);
      expect(items[0]?.parsedTitle).toBe('[REC] 2');
      expect(items[0]?.parsedYear).toBe(2009);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('completes audio enrichment and falls back to tmpdir when scan-cache.sqlite dir throws EACCES', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-scan-eacces-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const origMkdir = fs.mkdir.bind(fs);
    const mkdirSpy = vi.spyOn(fs, 'mkdir').mockImplementation(async (p, o) => {
      if (typeof p === 'string' && p.includes('readonly-cfg')) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return origMkdir(p, o);
    });

    try {
      await fs.writeFile(path.join(tmpDir, 'Movie.2020.mkv'), 'video');
      const items = await scanInputDirectory(tmpDir, async () => MOCK_PROBE);
      const analyzeSpy = vi.fn(async (_filePath: string, streamOrder: number) => ({
        streamOrder,
        meanVolumeDb: -16,
        maxVolumeDb: -1,
        recommendedGainDb: 0,
        suggestion: 'ok' as const
      }));
      const enriched = await enrichItemsWithAudioAnalysis(
        items,
        path.join(tmpDir, 'readonly-cfg'),
        analyzeSpy
      );
      expect(enriched).toHaveLength(1);
      expect(analyzeSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      const rehydrated = await enrichItemsWithAudioAnalysis(
        items,
        path.join(tmpDir, 'readonly-cfg'),
        analyzeSpy
      );
      expect(rehydrated).toHaveLength(1);
      expect(analyzeSpy).toHaveBeenCalledTimes(1);
    } finally {
      mkdirSpy.mockRestore();
      warnSpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
      const { createHash } = await import('node:crypto');
      const fallbackHash = createHash('sha256')
        .update(path.resolve(path.join(tmpDir, 'readonly-cfg')))
        .digest('hex')
        .slice(0, 8);
      const fallbackDb = path.join(os.tmpdir(), `plex-video-organizer-${fallbackHash}.sqlite`);
      await fs.rm(fallbackDb, { force: true });
      await fs.rm(`${fallbackDb}-wal`, { force: true });
      await fs.rm(`${fallbackDb}-shm`, { force: true });
    }
  });

  it('ignores QNAP .@__thumb, Synology @eaDir, hidden dotfiles, and temporary/partial files while honoring .plexignore and .plexmatch', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-scan-hidden-'));
    try {
      await fs.mkdir(path.join(tmpDir, '.@__thumb'), { recursive: true });
      await fs.writeFile(
        path.join(
          tmpDir,
          '.@__thumb',
          'defaultGodzilla vs Kong (2021) 2160p HDR 5.1 x265 10bit Phun Psyz.mkv'
        ),
        'thumb'
      );
      await fs.writeFile(
        path.join(
          tmpDir,
          '.@__thumb',
          's100Godzilla vs Kong (2021) 2160p HDR 5.1 x265 10bit Phun Psyz.mkv'
        ),
        'thumb'
      );
      await fs.mkdir(path.join(tmpDir, '@eaDir'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, '@eaDir', 'SynologyThumb.mkv'), 'thumb');
      await fs.writeFile(path.join(tmpDir, '.hidden-movie.mkv'), 'hidden');
      await fs.writeFile(path.join(tmpDir, '._Real Movie (2024).mkv'), 'appledouble');
      await fs.writeFile(path.join(tmpDir, '._Real Movie (2024).eng.srt'), 'appledouble-sub');
      await fs.writeFile(path.join(tmpDir, 'Real Movie (2024).eng.srt.tmp'), 'tmp-sub');
      await fs.writeFile(path.join(tmpDir, 'Downloading (2024).mkv.!qB'), 'partial');
      await fs.writeFile(path.join(tmpDir, 'Staging (2024).tmp.mkv'), 'staging');
      await fs.writeFile(path.join(tmpDir, '.plexignore'), 'Blocked Movie*\n');
      await fs.writeFile(path.join(tmpDir, 'Blocked Movie (2024).mkv'), 'ignored');
      await fs.writeFile(path.join(tmpDir, 'Real Movie (2024).mkv'), 'video');
      await fs.writeFile(
        path.join(tmpDir, 'Real Movie (2024).spa.srt'),
        '1\n00:00:01,000 --> 00:00:02,000\nHola\n'
      );

      const items = await scanInputDirectory(tmpDir, async () => MOCK_PROBE);
      expect(items).toHaveLength(1);
      expect(items[0]?.fileName).toBe('Real Movie (2024).mkv');
      expect(items[0]?.externalSubtitles).toHaveLength(1);
      expect(items[0]?.externalSubtitles[0]?.relativePath).toBe('Real Movie (2024).spa.srt');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('reports slot-indexed activeTasks across concurrent audio analysis workers', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-scan-slots-'));
    try {
      const names = ['Alpha.2020.mkv', 'Bravo.2021.mkv', 'Charlie.2022.mkv', 'Delta.2023.mkv'];
      for (const name of names) {
        await fs.writeFile(path.join(tmpDir, name), name);
      }

      const items = await scanInputDirectory(tmpDir, async () => MOCK_PROBE);
      expect(items).toHaveLength(4);

      const snapshots: {
        readonly completed: number;
        readonly activeTasks: readonly ActiveParallelTask[];
      }[] = [];
      const releases: (() => void)[] = [];
      let allFirstBatchStarted!: () => void;
      const firstBatchBarrier = new Promise<void>((resolve) => {
        allFirstBatchStarted = resolve;
      });
      let startedCount = 0;

      await enrichItemsWithAudioAnalysis(
        items,
        path.join(tmpDir, 'cfg'),
        async (_filePath, streamOrder, _dur, onProgress) => {
          startedCount += 1;
          const waitPromise =
            startedCount <= 3
              ? new Promise<void>((resolve) => {
                  releases.push(resolve);
                })
              : Promise.resolve();
          onProgress?.({ percent: 50, etaSeconds: 5 });
          if (startedCount === 3) {
            allFirstBatchStarted();
            queueMicrotask(() => {
              for (const release of releases.splice(0)) {
                release();
              }
            });
          }
          await waitPromise;
          return {
            streamOrder,
            meanVolumeDb: -18,
            maxVolumeDb: -1,
            recommendedGainDb: 0,
            suggestion: 'ok'
          };
        },
        (completed, _total, activeTasks) => {
          snapshots.push({ completed, activeTasks: activeTasks.map((t) => ({ ...t })) });
        }
      );

      await firstBatchBarrier;
      const peakSnapshot = snapshots.find((s) => s.activeTasks.length === 3);
      expect(peakSnapshot).toBeDefined();
      expect(peakSnapshot?.activeTasks.map((t) => t.slot)).toEqual([0, 1, 2]);
      expect(new Set(peakSnapshot?.activeTasks.map((t) => t.fileName)).size).toBe(3);

      const peakProgressSnapshot = snapshots.find(
        (s) => s.activeTasks.length === 3 && s.activeTasks.every((t) => t.percent === 50)
      );
      expect(peakProgressSnapshot).toBeDefined();

      const lastSnapshot = snapshots.at(-1);
      expect(lastSnapshot?.completed).toBe(4);
      expect(lastSnapshot?.activeTasks).toEqual([]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('persists probe-cache.json, skips unchanged files on rescan, and reports probe progress', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-probe-cache-'));
    const inputDir = path.join(tmpDir, 'input');
    const configDir = path.join(tmpDir, 'config');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });

    try {
      const fileA = path.join(inputDir, 'Alpha (2024).mkv');
      const fileB = path.join(inputDir, 'Bravo (2024).mkv');
      await fs.writeFile(fileA, 'alpha-content');
      await fs.writeFile(fileB, 'bravo-content');

      let probeCalls = 0;
      const progressEvents: { readonly completed: number; readonly total: number }[] = [];

      const firstItems = await scanInputDirectory(
        inputDir,
        async () => {
          probeCalls += 1;
          return MOCK_PROBE;
        },
        undefined,
        {
          configDir,
          onProgress: (completed, total) => {
            progressEvents.push({ completed, total });
          }
        }
      );

      expect(firstItems).toHaveLength(2);
      expect(probeCalls).toBe(2);
      expect(progressEvents.at(-1)).toEqual({ completed: 2, total: 2 });

      const dbStat = await fs.stat(path.join(configDir, 'plex-video-organizer.sqlite'));
      expect(dbStat.isFile()).toBe(true);

      probeCalls = 0;
      const secondItems = await scanInputDirectory(
        inputDir,
        async () => {
          probeCalls += 1;
          return MOCK_PROBE;
        },
        undefined,
        { configDir }
      );

      expect(secondItems).toHaveLength(2);
      expect(probeCalls).toBe(0);

      // Mutate fileA size -> only fileA should be re-probed
      await fs.writeFile(fileA, 'alpha-content-modified');
      probeCalls = 0;
      const thirdItems = await scanInputDirectory(
        inputDir,
        async () => {
          probeCalls += 1;
          return MOCK_PROBE;
        },
        undefined,
        { configDir }
      );

      expect(thirdItems).toHaveLength(2);
      expect(probeCalls).toBe(1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('keys probe-cache.json and audio-cache.json by relative POSIX path so cache survives inputDir root changes', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-rel-cache-'));
    const mountA = path.join(tmpDir, 'mount-a');
    const mountB = path.join(tmpDir, 'mount-b');
    const configDir = path.join(tmpDir, 'config');
    await fs.mkdir(path.join(mountA, 'Movies'), { recursive: true });
    await fs.mkdir(configDir, { recursive: true });

    try {
      await fs.writeFile(path.join(mountA, 'Movies', 'Film (2024).mkv'), 'film-bytes');

      let probeCalls = 0;
      let audioCalls = 0;
      const scannedA = await scanInputDirectory(
        mountA,
        async () => {
          probeCalls += 1;
          return MOCK_PROBE;
        },
        undefined,
        { configDir }
      );
      await enrichItemsWithAudioAnalysis(scannedA, configDir, async (_p, streamOrder) => {
        audioCalls += 1;
        return {
          streamOrder,
          meanVolumeDb: -16,
          maxVolumeDb: -1,
          recommendedGainDb: 0,
          suggestion: 'ok'
        };
      });
      expect(probeCalls).toBe(1);
      expect(audioCalls).toBe(1);

      const db = new DatabaseSync(path.join(configDir, 'plex-video-organizer.sqlite'));
      const probeRows = db.prepare('SELECT cache_key FROM probe_cache').all();
      const audioRows = db.prepare('SELECT cache_key FROM audio_cache').all();
      db.close();
      expect(String(probeRows[0]?.cache_key).startsWith('Movies/Film (2024).mkv::')).toBe(true);
      expect(String(audioRows[0]?.cache_key).startsWith('Movies/Film (2024).mkv::')).toBe(true);

      // Simulate switching host/container inputDir root (mountA -> mountB)
      await fs.rename(mountA, mountB);
      probeCalls = 0;
      audioCalls = 0;
      const scannedB = await scanInputDirectory(
        mountB,
        async () => {
          probeCalls += 1;
          return MOCK_PROBE;
        },
        undefined,
        { configDir }
      );
      await enrichItemsWithAudioAnalysis(scannedB, configDir, async (_p, streamOrder) => {
        audioCalls += 1;
        return {
          streamOrder,
          meanVolumeDb: -16,
          maxVolumeDb: -1,
          recommendedGainDb: 0,
          suggestion: 'ok'
        };
      });
      expect(probeCalls).toBe(0);
      expect(audioCalls).toBe(0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('reports activeFraction excluding cache hits so ETA does not climb on resumed scans', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-scan-eta-'));
    try {
      const configDir = path.join(tmpDir, 'config');
      const inputDir = path.join(tmpDir, 'input');
      await fs.mkdir(inputDir, { recursive: true });
      await fs.writeFile(path.join(inputDir, 'Cached (2024).mkv'), 'a'.repeat(300));

      const firstItems = await scanInputDirectory(inputDir, async () => MOCK_PROBE, undefined, {
        configDir
      });
      await enrichItemsWithAudioAnalysis(firstItems, configDir, async (_p, streamOrder) => ({
        streamOrder,
        meanVolumeDb: -16,
        maxVolumeDb: -1,
        recommendedGainDb: 0,
        suggestion: 'ok'
      }));

      await fs.writeFile(path.join(inputDir, 'Pending (2025).mkv'), 'b'.repeat(100));
      const secondItems = await scanInputDirectory(inputDir, async () => MOCK_PROBE, undefined, {
        configDir
      });

      const progressSamples: Array<{
        readonly overall: number | undefined;
        readonly active: number | undefined;
      }> = [];
      await enrichItemsWithAudioAnalysis(
        secondItems,
        configDir,
        async (filePath, streamOrder, _dur, onProg) => {
          if (filePath.includes('Pending')) {
            onProg?.({ percent: 50 });
          }
          return {
            streamOrder,
            meanVolumeDb: -16,
            maxVolumeDb: -1,
            recommendedGainDb: 0,
            suggestion: 'ok'
          };
        },
        (_completed, _total, _tasks, overall, active) => {
          progressSamples.push({ overall, active });
        }
      );

      const midSample = progressSamples.find(
        (s) => s.overall !== undefined && s.overall > 0.7 && s.overall < 1
      );
      expect(midSample).toBeDefined();
      expect(midSample?.active).toBeCloseTo(0.5, 1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('analyzes only the first available included audio track (preferring Default) during scan', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-single-audio-scan-'));
    const inputDir = path.join(tmpDir, 'input');
    const configDir = path.join(tmpDir, 'config');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });

    try {
      await fs.writeFile(path.join(inputDir, 'MultiAudio (2025).mkv'), 'multi');
      const multiProbe: MediaProbeSummary = {
        ...MOCK_PROBE,
        audioStreams: [
          {
            index: 1,
            streamOrder: 0,
            codecName: 'aac',
            language: asIso639_2Code('eng'),
            channels: 2,
            isDefault: false
          },
          {
            index: 2,
            streamOrder: 1,
            codecName: 'aac',
            language: asIso639_2Code('spa'),
            channels: 2,
            isDefault: true
          },
          {
            index: 3,
            streamOrder: 2,
            codecName: 'aac',
            language: asIso639_2Code('jpn'),
            channels: 2,
            isDefault: false
          }
        ]
      };

      const items = await scanInputDirectory(inputDir, async () => multiProbe, undefined, {
        configDir,
        audioPreferredLanguages: ['eng', 'spa', 'jpn']
      });
      expect(items[0]?.trackSelection.audioTracks.every((t) => t.include)).toBe(true);

      const analyzedStreamOrders: number[] = [];
      const enriched = await enrichItemsWithAudioAnalysis(
        items,
        configDir,
        async (_filePath, streamOrder) => {
          analyzedStreamOrders.push(streamOrder);
          return {
            streamOrder,
            meanVolumeDb: -16,
            maxVolumeDb: -1,
            recommendedGainDb: 0,
            suggestion: 'ok'
          };
        }
      );

      expect(analyzedStreamOrders).toEqual([1]);
      expect(enriched[0]?.probe.audioAnalysis).toHaveLength(1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('strips standalone Sxx and COMPLETE markers from season folder titles', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-scan-complete-'));
    try {
      const folder = path.join(
        tmpDir,
        'Foundation.S03.COMPLETE.2160p.ATVP.WEB-DL.DV.P5.DDP5.1.Atmos.H265.MP4-BEN.THE.MEN'
      );
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(
        path.join(folder, 'Foundation.S03E10.2160p.ATVP.WEB-DL.DV.P5[Ben The Men].mp4'),
        'v'
      );

      const items = await scanInputDirectory(tmpDir, async () => MOCK_PROBE);
      expect(items).toHaveLength(1);
      expect(items[0]?.parsedTitle).toBe('Foundation');
      expect(items[0]?.episode?.seasonNumber).toBe(3);
      expect(items[0]?.episode?.episodeStart).toBe(10);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects trailing .spa subtitle language instead of release tag FRA in video stem', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-scan-sub-lang-'));
    try {
      const folder = path.join(
        tmpDir,
        'The.Frame.2014.FRA.1080p.AMZN.WEB-DL.DDP.2.0.H264-DDR[EtHD]'
      );
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(
        path.join(folder, 'The.Frame.2014.FRA.1080p.AMZN.WEB-DL.DDP.2.0.H264-DDR[EtHD].mkv'),
        'v'
      );
      await fs.writeFile(
        path.join(folder, 'The.Frame.2014.FRA.1080p.AMZN.WEB-DL.DDP.2.0.H264-DDR[EtHD].spa.srt'),
        '1\n00:00:01,000 --> 00:00:02,000\nHola\n'
      );

      const items = await scanInputDirectory(tmpDir, async () => ({
        ...MOCK_PROBE,
        subtitleStreams: [
          {
            index: 2,
            streamOrder: 0,
            codecName: 'subrip',
            language: asIso639_2Code('fra'),
            isForced: false,
            isHearingImpaired: false
          }
        ]
      }));

      expect(items).toHaveLength(1);
      expect(items[0]?.externalSubtitles[0]?.language).toBe('spa');
      expect(items[0]?.trackSelection.needsUserPrompt).toBe(false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
