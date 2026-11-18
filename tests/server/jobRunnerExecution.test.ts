import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  asClientId,
  asIso639_2Code,
  asTvdbId,
  type MediaProbeSummary,
  type SseProgressEvent
} from '../../src/domain/types.ts';
import { loadConfig } from '../../src/server/config.ts';

const MOCK_PROBE: MediaProbeSummary = {
  formatName: 'matroska',
  durationSeconds: 120,
  sizeBytes: 1_000_000,
  bitrateBps: 2_000_000,
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

vi.mock('../../src/server/services/media/ffmpegRunner.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/server/services/media/ffmpegRunner.ts')>();
  return {
    ...actual,
    probeMedia: vi.fn(async () => MOCK_PROBE),
    analyzeAudioVolume: vi.fn(async () => ({
      streamOrder: 0,
      meanVolumeDb: -24,
      maxVolumeDb: -5,
      suggestion: 'loudnorm',
      recommendedGainDb: 4
    })),
    measureLoudnormPass1: vi.fn(
      async (
        _path: string,
        _stream: number,
        _downmix: boolean,
        _dur?: number,
        onProgress?: (update: { readonly percent: number; readonly etaSeconds?: number }) => void
      ) => {
        onProgress?.({ percent: 50, etaSeconds: 10 });
        return {
          inputI: '-24.0',
          inputTp: '-5.0',
          inputLra: '8.0',
          inputThresh: '-34.0',
          targetOffset: '0.5'
        };
      }
    ),
    runFfmpegRemux: vi.fn(
      async (
        args: readonly string[],
        _dur: number,
        onProgress: (percent: number, etaSeconds?: number) => void
      ) => {
        const outPath = args.at(-1)!;
        await fs.writeFile(outPath, 'remuxed-mkv');
        onProgress(50, 5);
        onProgress(100, 0);
      }
    )
  };
});

vi.mock('../../src/server/services/metadata/imdbClient.ts', () => ({
  searchMovies: vi.fn(async () => [
    { title: 'Arrival', year: 2016, imdbId: 'tt2543164', source: 'imdb' }
  ]),
  lookupMovieByImdbId: vi.fn(async () => ({
    title: 'Arrival',
    year: 2016,
    imdbId: 'tt2543164',
    source: 'omdb'
  }))
}));

vi.mock('../../src/server/services/metadata/tvdbClient.ts', () => ({
  searchTvShows: vi.fn(async () => [
    { title: 'Dark', year: 2017, tvdbId: '334824', source: 'tvdb' }
  ]),
  lookupSeriesByTvdbId: vi.fn(async () => undefined),
  lookupSeriesByTvmazeId: vi.fn(async () => undefined),
  fetchEpisodeTitleMap: vi.fn(async () => new Map([['1:1', 'Secrets']]))
}));

import { JobRunner } from '../../src/server/services/jobRunner.ts';

describe('JobRunner execution pipeline', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('scans movie + TV show, patches metadata, searches, runs preflight, and completes remux+move job', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-exec-'));
    const inputDir = path.join(tmpDir, 'input');
    const outputMovies = path.join(tmpDir, 'movies');
    const outputTv = path.join(tmpDir, 'tv');
    const configDir = path.join(tmpDir, 'config');
    await fs.mkdir(path.join(inputDir, 'Arrival (2016)'), { recursive: true });
    await fs.mkdir(path.join(inputDir, 'Dune (2021)'), { recursive: true });
    await fs.mkdir(path.join(inputDir, 'Dark', 'Season 01'), { recursive: true });
    await fs.mkdir(outputMovies, { recursive: true });
    await fs.mkdir(outputTv, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });

    await fs.writeFile(path.join(inputDir, 'Arrival (2016)', 'Arrival.2016.mkv'), 'movie-bytes');
    await fs.writeFile(path.join(inputDir, 'Dune (2021)', 'Dune.2021.mkv'), 'dune-bytes');
    await fs.writeFile(
      path.join(inputDir, 'Arrival (2016)', 'Arrival.2016.es.srt'),
      '1\n00:00:01,000 --> 00:00:02,000\nHola\n'
    );
    await fs.writeFile(path.join(inputDir, 'Dark', 'Season 01', 'Dark.S01E01.mkv'), 'tv-bytes');

    const cfg = loadConfig({
      CONFIG_DIR: configDir,
      INPUT_DIR: inputDir,
      OUTPUT_MOVIES_DIR: outputMovies,
      OUTPUT_DOCUMENTARIES_DIR: outputMovies,
      OUTPUT_ANIMATED_MOVIES_DIR: outputMovies,
      OUTPUT_TV_SHOWS_DIR: outputTv,
      OUTPUT_ANIMATED_SERIES_DIR: outputTv
    });

    const runner = new JobRunner(cfg);
    await runner.init();

    const events: string[] = [];
    const progressEvents: SseProgressEvent[] = [];
    const unsub = runner.subscribe({
      send(evt, data) {
        events.push(evt);
        if (evt === 'progress') {
          progressEvents.push(data as SseProgressEvent);
        }
      }
    });

    const clientId = asClientId('exec:1');
    runner.startScan(clientId);

    // Wait for async #executeScan to settle to READY
    for (let i = 0; i < 40 && runner.getState().phase !== 'READY'; i += 1) {
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(runner.getState().phase).toBe('READY');
    expect(runner.getState().items).toHaveLength(3);

    const tvItem = runner.getState().items.find((i) => i.mediaKind === 'tv')!;
    const ignoredItem = runner.getState().items.find((i) => i.fileName.includes('Dune'))!;
    expect(tvItem.episode?.episodeTitle).toBe('Secrets');

    // Search metadata branches
    await expect(
      runner.searchMetadata(clientId, {
        query: 'tt2543164',
        kind: 'movie',
        imdbId: 'tt2543164'
      })
    ).resolves.toHaveLength(1);
    await expect(
      runner.searchMetadata(clientId, { query: 'Arrival', kind: 'movie' })
    ).resolves.toHaveLength(1);
    await expect(
      runner.searchMetadata(clientId, { query: 'Dark', kind: 'tv' })
    ).resolves.toHaveLength(1);

    // Patch TV item order + audio normalization, and exclude ignoredItem (include: false)
    let patched = await runner.patchItem(clientId, runner.getState().revision, ignoredItem.id, {
      include: false
    });
    patched = await runner.patchItem(clientId, patched.revision, tvItem.id, {
      episodeOrder: 'dvd',
      selectedMetadata: tvItem.selectedMetadata,
      audioNormalization: { mode: 'loudnorm', codec: 'auto', downmixStereo: false }
    });

    // Preflight & startJob
    const report = await runner.preflight(clientId, patched.revision);
    expect(report.ok).toBe(true);

    await runner.startJob(clientId, report.revision, {});
    for (let i = 0; i < 50 && runner.getState().phase !== 'IDLE'; i += 1) {
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(runner.getState().phase).toBe('IDLE');
    expect(runner.getState().items.map((i) => i.id)).toEqual([ignoredItem.id]);
    expect(events).toContain('progress');
    expect(events).toContain('log');
    expect(
      progressEvents.some(
        (evt) =>
          evt.stageLabel?.startsWith('Analyzing audio') &&
          evt.activeTasks.length > 0 &&
          evt.activeTasks.every((task) => typeof task.slot === 'number' && task.fileName.length > 0)
      )
    ).toBe(true);
    expect(
      progressEvents.some(
        (evt) =>
          evt.stageLabel?.startsWith('Fetching metadata') &&
          evt.activeTasks.length === 1 &&
          evt.activeTasks[0]?.slot === 0
      )
    ).toBe(true);
    expect(
      progressEvents.some(
        (evt) =>
          evt.stageLabel?.startsWith('Loudnorm Pass 1/2') &&
          evt.activeTasks.some(
            (task) => task.fileName.includes('audio #1 (eng)') && task.percent === 50
          )
      )
    ).toBe(true);
    expect(
      progressEvents.some((evt) => evt.stageLabel === 'Cleanup' || evt.stageLabel === 'Cleaning up')
    ).toBe(true);
    expect(
      progressEvents.some((evt) => evt.stageLabel === 'Cleaning up' && evt.activeTasks.length === 1)
    ).toBe(true);

    unsub();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('handles PREFLIGHT_BLOCKED conflicts, unresolved conflict error, overwrite, and remux failure', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-exec-err-'));
    const inputDir = path.join(tmpDir, 'input');
    const outputMovies = path.join(tmpDir, 'movies');
    const configDir = path.join(tmpDir, 'config');
    await fs.mkdir(path.join(inputDir, 'sub1'), { recursive: true });
    await fs.mkdir(path.join(inputDir, 'sub2'), { recursive: true });
    await fs.mkdir(outputMovies, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });

    await fs.writeFile(path.join(inputDir, 'sub1', 'Arrival (2016).mkv'), 'movie-bytes-1');
    await fs.writeFile(path.join(inputDir, 'sub2', 'Arrival (2016).mkv'), 'movie-bytes-2');

    const cfg = loadConfig({
      CONFIG_DIR: configDir,
      INPUT_DIR: inputDir,
      OUTPUT_MOVIES_DIR: outputMovies,
      OUTPUT_DOCUMENTARIES_DIR: outputMovies,
      OUTPUT_ANIMATED_MOVIES_DIR: outputMovies,
      OUTPUT_TV_SHOWS_DIR: outputMovies,
      OUTPUT_ANIMATED_SERIES_DIR: outputMovies
    });

    const runner = new JobRunner(cfg);
    await runner.init();
    const clientId = asClientId('exec2:1');
    runner.startScan(clientId);
    for (let i = 0; i < 40 && runner.getState().phase !== 'READY'; i += 1) {
      await new Promise((r) => setTimeout(r, 15));
    }

    const report = await runner.preflight(clientId, runner.getState().revision);
    expect(report.ok).toBe(false);
    expect(report.conflicts.length).toBeGreaterThanOrEqual(1);
    expect(runner.getState().phase).toBe('PREFLIGHT_BLOCKED');

    // Unresolved conflict throws
    await expect(runner.startJob(clientId, report.revision, {})).rejects.toThrow(
      'Unresolved conflict'
    );

    // Make ffmpeg fail on both attempt 1 and deferred retry attempt 2 to exercise ERROR path
    const ffmpegMod = await import('../../src/server/services/media/ffmpegRunner.ts');
    vi.mocked(ffmpegMod.runFfmpegRemux)
      .mockRejectedValueOnce(new Error('ffmpeg crashed'))
      .mockRejectedValueOnce(new Error('ffmpeg crashed again'));

    const resolutions: Record<string, 'overwrite' | 'ignore'> = {};
    for (const c of report.conflicts) {
      resolutions[c.itemId] = Object.keys(resolutions).length === 0 ? 'overwrite' : 'ignore';
    }
    await runner.startJob(clientId, report.revision, resolutions);
    for (let i = 0; i < 40 && runner.getState().phase !== 'ERROR'; i += 1) {
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(runner.getState().phase).toBe('ERROR');

    await runner.unlock(clientId, false);
    expect(runner.getState().phase).toBe('IDLE');
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('populates queue with completed items when scan is cancelled via unlock', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-scan-cancel-'));
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');
    const configDir = path.join(tmpDir, 'config');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(inputDir, 'Movie.One.2020.mkv'), 'a');
    await fs.writeFile(path.join(inputDir, 'Movie.Two.2021.mkv'), 'b');

    const ffmpegMod = await import('../../src/server/services/media/ffmpegRunner.ts');
    let releaseSecond!: () => void;
    const secondWait = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let callCount = 0;
    vi.mocked(ffmpegMod.analyzeAudioVolume).mockImplementation(async () => {
      callCount += 1;
      if (callCount > 1) {
        await secondWait;
      }
      return {
        streamOrder: 0,
        meanVolumeDb: -20,
        maxVolumeDb: -2,
        suggestion: 'ok',
        recommendedGainDb: 0
      };
    });

    const { JobRunner } = await import('../../src/server/services/jobRunner.ts');
    const runner = new JobRunner(
      loadConfig({
        CONFIG_DIR: configDir,
        INPUT_DIR: inputDir,
        OUTPUT_MOVIES_DIR: outputDir,
        OUTPUT_DOCUMENTARIES_DIR: outputDir,
        OUTPUT_ANIMATED_MOVIES_DIR: outputDir,
        OUTPUT_TV_SHOWS_DIR: outputDir,
        OUTPUT_ANIMATED_SERIES_DIR: outputDir
      })
    );
    await runner.init();

    const clientId = asClientId('c1:t1');
    runner.startScan(clientId);
    for (
      let i = 0;
      i < 40 &&
      (!(runner.getState().activeJob?.stageLabel?.startsWith('Analyzing audio') ?? false) ||
        (runner.getState().activeJob?.completedItems ?? 0) < 1);
      i += 1
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const unlockPromise = runner.unlock(clientId, false);
    releaseSecond();
    const state = await unlockPromise;

    expect(state.phase).toBe('READY');
    expect(state.items.length).toBeGreaterThanOrEqual(1);
    expect(state.activeJob).toBeNull();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('keeps unprocessed items and removes completed items when processing job is cancelled via unlock', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-job-cancel-'));
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');
    const configDir = path.join(tmpDir, 'config');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(inputDir, 'Arrival.2016.mkv'), 'a');
    await fs.writeFile(path.join(inputDir, 'Dark.S01E01.mkv'), 'b');

    const ffmpegMod = await import('../../src/server/services/media/ffmpegRunner.ts');
    vi.mocked(ffmpegMod.analyzeAudioVolume).mockResolvedValue({
      streamOrder: 0,
      meanVolumeDb: -20,
      maxVolumeDb: -2,
      suggestion: 'ok',
      recommendedGainDb: 0
    });

    let releaseSecondRemux!: () => void;
    const secondRemuxWait = new Promise<void>((resolve) => {
      releaseSecondRemux = resolve;
    });
    let remuxCount = 0;
    vi.mocked(ffmpegMod.runFfmpegRemux).mockImplementation(async (args, _dur, onProgress) => {
      remuxCount += 1;
      const outPath = args.at(-1)!;
      if (remuxCount > 1) {
        await secondRemuxWait;
      }
      await fs.writeFile(outPath, 'remuxed');
      onProgress(100, 0);
    });

    const { JobRunner } = await import('../../src/server/services/jobRunner.ts');
    const runner = new JobRunner(
      loadConfig({
        CONFIG_DIR: configDir,
        INPUT_DIR: inputDir,
        OUTPUT_MOVIES_DIR: outputDir,
        OUTPUT_DOCUMENTARIES_DIR: outputDir,
        OUTPUT_ANIMATED_MOVIES_DIR: outputDir,
        OUTPUT_TV_SHOWS_DIR: outputDir,
        OUTPUT_ANIMATED_SERIES_DIR: outputDir
      })
    );
    await runner.init();

    const clientId = asClientId('c1:t1');
    runner.startScan(clientId);
    for (let i = 0; i < 40 && runner.getState().phase !== 'READY'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(runner.getState().items).toHaveLength(2);

    const preflight = await runner.preflight(clientId, runner.getState().revision);
    await runner.startJob(clientId, preflight.revision, {});

    for (let i = 0; i < 40 && (runner.getState().activeJob?.completedItems ?? 0) < 1; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const unlockPromise = runner.unlock(clientId, false);
    releaseSecondRemux();
    const state = await unlockPromise;

    expect(state.phase).toBe('READY');
    expect(state.items).toHaveLength(1);
    expect(state.activeJob).toBeNull();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('finishes in-flight task and refreshes READY queue with pending items when requestDrain is called', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-job-drain-'));
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');
    const configDir = path.join(tmpDir, 'config');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(inputDir, 'Arrival.2016.mkv'), 'a');
    await fs.writeFile(path.join(inputDir, 'Dark.S01E01.mkv'), 'b');
    await fs.writeFile(path.join(inputDir, 'Dark.S01E02.mkv'), 'c');

    const ffmpegMod = await import('../../src/server/services/media/ffmpegRunner.ts');
    vi.mocked(ffmpegMod.analyzeAudioVolume).mockResolvedValue({
      streamOrder: 0,
      meanVolumeDb: -20,
      maxVolumeDb: -2,
      suggestion: 'ok',
      recommendedGainDb: 0
    });

    let remuxStarted!: () => void;
    const remuxStartedPromise = new Promise<void>((resolve) => {
      remuxStarted = resolve;
    });
    let releaseInFlight!: () => void;
    const inFlightWait = new Promise<void>((resolve) => {
      releaseInFlight = resolve;
    });
    vi.mocked(ffmpegMod.runFfmpegRemux).mockImplementation(async (args, _dur, onProgress) => {
      remuxStarted();
      await inFlightWait;
      await fs.writeFile(args.at(-1)!, 'remuxed');
      onProgress(100, 0);
    });

    const { JobRunner } = await import('../../src/server/services/jobRunner.ts');
    const runner = new JobRunner(
      loadConfig({
        CONFIG_DIR: configDir,
        INPUT_DIR: inputDir,
        OUTPUT_MOVIES_DIR: outputDir,
        OUTPUT_DOCUMENTARIES_DIR: outputDir,
        OUTPUT_ANIMATED_MOVIES_DIR: outputDir,
        OUTPUT_TV_SHOWS_DIR: outputDir,
        OUTPUT_ANIMATED_SERIES_DIR: outputDir
      })
    );
    await runner.init();

    const clientId = asClientId('c1:drain');
    try {
      runner.startScan(clientId);
      for (let i = 0; i < 40 && runner.getState().phase !== 'READY'; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(runner.getState().items).toHaveLength(3);

      const preflight = await runner.preflight(clientId, runner.getState().revision);
      const resolutions: Record<string, 'overwrite'> = {};
      for (const conflict of preflight.conflicts) {
        resolutions[conflict.itemId] = 'overwrite';
      }
      await runner.startJob(clientId, preflight.revision, resolutions);

      await remuxStartedPromise;

      const drainingState = runner.requestDrain(clientId);
      expect(drainingState.activeJob?.drainRequested).toBe(true);

      releaseInFlight();
      for (let i = 0; i < 60 && runner.getState().phase === 'PROCESSING'; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const finalState = runner.getState();
      expect(finalState.phase).toBe('READY');
      expect(finalState.activeJob).toBeNull();
      expect(finalState.items.length).toBeGreaterThan(0);
      expect(finalState.items.length).toBeLessThan(3);
    } finally {
      releaseInFlight();
      await runner.unlock(clientId, true).catch(() => undefined);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('auto-classifies animated metadata to animated libraries and reclassifies when normal metadata is selected', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-animated-cat-'));
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');
    const configDir = path.join(tmpDir, 'config');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(inputDir, 'Anime.Show.S01E01.mkv'), 'a');

    const tvdbMod = await import('../../src/server/services/metadata/tvdbClient.ts');
    vi.mocked(tvdbMod.searchTvShows).mockResolvedValueOnce([
      {
        title: 'Anime Show',
        year: 2026,
        tvdbId: asTvdbId('463051'),
        isAnimated: true,
        source: 'tvmaze'
      }
    ]);

    const { JobRunner } = await import('../../src/server/services/jobRunner.ts');
    const runner = new JobRunner(
      loadConfig({
        CONFIG_DIR: configDir,
        INPUT_DIR: inputDir,
        OUTPUT_MOVIES_DIR: outputDir,
        OUTPUT_DOCUMENTARIES_DIR: outputDir,
        OUTPUT_ANIMATED_MOVIES_DIR: outputDir,
        OUTPUT_TV_SHOWS_DIR: outputDir,
        OUTPUT_ANIMATED_SERIES_DIR: outputDir
      })
    );
    await runner.init();

    const clientId = asClientId('c1:t1');
    runner.startScan(clientId);
    for (let i = 0; i < 40 && runner.getState().phase !== 'READY'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const scannedItem = runner.getState().items[0]!;
    expect(scannedItem.category).toBe('animated-series');

    const patchedNormal = await runner.patchItem(
      clientId,
      runner.getState().revision,
      scannedItem.id,
      {
        selectedMetadata: {
          title: 'Live Action Show',
          year: 2026,
          tvdbId: asTvdbId('999'),
          source: 'tvmaze'
        }
      }
    );
    expect(patchedNormal.items[0]?.category).toBe('tv-shows');

    const patchedAnimatedMovie = await runner.patchItem(
      clientId,
      patchedNormal.revision,
      scannedItem.id,
      {
        mediaKind: 'movie',
        selectedMetadata: {
          title: 'Animated Film',
          year: 2025,
          isAnimated: true,
          source: 'omdb'
        }
      }
    );
    expect(patchedAnimatedMovie.items[0]?.category).toBe('animated-movies');
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('emits slot-indexed activeTasks for parallel audio tracks during Loudnorm Pass 1/2', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-loudnorm-slots-'));
    const inputDir = path.join(tmpDir, 'input');
    const outputMovies = path.join(tmpDir, 'movies');
    const configDir = path.join(tmpDir, 'config');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(outputMovies, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(inputDir, 'Dual.Audio.2024.mkv'), 'dual-audio-movie');

    const dualProbe: MediaProbeSummary = {
      ...MOCK_PROBE,
      audioStreams: [
        {
          index: 1,
          streamOrder: 0,
          codecName: 'aac',
          language: asIso639_2Code('eng'),
          channels: 2,
          isDefault: true
        },
        {
          index: 2,
          streamOrder: 1,
          codecName: 'aac',
          language: asIso639_2Code('spa'),
          channels: 2,
          isDefault: false
        }
      ]
    };

    const ffmpegMod = await import('../../src/server/services/media/ffmpegRunner.ts');
    vi.mocked(ffmpegMod.probeMedia).mockResolvedValue(dualProbe);
    const expectedConcurrency = Math.min(2, Math.max(1, os.cpus().length));
    const releases: (() => void)[] = [];
    vi.mocked(ffmpegMod.measureLoudnormPass1).mockImplementation(
      async (_path, _stream, _downmix, _dur, onProgress) => {
        onProgress?.({ percent: 40, etaSeconds: 8 });
        if (expectedConcurrency > 1) {
          await new Promise<void>((resolve) => {
            releases.push(resolve);
            if (releases.length === expectedConcurrency) {
              queueMicrotask(() => {
                for (const release of releases.splice(0)) {
                  release();
                }
              });
            }
          });
        }
        return {
          inputI: '-24.0',
          inputTp: '-5.0',
          inputLra: '8.0',
          inputThresh: '-34.0',
          targetOffset: '0.5'
        };
      }
    );

    const cfg = loadConfig({
      CONFIG_DIR: configDir,
      INPUT_DIR: inputDir,
      OUTPUT_MOVIES_DIR: outputMovies,
      OUTPUT_DOCUMENTARIES_DIR: outputMovies,
      OUTPUT_ANIMATED_MOVIES_DIR: outputMovies,
      OUTPUT_TV_SHOWS_DIR: outputMovies,
      OUTPUT_ANIMATED_SERIES_DIR: outputMovies
    });

    const runner = new JobRunner(cfg);
    await runner.init();
    const progressEvents: SseProgressEvent[] = [];
    const unsub = runner.subscribe({
      send(evt, data) {
        if (evt === 'progress') {
          progressEvents.push(data as SseProgressEvent);
        }
      }
    });

    const clientId = asClientId('loudnorm:1');
    runner.startScan(clientId);
    for (let i = 0; i < 40 && runner.getState().phase !== 'READY'; i += 1) {
      await new Promise((r) => setTimeout(r, 15));
    }

    const scannedItem = runner.getState().items[0]!;
    const patched = await runner.patchItem(clientId, runner.getState().revision, scannedItem.id, {
      trackSelection: {
        audioTracks: [
          { streamOrder: 0, include: true, language: asIso639_2Code('eng'), isDefault: true },
          { streamOrder: 1, include: true, language: asIso639_2Code('spa'), isDefault: false }
        ],
        subtitleMergeMode: 'keep-and-add',
        includedInternalSubtitles: [],
        externalSubtitleOrder: [],
        needsUserPrompt: false,
        audioNormalization: { mode: 'loudnorm', codec: 'auto', downmixStereo: false }
      }
    });

    const report = await runner.preflight(clientId, patched.revision);
    await runner.startJob(clientId, report.revision, {});
    for (let i = 0; i < 50 && runner.getState().phase !== 'IDLE'; i += 1) {
      await new Promise((r) => setTimeout(r, 15));
    }

    const loudnormEvents = progressEvents.filter((e) =>
      e.stageLabel?.startsWith('Loudnorm Pass 1/2')
    );
    expect(loudnormEvents.length).toBeGreaterThan(0);
    const peakEvent = loudnormEvents.find((e) => e.activeTasks.length === expectedConcurrency);
    expect(peakEvent).toBeDefined();
    expect(peakEvent?.activeTasks.some((t) => t.fileName.includes('audio #1 (eng)'))).toBe(true);
    if (expectedConcurrency > 1) {
      expect(peakEvent?.activeTasks.some((t) => t.fileName.includes('audio #2 (spa)'))).toBe(true);
    }

    unsub();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('unifies episodes sharing tvdbId to tvdb title and returns all provider options sorted by media kind', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-unify-tvdb-'));
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');
    const configDir = path.join(tmpDir, 'config');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(inputDir, 'Title A.2026.s01e05.mkv'), 'a');
    await fs.writeFile(path.join(inputDir, 'Title B.2026.s01e06.mkv'), 'b');

    const ffmpegMod = await import('../../src/server/services/media/ffmpegRunner.ts');
    vi.mocked(ffmpegMod.analyzeAudioVolume).mockResolvedValue({
      streamOrder: 0,
      meanVolumeDb: -20,
      maxVolumeDb: -2,
      suggestion: 'ok',
      recommendedGainDb: 0
    });

    const tvdbMod = await import('../../src/server/services/metadata/tvdbClient.ts');
    vi.mocked(tvdbMod.searchTvShows).mockImplementation(async (query) => {
      if (query.toLowerCase().includes('title a')) {
        return [
          {
            title: 'Title B',
            year: 2026,
            tvdbId: asTvdbId('463051'),
            source: 'tvmaze',
            isAnimated: true
          }
        ];
      }
      return [
        {
          title: 'Title A',
          year: 2026,
          tvdbId: asTvdbId('463051'),
          source: 'tvdb'
        }
      ];
    });
    vi.mocked(tvdbMod.lookupSeriesByTvdbId).mockImplementation(async (_id, key) =>
      key
        ? { title: 'Title A', year: 2026, tvdbId: asTvdbId('463051'), source: 'tvdb' }
        : { title: 'Title B', year: 2026, tvdbId: asTvdbId('463051'), source: 'tvmaze' }
    );

    const { JobRunner } = await import('../../src/server/services/jobRunner.ts');
    const cfg = loadConfig({
      CONFIG_DIR: configDir,
      INPUT_DIR: inputDir,
      OUTPUT_MOVIES_DIR: outputDir,
      OUTPUT_DOCUMENTARIES_DIR: outputDir,
      OUTPUT_ANIMATED_MOVIES_DIR: outputDir,
      OUTPUT_TV_SHOWS_DIR: outputDir,
      OUTPUT_ANIMATED_SERIES_DIR: outputDir,
      TVDB_API_KEY: 'tvdb-key'
    });
    const runner = new JobRunner(cfg);
    await runner.init();

    const clientId = asClientId('c1:unify');
    runner.startScan(clientId);
    for (let i = 0; i < 40 && runner.getState().phase !== 'READY'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const items = runner.getState().items;
    expect(items).toHaveLength(2);
    expect(items[0]?.selectedMetadata?.title).toBe('Title A');
    expect(items[1]?.selectedMetadata?.title).toBe('Title A');
    expect(items[0]?.candidates.map((c) => c.title)).toContain('Title B');
    expect(items[1]?.candidates.map((c) => c.title)).toContain('Title B');

    const { searchMetadataCatalog } =
      await import('../../src/server/services/scanMetadataService.ts');
    const catalogResults = await searchMetadataCatalog(cfg, ['eng'], {
      query: 'Title A',
      kind: 'tv',
      tvdbId: '463051'
    });
    expect(catalogResults.map((c) => `${c.source}:${c.title}`)).toEqual([
      'tvdb:Title A',
      'tvmaze:Title B'
    ]);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('preserves user-selected audioNormalization options across rescan', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-rescan-audio-'));
    const inputDir = path.join(tmpDir, 'input');
    const configDir = path.join(tmpDir, 'config');
    const outputDir = path.join(tmpDir, 'output');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(inputDir, 'Movie (2024).mkv'), 'v');

    const cfg = loadConfig({
      CONFIG_DIR: configDir,
      INPUT_DIR: inputDir,
      OUTPUT_MOVIES_DIR: outputDir,
      OUTPUT_DOCUMENTARIES_DIR: outputDir,
      OUTPUT_ANIMATED_MOVIES_DIR: outputDir,
      OUTPUT_TV_SHOWS_DIR: outputDir,
      OUTPUT_ANIMATED_SERIES_DIR: outputDir
    });

    const runner = new JobRunner(cfg);
    await runner.init();

    const clientId = asClientId('c1:rescan');
    runner.startScan(clientId);
    for (let i = 0; i < 40 && runner.getState().phase !== 'READY'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const firstState = runner.getState();
    const firstItem = firstState.items[0]!;
    await runner.patchItem(clientId, firstState.revision, firstItem.id, {
      audioNormalization: { mode: 'loudnorm', codec: 'aac', downmixStereo: true }
    });

    runner.startScan(clientId);
    for (let i = 0; i < 40 && runner.getState().phase !== 'READY'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const rescanned = runner.getState().items[0]!;
    expect(rescanned.trackSelection.audioNormalization).toEqual({
      mode: 'loudnorm',
      codec: 'aac',
      downmixStereo: true
    });

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('ranks TV candidates by parsedYear and falls back to file title and word trimming', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-meta-fallback-'));
    try {
      const inputDir = path.join(tmpDir, 'input');
      const configDir = path.join(tmpDir, 'config');
      const outputDir = path.join(tmpDir, 'output');
      await fs.mkdir(path.join(inputDir, 'Foundation.2021.S02'), { recursive: true });
      await fs.mkdir(path.join(inputDir, 'Weird.Pack.Noise'), { recursive: true });
      await fs.mkdir(path.join(inputDir, 'Alpha.Beta.Extra'), { recursive: true });
      await fs.mkdir(configDir, { recursive: true });
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(
        path.join(inputDir, 'Foundation.2021.S02', 'Foundation.2021.S02E08.mkv'),
        'v'
      );
      await fs.writeFile(path.join(inputDir, 'Weird.Pack.Noise', 'Weird.S01E01.mkv'), 'v');
      await fs.writeFile(
        path.join(inputDir, 'Alpha.Beta.Extra', 'Alpha.Beta.Extra.S01E01.mkv'),
        'v'
      );

      const tvdbMod = await import('../../src/server/services/metadata/tvdbClient.ts');
      vi.mocked(tvdbMod.searchTvShows).mockImplementation(async (query) => {
        if (query === 'Foundation') {
          return [
            { title: 'Foundation', year: 2011, tvdbId: asTvdbId('248041'), source: 'tvdb' },
            { title: 'Foundation', year: 2021, tvdbId: asTvdbId('366972'), source: 'tvdb' }
          ];
        }
        if (query === 'Weird') {
          return [{ title: 'Weird', year: 2024, tvdbId: asTvdbId('999001'), source: 'tvdb' }];
        }
        if (query === 'Alpha Beta') {
          return [{ title: 'Alpha Beta', year: 2025, tvdbId: asTvdbId('999002'), source: 'tvdb' }];
        }
        return [];
      });

      const { JobRunner } = await import('../../src/server/services/jobRunner.ts');
      const cfg = loadConfig({
        CONFIG_DIR: configDir,
        INPUT_DIR: inputDir,
        OUTPUT_MOVIES_DIR: outputDir,
        OUTPUT_DOCUMENTARIES_DIR: outputDir,
        OUTPUT_ANIMATED_MOVIES_DIR: outputDir,
        OUTPUT_TV_SHOWS_DIR: outputDir,
        OUTPUT_ANIMATED_SERIES_DIR: outputDir,
        TVDB_API_KEY: 'tvdb-key'
      });
      const runner = new JobRunner(cfg);
      await runner.init();

      const clientId = asClientId('c1:fallback');
      runner.startScan(clientId);
      for (let i = 0; i < 40 && runner.getState().phase !== 'READY'; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const items = runner.getState().items;
      const foundationItem = items.find((item) => item.fileName.includes('Foundation'));
      const weirdItem = items.find((item) => item.fileName.includes('Weird'));
      const alphaItem = items.find((item) => item.fileName.includes('Alpha'));
      expect(foundationItem?.selectedMetadata?.tvdbId).toBe(asTvdbId('366972'));
      expect(foundationItem?.selectedMetadata?.year).toBe(2021);
      expect(weirdItem?.selectedMetadata?.tvdbId).toBe(asTvdbId('999001'));
      expect(alphaItem?.selectedMetadata?.tvdbId).toBe(asTvdbId('999002'));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('continues processing remaining items on error, retries failed item on pass 2, and records attempt 1 error', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-retry-exec-'));
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');
    const configDir = path.join(tmpDir, 'config');
    try {
      await fs.mkdir(inputDir, { recursive: true });
      await fs.mkdir(outputDir, { recursive: true });
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(inputDir, 'Alpha.2020.mkv'), 'video-a');
      await fs.writeFile(path.join(inputDir, 'Beta.2021.mkv'), 'video-b');

      const ffmpegMod = await import('../../src/server/services/media/ffmpegRunner.ts');
      let alphaCalls = 0;
      vi.mocked(ffmpegMod.runFfmpegRemux).mockImplementation(async (args, _dur, onProgress) => {
        const destArg = args.at(-1) ?? '';
        if (destArg.includes('Alpha') && alphaCalls === 0) {
          alphaCalls += 1;
          throw new Error('transient remux failure');
        }
        if (destArg.includes('Alpha')) {
          alphaCalls += 1;
        }
        onProgress?.(100);
        await fs.writeFile(destArg, 'remuxed-mkv');
      });

      const { JobRunner } = await import('../../src/server/services/jobRunner.ts');
      const cfg = loadConfig({
        INPUT_DIR: inputDir,
        CONFIG_DIR: configDir,
        OUTPUT_MOVIES_DIR: outputDir,
        OUTPUT_DOCUMENTARIES_DIR: outputDir,
        OUTPUT_ANIMATED_MOVIES_DIR: outputDir,
        OUTPUT_TV_SHOWS_DIR: outputDir,
        OUTPUT_ANIMATED_SERIES_DIR: outputDir
      });
      const runner = new JobRunner(cfg);
      await runner.init();

      const clientId = asClientId('c1:retry');
      runner.startScan(clientId);
      for (let i = 0; i < 40 && runner.getState().phase !== 'READY'; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const preflight = await runner.preflight(clientId, runner.getState().revision);
      const resolutions: Record<string, 'overwrite'> = {};
      for (const conflict of preflight.conflicts) {
        resolutions[conflict.itemId] = 'overwrite';
      }
      await runner.startJob(clientId, preflight.revision, resolutions);
      for (let i = 0; i < 60 && runner.getState().phase === 'PROCESSING'; i += 1) {
        await new Promise((r) => setTimeout(r, 15));
      }

      const finalState = runner.getState();
      expect(finalState.phase).toBe('IDLE');
      expect(finalState.items).toHaveLength(0);
      expect(finalState.lastJobErrors).toHaveLength(1);
      expect(finalState.lastJobErrors?.[0]?.attempt).toBe(1);
      expect(finalState.lastJobErrors?.[0]?.fileName).toBe('Alpha.2020.mkv');
      expect(
        finalState.logs?.some(
          (entry) => entry.level === 'error' && entry.message.includes('[Attempt 1/2]')
        )
      ).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('annotates presentInLibrary and prioritizes mount-existing candidates during scan and search', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-mount-prio-'));
    const inputDir = path.join(tmpDir, 'input');
    const tvOutDir = path.join(tmpDir, 'tv-out');
    const movieOutDir = path.join(tmpDir, 'movie-out');
    const configDir = path.join(tmpDir, 'config');
    try {
      await fs.mkdir(path.join(inputDir, 'Foundation.S03'), { recursive: true });
      await fs.mkdir(path.join(tvOutDir, 'Foundation (2021) {tvdb-366972}'), { recursive: true });
      await fs.mkdir(movieOutDir, { recursive: true });
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(inputDir, 'Foundation.S03', 'Foundation.S03E01.mkv'), 'v');

      const tvdbMod = await import('../../src/server/services/metadata/tvdbClient.ts');
      vi.mocked(tvdbMod.searchTvShows).mockResolvedValue([
        { title: 'Foundation', year: 2011, tvdbId: asTvdbId('248041'), source: 'tvdb' },
        { title: 'Foundation', year: 2021, tvdbId: asTvdbId('366972'), source: 'tvdb' }
      ]);

      const cfg = loadConfig({
        CONFIG_DIR: configDir,
        INPUT_DIR: inputDir,
        OUTPUT_MOVIES_DIR: movieOutDir,
        OUTPUT_DOCUMENTARIES_DIR: movieOutDir,
        OUTPUT_ANIMATED_MOVIES_DIR: movieOutDir,
        OUTPUT_TV_SHOWS_DIR: tvOutDir,
        OUTPUT_ANIMATED_SERIES_DIR: tvOutDir,
        TVDB_API_KEY: 'tvdb-key'
      });
      const runner = new JobRunner(cfg);
      await runner.init();

      const clientId = asClientId('c1:mount-prio');
      runner.startScan(clientId);
      for (let i = 0; i < 40 && runner.getState().phase !== 'READY'; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const scannedItem = runner.getState().items[0];
      expect(scannedItem?.selectedMetadata?.tvdbId).toBe(asTvdbId('366972'));
      expect(scannedItem?.selectedMetadata?.presentInLibrary).toBe('tv-shows');
      expect(scannedItem?.candidates[0]?.tvdbId).toBe(asTvdbId('366972'));
      expect(scannedItem?.candidates[0]?.presentInLibrary).toBe('tv-shows');

      const searched = await runner.searchMetadata(clientId, {
        query: 'Foundation',
        kind: 'tv'
      });
      expect(searched[0]?.tvdbId).toBe(asTvdbId('366972'));
      expect(searched[0]?.presentInLibrary).toBe('tv-shows');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
