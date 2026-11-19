import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http, { type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { deflateRawSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('../../src/server/services/media/ffmpegRunner.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/server/services/media/ffmpegRunner.ts')>();
  return {
    ...actual,
    probeMedia: async () => ({
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
          language: 'eng',
          channels: 2,
          isDefault: true
        }
      ],
      subtitleStreams: []
    }),
    analyzeAudioVolume: async () => ({
      streamOrder: 0,
      meanVolumeDb: -20,
      maxVolumeDb: -2,
      suggestion: 'copy',
      recommendedGainDb: 0
    })
  };
});

vi.mock('../../src/server/services/metadata/imdbClient.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/server/services/metadata/imdbClient.ts')>();
  return {
    ...actual,
    searchMovies: async () => [
      {
        title: 'Matrix',
        year: 1999,
        imdbId: 'tt0133093',
        source: 'imdb'
      }
    ]
  };
});

import { buildMovieVerificationEntry } from '../../src/domain/libraryVerifier.ts';
import {
  asClientId,
  asImdbId,
  asIso639_2Code,
  asItemId,
  asTvdbId,
  type ScannedItem,
  type SubtitleCandidate
} from '../../src/domain/types.ts';
import { loadConfig } from '../../src/server/config.ts';
import { createRequestHandler } from '../../src/server/routes.ts';
import { JobRunner } from '../../src/server/services/jobRunner.ts';
import { scanLibrariesForCompliance } from '../../src/server/services/libraryVerifierService.ts';
import {
  type PreviewSpawnFn,
  streamSubtitlePreviewVtt,
  streamTranscodedPreview
} from '../../src/server/services/subtitles/playerPreview.ts';
import { searchGestdownSubtitles } from '../../src/server/services/subtitles/providers/gestdownProvider.ts';
import {
  resolveOpenSubtitlesRestDownloadUrl,
  searchOpenSubtitlesRest
} from '../../src/server/services/subtitles/providers/openSubtitlesRestProvider.ts';
import { searchOpenSubtitlesStremio } from '../../src/server/services/subtitles/providers/openSubtitlesStremioProvider.ts';
import { searchPodnapisiSubtitles } from '../../src/server/services/subtitles/providers/podnapisiProvider.ts';
import { searchSubdlSubtitles } from '../../src/server/services/subtitles/providers/subdlProvider.ts';
import { searchYifySubtitles } from '../../src/server/services/subtitles/providers/yifySubtitlesProvider.ts';
import {
  detectSpanishVariant,
  rankSubtitleCandidates
} from '../../src/server/services/subtitles/subtitleScorer.ts';
import {
  downloadSubtitleCandidateForItem,
  hasSpanishSubtitles,
  searchSpanishSubtitlesForItem
} from '../../src/server/services/subtitles/subtitleService.ts';
import { computeOpenSubtitlesHash } from '../../src/server/services/subtitles/videoHash.ts';
import { extractSubtitleFromZip } from '../../src/server/services/subtitles/zipExtractor.ts';

function buildMinimalZip(fileName: string, content: Buffer): Buffer {
  const compressed = deflateRawSync(content);
  const nameBuf = Buffer.from(fileName, 'utf8');

  const localHeader = Buffer.alloc(30 + nameBuf.length);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(localHeader, 30);

  const centralOffset = localHeader.length + compressed.length;
  const centralHeader = Buffer.alloc(46 + nameBuf.length);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(content.length, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  centralHeader.writeUInt32LE(0, 42);
  nameBuf.copy(centralHeader, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralHeader.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([localHeader, compressed, centralHeader, eocd]);
}

describe('subtitles & verifier tag recalculation', () => {
  it('computes deterministic 64-bit OpenSubtitles hash', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-hash-'));
    try {
      const videoPath = path.join(tmpDir, 'sample.mkv');
      const data = Buffer.alloc(150_000, 1);
      await fs.writeFile(videoPath, data);
      const result = await computeOpenSubtitlesHash(videoPath);
      expect(result.videoSize).toBe(150_000);
      expect(result.videoHash).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('extracts .srt from ZIP archives using native zlib', () => {
    const srtBytes = Buffer.from('1\n00:00:01,000 --> 00:00:03,000\nHola mundo\n', 'utf8');
    const zipBytes = buildMinimalZip('movie.spa.srt', srtBytes);
    const extracted = extractSubtitleFromZip(zipBytes);
    expect(extracted?.fileName).toBe('movie.spa.srt');
    expect(extracted?.content.toString('utf8')).toContain('Hola mundo');
  });

  it('ranks hash matches and LatAm variants above generic Spain releases', () => {
    expect(detectSpanishVariant('Movie.2026.Latino.WEB-DL')).toBe('latam');
    expect(detectSpanishVariant('Movie.2026.Castellano.BluRay')).toBe('spain');
    expect(detectSpanishVariant('Movie.2026.WEB-DL')).toBe('neutral');

    const ranked = rankSubtitleCandidates(
      [
        {
          id: '1',
          provider: 'yify',
          language: asIso639_2Code('spa'),
          variant: 'spain',
          releaseName: 'Other.Release',
          downloadUrl: 'https://example.com/1.zip',
          hashMatch: false
        },
        {
          id: '2',
          provider: 'opensubtitles-stremio',
          language: asIso639_2Code('spa'),
          variant: 'latam',
          releaseName: 'Iron.Lung.2026.WEB-DL',
          downloadUrl: 'https://example.com/2.srt',
          hashMatch: true
        }
      ],
      'Iron.Lung.2026.2160p.WEB-DL.mkv'
    );

    expect(ranked[0]?.id).toBe('2');
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);

    const releaseRanked = rankSubtitleCandidates(
      [
        {
          id: 'popular-old',
          provider: 'opensubtitles-rest',
          language: asIso639_2Code('spa'),
          variant: 'neutral',
          releaseName: 'Mr.Robot.S01E05.3xpl0its.1',
          downloadUrl: 'https://example.com/old.srt',
          downloadCount: 500_000,
          hashMatch: false
        },
        {
          id: 'hdtv-mismatch',
          provider: 'opensubtitles-rest',
          language: asIso639_2Code('spa'),
          variant: 'neutral',
          releaseName: 'Mr.Robot.S01E05.HDTV.x264',
          downloadUrl: 'https://example.com/hdtv.srt',
          downloadCount: 200_000,
          hashMatch: false
        },
        {
          id: 'amz-web',
          provider: 'opensubtitles-rest',
          language: asIso639_2Code('spa'),
          variant: 'neutral',
          releaseName: 'Mr. Robot s01E05 1080p AMZ',
          downloadUrl: 'https://example.com/amz.srt',
          downloadCount: 25,
          hashMatch: false
        }
      ],
      'Mr.Robot.S01E05.1080p.BluRay.WEB.10bit.DD5.1.x265-POIASD.mkv'
    );
    expect(releaseRanked[0]?.id).toBe('amz-web');
    expect(releaseRanked[2]?.id).toBe('hdtv-mismatch');
  });

  it('searches keyless providers and downloads .spa.srt next to input video', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-subs-'));
    try {
      const videoPath = path.join(tmpDir, 'Iron.Lung.2026.mkv');
      await fs.writeFile(videoPath, Buffer.alloc(1024, 2));

      const config = loadConfig({
        CONFIG_DIR: path.join(tmpDir, 'config'),
        INPUT_DIR: tmpDir,
        BACKUP_DIR: path.join(tmpDir, 'backup'),
        OUTPUT_MOVIES_DIR: path.join(tmpDir, 'out-movies'),
        OUTPUT_ANIMATED_MOVIES_DIR: path.join(tmpDir, 'out-anim-movies'),
        OUTPUT_TV_SHOWS_DIR: path.join(tmpDir, 'out-tv'),
        OUTPUT_ANIMATED_SERIES_DIR: path.join(tmpDir, 'out-anim-tv')
      });

      const item: ScannedItem = {
        id: asItemId('item-1'),
        sourcePath: videoPath,
        relativePath: 'Iron.Lung.2026.mkv',
        fileName: 'Iron.Lung.2026.mkv',
        mediaKind: 'movie',
        category: 'movies',
        include: true,
        parsedTitle: 'Iron Lung',
        parsedYear: 2026,
        tags: ['4k'],
        probe: {
          formatName: 'matroska',
          durationSeconds: 100,
          sizeBytes: 1024,
          bitrateBps: 1000,
          videoStreams: [{ index: 0, codecName: 'hevc', width: 3840, height: 2160 }],
          audioStreams: [],
          subtitleStreams: []
        },
        externalSubtitles: [],
        candidates: [],
        selectedMetadata: {
          title: 'Iron Lung',
          year: 2026,
          imdbId: asImdbId('tt27564844'),
          source: 'imdb'
        },
        episodeOrder: 'aired',
        trackSelection: {
          audioTracks: [],
          subtitleMergeMode: 'keep-and-add',
          includedInternalSubtitles: [],
          externalSubtitleOrder: [],
          needsUserPrompt: false
        },
        warnings: []
      };

      expect(hasSpanishSubtitles(item)).toBe(false);

      const mockFetch: typeof fetch = async (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('opensubtitles-v3.strem.io')) {
          return new Response(
            JSON.stringify({
              subtitles: [
                {
                  id: 'os-1',
                  url: 'https://subs.example/iron-lung-latam.srt',
                  lang: 'spa',
                  SubFileName: 'Iron.Lung.2026.Latino.WEB-DL.srt',
                  MatchedBy: 'moviehash'
                }
              ]
            }),
            { status: 200 }
          );
        }
        if (url === 'https://subs.example/iron-lung-latam.srt') {
          return new Response('1\n00:00:01,000 --> 00:00:02,000\nSubtítulo\n', { status: 200 });
        }
        return new Response('', { status: 404 });
      };

      const candidates = await searchSpanishSubtitlesForItem(item, config, {
        fetchFn: mockFetch
      });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.variant).toBe('latam');

      const downloaded = await downloadSubtitleCandidateForItem(item, candidates[0]!, config, {
        fetchFn: mockFetch
      });
      expect(downloaded.language).toBe('spa');
      expect(downloaded.path).toBe(path.join(tmpDir, 'Iron.Lung.2026.spa.srt'));
      const savedContent = await fs.readFile(downloaded.path, 'utf8');
      expect(savedContent).toContain('Subtítulo');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('recalculates movie [tags] in verifier when recalculateTags is enabled', () => {
    const entry = buildMovieVerificationEntry({
      category: 'movies',
      currentRootName: '1917 (2019) {imdb-tt8579674} [4k, 10bit]',
      resolvedTitle: '1917',
      resolvedYear: 2019,
      imdbId: asImdbId('tt8579674'),
      files: ['1917 (2019) {imdb-tt8579674} [4k, 10bit].mkv'],
      recalculateTags: true,
      probe: {
        formatName: 'matroska',
        durationSeconds: 7140,
        sizeBytes: 10_000_000,
        bitrateBps: 10_000_000,
        videoStreams: [
          {
            index: 0,
            codecName: 'hevc',
            width: 3840,
            height: 2160,
            bitDepth: 10,
            hasDolbyVision: true
          }
        ],
        audioStreams: [
          {
            index: 1,
            streamOrder: 0,
            codecName: 'eac3',
            language: asIso639_2Code('eng'),
            channels: 6,
            isDefault: true
          }
        ],
        subtitleStreams: []
      }
    });

    expect(entry?.expectedRootName).toBe(
      '1917 (2019) {imdb-tt8579674} [4k, DV, HEVC, DDP 5.1, 10bit]'
    );
    expect(entry?.steps.length).toBe(2);
  });

  it('queries Gestdown, YIFY, OpenSubtitles REST, and SubDL providers cleanly', async () => {
    const tvFetch: typeof fetch = async (input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/shows/external/tvdb/123')) {
        return new Response(JSON.stringify({ shows: [{ id: 'show-uuid' }] }), { status: 200 });
      }
      if (url.includes('/subtitles/get/show-uuid/1/2/spa')) {
        return new Response(
          JSON.stringify({
            matchingSubtitles: [
              {
                subtitleId: 'gd-1',
                version: 'WEB-DL Latino',
                language: 'Spanish',
                downloadCount: 50
              }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response('', { status: 404 });
    };

    const gdResults = await searchGestdownSubtitles(
      {
        mediaKind: 'tv',
        title: 'Dark',
        tvdbId: '123',
        seasonNumber: 1,
        episodeNumber: 2,
        sourceFileName: 'Dark.S01E02.mkv'
      },
      tvFetch
    );
    expect(gdResults).toHaveLength(1);
    expect(gdResults[0]?.provider).toBe('gestdown');
    expect(gdResults[0]?.variant).toBe('latam');

    const movieFetch: typeof fetch = async (input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('yts-subs.com/movie-imdb/tt123456')) {
        return new Response(
          '<table><tr data-id="99"><td><span class="sub-lang">Spanish</span></td><td><a href="/subtitles/arrival-2016-spanish-yify-99">Arrival 2016 Latino</a></td></tr></table>',
          { status: 200 }
        );
      }
      if (url.includes('api.opensubtitles.com/api/v1/subtitles')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'osr-1',
                attributes: {
                  language: 'ea',
                  release: 'Arrival.2016.WEB-DL',
                  download_count: 100,
                  moviehash_match: true,
                  files: [{ file_id: 555, file_name: 'arrival.srt' }]
                }
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.includes('api.opensubtitles.com/api/v1/download')) {
        return new Response(JSON.stringify({ link: 'https://dl.example/555.srt' }), {
          status: 200
        });
      }
      if (url.includes('api.subdl.com/api/v1/subtitles')) {
        return new Response(
          JSON.stringify({
            status: true,
            subtitles: [
              {
                sd_id: 77,
                release_name: 'Arrival.2016.BluRay',
                lang: 'ES',
                url: '/subtitle/77.zip'
              }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response('', { status: 404 });
    };

    const yifyResults = await searchYifySubtitles(
      {
        mediaKind: 'movie',
        title: 'Arrival',
        imdbId: 'tt123456',
        sourceFileName: 'Arrival.mkv'
      },
      movieFetch
    );
    expect(yifyResults).toHaveLength(1);
    expect(yifyResults[0]?.isArchive).toBe(true);

    const osRestResults = await searchOpenSubtitlesRest(
      {
        mediaKind: 'movie',
        title: 'Arrival',
        imdbId: 'tt123456',
        videoHash: '0123456789abcdef',
        sourceFileName: 'Arrival.mkv'
      },
      'os-key',
      movieFetch
    );
    expect(osRestResults).toHaveLength(1);
    expect(osRestResults[0]?.hashMatch).toBe(true);
    const resolvedLink = await resolveOpenSubtitlesRestDownloadUrl(
      osRestResults[0]!.downloadUrl,
      'os-key',
      movieFetch,
      undefined,
      osRestResults[0]?.remoteFileId
    );
    expect(resolvedLink).toBe('https://dl.example/555.srt');

    const subdlResults = await searchSubdlSubtitles(
      {
        mediaKind: 'movie',
        title: 'Arrival',
        imdbId: 'tt123456',
        sourceFileName: 'Arrival.mkv'
      },
      'subdl-key',
      movieFetch
    );
    expect(subdlResults).toHaveLength(1);
    expect(subdlResults[0]?.downloadUrl).toBe('https://dl.subdl.com/subtitle/77.zip');

    // Verify 404/empty branches across providers
    const failFetch: typeof fetch = async () => new Response('', { status: 404 });
    await expect(
      searchGestdownSubtitles(
        { mediaKind: 'movie', title: 'X', sourceFileName: 'X.mkv' },
        failFetch
      )
    ).resolves.toEqual([]);
    await expect(
      searchYifySubtitles({ mediaKind: 'tv', title: 'X', sourceFileName: 'X.mkv' }, failFetch)
    ).resolves.toEqual([]);
    await expect(
      searchOpenSubtitlesRest(
        { mediaKind: 'movie', title: 'X', sourceFileName: 'X.mkv' },
        undefined,
        failFetch
      )
    ).resolves.toEqual([]);
    await expect(
      searchSubdlSubtitles(
        { mediaKind: 'movie', title: 'X', sourceFileName: 'X.mkv' },
        undefined,
        failFetch
      )
    ).resolves.toEqual([]);
  });

  it('extracts ZIP subtitle during downloadSubtitleCandidateForItem', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-zip-dl-'));
    try {
      const videoPath = path.join(tmpDir, 'Dune.2021.mkv');
      await fs.writeFile(videoPath, Buffer.alloc(512, 3));
      const config = loadConfig({
        CONFIG_DIR: path.join(tmpDir, 'config'),
        INPUT_DIR: tmpDir,
        BACKUP_DIR: path.join(tmpDir, 'backup'),
        OUTPUT_MOVIES_DIR: path.join(tmpDir, 'out-movies'),
        OUTPUT_ANIMATED_MOVIES_DIR: path.join(tmpDir, 'out-anim-movies'),
        OUTPUT_TV_SHOWS_DIR: path.join(tmpDir, 'out-tv'),
        OUTPUT_ANIMATED_SERIES_DIR: path.join(tmpDir, 'out-anim-tv')
      });
      const zipBuf = buildMinimalZip(
        'dune.spa.srt',
        Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nDune\n', 'utf8')
      );
      const item: ScannedItem = {
        id: asItemId('dune-1'),
        sourcePath: videoPath,
        relativePath: 'Dune.2021.mkv',
        fileName: 'Dune.2021.mkv',
        mediaKind: 'movie',
        category: 'movies',
        include: true,
        parsedTitle: 'Dune',
        parsedYear: 2021,
        tags: ['4k'],
        probe: {
          formatName: 'matroska',
          durationSeconds: 100,
          sizeBytes: 512,
          bitrateBps: 1000,
          videoStreams: [],
          audioStreams: [],
          subtitleStreams: []
        },
        externalSubtitles: [],
        candidates: [],
        episodeOrder: 'aired',
        trackSelection: {
          audioTracks: [],
          subtitleMergeMode: 'keep-and-add',
          includedInternalSubtitles: [],
          externalSubtitleOrder: [],
          needsUserPrompt: false
        },
        warnings: []
      };

      const downloaded = await downloadSubtitleCandidateForItem(
        item,
        {
          id: 'zip-1',
          provider: 'yify',
          language: asIso639_2Code('spa'),
          variant: 'neutral',
          releaseName: 'Dune.2021.BluRay',
          downloadUrl: 'https://yts.example/dune.zip',
          hashMatch: false,
          isArchive: true,
          score: 100
        },
        config,
        {
          fetchFn: async () => new Response(new Uint8Array(zipBuf), { status: 200 })
        }
      );

      expect(downloaded.extension).toBe('.srt');
      await expect(fs.readFile(downloaded.path, 'utf8')).resolves.toContain('Dune');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('auto-downloads subtitles on JobRunner scan and serves search/download HTTP endpoints', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-sub-routes-'));
    const inputDir = path.join(tmpDir, 'input');
    const configDir = path.join(tmpDir, 'config');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });
    const moviePath = path.join(inputDir, 'Matrix (1999).mkv');
    await fs.writeFile(moviePath, 'fake-video');

    const cfg = loadConfig({
      CONFIG_DIR: configDir,
      INPUT_DIR: inputDir,
      BACKUP_DIR: path.join(tmpDir, 'backup'),
      OUTPUT_MOVIES_DIR: path.join(tmpDir, 'out-movies'),
      OUTPUT_ANIMATED_MOVIES_DIR: path.join(tmpDir, 'out-anim-movies'),
      OUTPUT_TV_SHOWS_DIR: path.join(tmpDir, 'out-tv'),
      OUTPUT_ANIMATED_SERIES_DIR: path.join(tmpDir, 'out-anim-tv')
    });

    const mockCand = {
      id: 'cand-1',
      provider: 'opensubtitles-stremio' as const,
      language: asIso639_2Code('spa'),
      variant: 'latam' as const,
      releaseName: 'Matrix.1999.Latino.srt',
      downloadUrl: 'https://subs.example/matrix.srt',
      hashMatch: true,
      score: 1080
    };

    const runner = new JobRunner(cfg, {
      autoDownloadSubtitles: true,
      searchSubtitles: async () => [mockCand],
      downloadSubtitle: async (item) => {
        const subPath = path.join(path.dirname(item.sourcePath), 'Matrix (1999).spa.srt');
        await fs.writeFile(subPath, '1\n00:00:01,000 --> 00:00:02,000\nMatrix\n');
        return {
          path: subPath,
          relativePath: 'Matrix (1999).spa.srt',
          extension: '.srt',
          language: asIso639_2Code('spa'),
          isForced: false,
          isHearingImpaired: false,
          isLanguageAmbiguous: false,
          downloadedFrom: 'opensubtitles-stremio'
        };
      }
    });
    await runner.init();

    const server = http.createServer(createRequestHandler(runner, path.join(tmpDir, 'dist')));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        throw new Error('Unexpected address');
      }
      const baseUrl = `http://127.0.0.1:${String(addr.port)}`;
      const clientId = asClientId('sub-client:1');

      await runner.startScan(clientId);
      for (let i = 0; i < 40 && runner.getState().phase !== 'READY'; i += 1) {
        await new Promise((r) => setTimeout(r, 15));
      }
      const scannedItem = runner.getState().items[0]!;
      expect(scannedItem.subtitleStatus?.status).toBe('downloaded');
      expect(scannedItem.externalSubtitles.some((s) => s.language === 'spa')).toBe(true);

      const searchRes = await fetch(
        `${baseUrl}/api/queue/items/${encodeURIComponent(scannedItem.id)}/subtitles/search`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-client-id': clientId },
          body: JSON.stringify({})
        }
      );
      expect(searchRes.status).toBe(200);
      const searchJson = (await searchRes.json()) as { readonly candidates: readonly unknown[] };
      expect(searchJson.candidates).toHaveLength(1);

      const dlRes = await fetch(
        `${baseUrl}/api/queue/items/${encodeURIComponent(scannedItem.id)}/subtitles/download`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-client-id': clientId },
          body: JSON.stringify({
            revision: runner.getState().revision,
            candidate: mockCand
          })
        }
      );
      expect(dlRes.status).toBe(200);

      const vttRes = await fetch(
        `${baseUrl}/api/queue/items/${encodeURIComponent(scannedItem.id)}/subtitles/preview.vtt`
      );
      expect(vttRes.status).toBe(200);
      await expect(vttRes.text()).resolves.toContain('WEBVTT');

      const vttOffsetRes = await fetch(
        `${baseUrl}/api/queue/items/${encodeURIComponent(scannedItem.id)}/subtitles/preview.vtt?offset=5`
      );
      expect(vttOffsetRes.status).toBe(200);
      await expect(vttOffsetRes.text()).resolves.toContain('WEBVTT');

      const streamRes = await fetch(
        `${baseUrl}/api/queue/items/${encodeURIComponent(scannedItem.id)}/stream?t=5`
      );
      expect(streamRes.status).toBe(200);
      expect(streamRes.headers.get('content-type')).toBe('video/mp4');
      await streamRes.arrayBuffer();

      const fastStreamRes = await fetch(
        `${baseUrl}/api/queue/items/${encodeURIComponent(scannedItem.id)}/stream?t=5&fast=1`
      );
      expect(fastStreamRes.status).toBe(200);
      expect(fastStreamRes.headers.get('content-type')).toBe('video/mp4');
      await fastStreamRes.arrayBuffer();

      const emptyIdSearchRes = await fetch(`${baseUrl}/api/queue/items//subtitles/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId })
      });
      expect(emptyIdSearchRes.status).toBe(404);
      const emptyIdStreamRes = await fetch(`${baseUrl}/api/queue/items//stream`);
      expect(emptyIdStreamRes.status).toBe(404);

      const vttFilePath = path.join(tmpDir, 'already.vtt');
      await fs.writeFile(vttFilePath, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n', 'utf8');
      let streamedBody = '';
      await streamSubtitlePreviewVtt(vttFilePath, {
        writeHead: () => {},
        end: (chunk: string) => {
          streamedBody = chunk;
        }
      });
      expect(streamedBody).toContain('WEBVTT');

      const srtShiftPath = path.join(tmpDir, 'shift.srt');
      await fs.writeFile(
        srtShiftPath,
        '1\n00:00:10,000 --> 00:00:12,000\nToo early\n\n2\n00:00:46,500 --> 00:00:49,250\n{\\an8}Synced line\n',
        'utf8'
      );
      let shiftedVtt = '';
      await streamSubtitlePreviewVtt(
        srtShiftPath,
        {
          writeHead: () => {},
          end: (chunk: string) => {
            shiftedVtt = chunk;
          }
        },
        45
      );
      expect(shiftedVtt).not.toContain('Too early');
      expect(shiftedVtt).toContain('00:00:01.500 --> 00:00:04.250\nSynced line');

      const previewVideoPath = path.join(tmpDir, 'preview.mkv');
      await fs.writeFile(previewVideoPath, 'dummy');
      const fakeResEmitter = new EventEmitter();
      const fakeRes = Object.assign(new PassThrough(), {
        writeHead: vi.fn(),
        on: fakeResEmitter.on.bind(fakeResEmitter),
        off: fakeResEmitter.off.bind(fakeResEmitter)
      }) as unknown as ServerResponse;
      const killMock = vi.fn().mockReturnValue(true);
      let capturedArgs: readonly string[] = [];
      const fakeSpawn: PreviewSpawnFn = (_cmd, args) => {
        capturedArgs = args;
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const childEmitter = new EventEmitter();
        queueMicrotask(() => {
          stdout.end(Buffer.from('ftyp'));
          childEmitter.emit('exit', 0);
        });
        return {
          stdout,
          stderr,
          once: (event, listener) => childEmitter.once(event, listener),
          kill: killMock
        };
      };
      await streamTranscodedPreview(
        { sourcePath: previewVideoPath, startSeconds: 120, audioStreamOrder: 2 },
        fakeRes,
        fakeSpawn
      );
      const inputIdx = capturedArgs.indexOf('-i');
      expect(inputIdx).toBeGreaterThan(-1);
      expect(capturedArgs.slice(0, inputIdx)).toContain('-skip_loop_filter');
      expect(capturedArgs.slice(0, inputIdx)).toContain('all');
      expect(capturedArgs.slice(0, inputIdx)).toContain('-ss');
      expect(capturedArgs.slice(0, inputIdx)).toContain('120');
      expect(capturedArgs.slice(inputIdx)).not.toContain('-ss');
      expect(capturedArgs).not.toContain('118');
      expect(capturedArgs).not.toContain('-skip_frame');
      expect(capturedArgs).toContain('0:a:2?');
      expect(capturedArgs).toContain('aac');
      expect(capturedArgs).toContain('-g');
      expect(capturedArgs[capturedArgs.indexOf('-g') + 1]).toBe('24');
      expect(capturedArgs).toContain('-frag_duration');
      expect(capturedArgs[capturedArgs.indexOf('-frag_duration') + 1]).toBe('500000');
      expect(capturedArgs).toContain('scale=-2:min(480\\,ih):flags=fast_bilinear');
      expect(
        (fakeRes as unknown as { writeHead: ReturnType<typeof vi.fn> }).writeHead
      ).toHaveBeenCalledWith(200, expect.objectContaining({ 'Content-Type': 'video/mp4' }));

      const fastFakeRes = Object.assign(new PassThrough(), {
        writeHead: vi.fn(),
        on: fakeResEmitter.on.bind(fakeResEmitter),
        off: fakeResEmitter.off.bind(fakeResEmitter)
      }) as unknown as ServerResponse;
      await streamTranscodedPreview(
        { sourcePath: previewVideoPath, startSeconds: 45, audioStreamOrder: 1, fastDecode: true },
        fastFakeRes,
        fakeSpawn
      );
      const fastInputIdx = capturedArgs.indexOf('-i');
      expect(fastInputIdx).toBeGreaterThan(-1);
      expect(capturedArgs.slice(0, fastInputIdx)).toContain('-skip_frame');
      expect(capturedArgs.slice(0, fastInputIdx)).toContain('noref');
      expect(capturedArgs.slice(0, fastInputIdx)).toContain('-ss');
      expect(capturedArgs.slice(0, fastInputIdx)).toContain('45');
      expect(capturedArgs[capturedArgs.indexOf('-g') + 1]).toBe('12');

      // Verify aborting the HTTP response kills the spawned ffmpeg process
      const abortRes = Object.assign(new PassThrough(), {
        writeHead: vi.fn()
      }) as unknown as ServerResponse;
      const abortKill = vi.fn().mockReturnValue(true);
      const longSpawn: PreviewSpawnFn = () => {
        const childEmitter = new EventEmitter();
        queueMicrotask(() => {
          abortRes.emit('close');
          childEmitter.emit('exit', 0);
        });
        return {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          once: (event, listener) => childEmitter.once(event, listener),
          kill: abortKill
        };
      };
      await streamTranscodedPreview({ sourcePath: previewVideoPath }, abortRes, longSpawn);
      expect(abortKill).toHaveBeenCalledWith('SIGKILL');
      await expect(
        runner.downloadItemSubtitle(clientId, runner.getState().revision, scannedItem.id)
      ).resolves.toBeDefined();

      // Cover not_found and failed branches in JobRunner auto-download & manual download
      await fs.rm(path.join(inputDir, 'Matrix (1999).spa.srt'), { force: true });
      const emptyRunner = new JobRunner(cfg, {
        autoDownloadSubtitles: true,
        searchSubtitles: async () => []
      });
      await emptyRunner.init();
      await emptyRunner.startScan(clientId);
      for (let i = 0; i < 40 && emptyRunner.getState().phase !== 'READY'; i += 1) {
        await new Promise((r) => setTimeout(r, 15));
      }
      const emptyItem = emptyRunner.getState().items[0]!;
      expect(emptyItem.subtitleStatus?.status).toBe('not_found');
      await expect(
        emptyRunner.downloadItemSubtitle(clientId, emptyRunner.getState().revision, emptyItem.id)
      ).rejects.toThrow('No Spanish subtitles found');

      const errRunner = new JobRunner(cfg, {
        autoDownloadSubtitles: true,
        searchSubtitles: async () => {
          throw new Error('network error');
        }
      });
      await errRunner.init();
      await errRunner.startScan(clientId);
      for (let i = 0; i < 40 && errRunner.getState().phase !== 'READY'; i += 1) {
        await new Promise((r) => setTimeout(r, 15));
      }
      expect(errRunner.getState().items[0]?.subtitleStatus?.status).toBe('failed');

      // Cover hash skip + provider error handling in searchSpanishSubtitlesForItem
      const skippedRes = await searchSpanishSubtitlesForItem(
        {
          ...scannedItem,
          sourcePath: path.join(tmpDir, 'missing.mkv'),
          externalSubtitles: [],
          probe: { ...scannedItem.probe, subtitleStreams: [] }
        },
        cfg,
        { fetchFn: async () => new Response('bad', { status: 500 }) }
      );
      expect(skippedRes).toEqual([]);
      await expect(
        searchSubdlSubtitles(
          { mediaKind: 'movie', title: 'X', sourceFileName: 'X.mkv' },
          'k',
          async () => new Response('', { status: 500 })
        )
      ).resolves.toEqual([]);
      await expect(
        searchSubdlSubtitles(
          { mediaKind: 'movie', title: 'X', sourceFileName: 'X.mkv' },
          'k',
          async () => new Response(JSON.stringify({ status: false }), { status: 200 })
        )
      ).resolves.toEqual([]);

      await expect(
        downloadSubtitleCandidateForItem(
          scannedItem,
          {
            id: 'os-no-key',
            provider: 'opensubtitles-rest',
            language: asIso639_2Code('spa'),
            variant: 'neutral',
            releaseName: 'a.srt',
            downloadUrl: 'https://api.opensubtitles.com/api/v1/download?file_id=123',
            remoteFileId: 123,
            hashMatch: false,
            score: 10
          },
          { ...cfg, openSubtitlesApiKey: undefined }
        )
      ).rejects.toThrow('Could not resolve subtitle download URL');

      const emptyZip = buildMinimalZip('readme.txt', Buffer.from('no subs here'));
      await expect(
        downloadSubtitleCandidateForItem(
          scannedItem,
          {
            id: 'zip-no-sub',
            provider: 'yify',
            language: asIso639_2Code('spa'),
            variant: 'neutral',
            releaseName: 'a.zip',
            downloadUrl: 'https://example.com/a.zip',
            hashMatch: false,
            isArchive: true,
            score: 10
          },
          cfg,
          { fetchFn: async () => new Response(new Uint8Array(emptyZip), { status: 200 }) }
        )
      ).rejects.toThrow('did not contain an .srt or .vtt file');

      const missingVttRes = await fetch(
        `${baseUrl}/api/queue/items/missing-id/subtitles/preview.vtt`
      );
      expect(missingVttRes.status).toBe(500);
      const missingStreamRes = await fetch(`${baseUrl}/api/queue/items/missing-id/stream`);
      expect(missingStreamRes.status).toBe(500);

      const emptyServer = http.createServer(createRequestHandler(emptyRunner, tmpDir));
      await new Promise<void>((resolve) => emptyServer.listen(0, '127.0.0.1', () => resolve()));
      try {
        const emptyPort = (emptyServer.address() as { port: number }).port;
        const emptyVttRes = await fetch(
          `http://127.0.0.1:${String(emptyPort)}/api/queue/items/${encodeURIComponent(emptyItem.id)}/subtitles/preview.vtt`
        );
        expect(emptyVttRes.status).toBe(404);
      } finally {
        await new Promise<void>((resolve) => emptyServer.close(() => resolve()));
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('handles zipExtractor edge cases, gestdown title fallback, and verifier recalculateTags', async () => {
    expect(extractSubtitleFromZip(Buffer.from('not-a-zip'))).toBeNull();
    const vttZip = buildMinimalZip(
      'movie.vtt',
      Buffer.from('WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n')
    );
    expect(extractSubtitleFromZip(vttZip)?.fileName).toBe('movie.vtt');

    const titleSearchFetch: typeof fetch = async (input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/shows/search/')) {
        return new Response(JSON.stringify({ shows: [{ id: 'show-2' }] }), { status: 200 });
      }
      if (url.includes('/subtitles/get/show-2/1/1/spa')) {
        return new Response(
          JSON.stringify({ matchingSubtitles: [{ subtitleId: 'gd-2', version: 'Castellano' }] }),
          { status: 200 }
        );
      }
      return new Response('', { status: 404 });
    };
    const gdTitleResults = await searchGestdownSubtitles(
      {
        mediaKind: 'tv',
        title: 'Dark',
        seasonNumber: 1,
        episodeNumber: 1,
        sourceFileName: 'Dark.S01E01.mkv'
      },
      titleSearchFetch
    );
    expect(gdTitleResults).toHaveLength(1);
    expect(gdTitleResults[0]?.variant).toBe('spain');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-verif-tags-'));
    try {
      const moviesDir = path.join(tmpDir, 'movies');
      const movieFolder = path.join(moviesDir, 'Matrix (1999) {imdb-tt0133093} [1080p]');
      await fs.mkdir(movieFolder, { recursive: true });
      await fs.writeFile(path.join(movieFolder, 'Matrix (1999) {imdb-tt0133093} [1080p].mkv'), 'x');

      const cfg = loadConfig({
        CONFIG_DIR: path.join(tmpDir, 'config'),
        INPUT_DIR: path.join(tmpDir, 'input'),
        BACKUP_DIR: path.join(tmpDir, 'backup'),
        OUTPUT_MOVIES_DIR: moviesDir,
        OUTPUT_ANIMATED_MOVIES_DIR: path.join(tmpDir, 'anim-movies'),
        OUTPUT_TV_SHOWS_DIR: path.join(tmpDir, 'tv'),
        OUTPUT_ANIMATED_SERIES_DIR: path.join(tmpDir, 'anim-tv')
      });

      const scanResult = await scanLibrariesForCompliance(
        cfg,
        undefined,
        {
          lookupMovieByImdbId: async () => ({
            title: 'Matrix',
            year: 1999,
            imdbId: asImdbId('tt0133093'),
            source: 'imdb'
          })
        },
        undefined,
        undefined,
        true
      );
      expect(scanResult.entries).toHaveLength(1);
      expect(scanResult.entries[0]?.expectedRootName).toBe(
        'Matrix (1999) {imdb-tt0133093} [1080p, H.264, AAC 2.0]'
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('covers TV episode branches on OpenSubtitles REST, SubDL, and download errors', async () => {
    const tvFetch: typeof fetch = async (input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('api.opensubtitles.com/api/v1/subtitles')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'osr-tv',
                attributes: {
                  language: 'es',
                  release: 'Dark.S01E01.WEB-DL',
                  files: [{ file_id: 901 }]
                }
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.includes('api.subdl.com/api/v1/subtitles')) {
        return new Response(
          JSON.stringify({
            status: true,
            subtitles: [
              {
                sd_id: 88,
                release_name: 'Dark.S01E01',
                lang: 'ES',
                url: 'https://dl.subdl.com/88.zip'
              }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response('', { status: 404 });
    };

    const osTv = await searchOpenSubtitlesRest(
      {
        mediaKind: 'tv',
        title: 'Dark',
        seasonNumber: 1,
        episodeNumber: 1,
        sourceFileName: 'Dark.S01E01.mkv'
      },
      'os-key',
      tvFetch
    );
    expect(osTv).toHaveLength(1);

    const subdlTv = await searchSubdlSubtitles(
      {
        mediaKind: 'tv',
        title: 'Dark',
        year: 2017,
        seasonNumber: 1,
        episodeNumber: 1,
        sourceFileName: 'Dark.S01E01.mkv'
      },
      'subdl-key',
      tvFetch
    );
    expect(subdlTv).toHaveLength(1);
    await expect(
      resolveOpenSubtitlesRestDownloadUrl(
        'https://api.opensubtitles.com/api/v1/download',
        'os-key',
        tvFetch,
        undefined,
        -1
      )
    ).resolves.toBeNull();
    await expect(
      resolveOpenSubtitlesRestDownloadUrl(
        'https://api.opensubtitles.com/api/v1/download',
        undefined,
        tvFetch,
        undefined,
        901
      )
    ).resolves.toBeNull();
    await expect(
      resolveOpenSubtitlesRestDownloadUrl(
        'https://api.opensubtitles.com/api/v1/download',
        'os-key',
        async () => new Response('', { status: 404 }),
        undefined,
        901
      )
    ).resolves.toBeNull();

    const podnapisiRes = await searchPodnapisiSubtitles(
      {
        mediaKind: 'tv',
        title: 'Dark',
        year: 2017,
        seasonNumber: 1,
        episodeNumber: 1,
        sourceFileName: 'Dark.S01E01.mkv'
      },
      async () =>
        new Response(
          '<results><subtitle><pid>777</pid><url>/en/subtitles/es-dark/777</url><release>Dark.S01E01.Latino</release><downloads>42</downloads></subtitle></results>',
          { status: 200 }
        )
    );
    expect(podnapisiRes).toHaveLength(1);
    expect(podnapisiRes[0]?.provider).toBe('podnapisi');
    expect(podnapisiRes[0]?.variant).toBe('latam');
    await expect(
      searchPodnapisiSubtitles({ mediaKind: 'movie', title: '', sourceFileName: 'x.mkv' }, tvFetch)
    ).resolves.toEqual([]);
    await expect(
      searchPodnapisiSubtitles(
        { mediaKind: 'movie', title: 'X', sourceFileName: 'x.mkv' },
        async () => new Response('', { status: 500 })
      )
    ).resolves.toEqual([]);

    let loginCount = 0;
    let downloadAuthHeader = '';
    const authFetch: typeof fetch = async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/login')) {
        loginCount += 1;
        return new Response(
          JSON.stringify({
            token: `jwt-${String(loginCount)}`,
            base_url: 'vip-api.opensubtitles.com'
          }),
          { status: 200 }
        );
      }
      downloadAuthHeader = new Headers(init?.headers).get('Authorization') ?? '';
      if (loginCount === 1 && downloadAuthHeader === 'Bearer jwt-1') {
        return new Response('', { status: 401 });
      }
      return new Response(JSON.stringify({ link: 'https://cdn.os/auth-sub.srt' }), { status: 200 });
    };
    await expect(
      resolveOpenSubtitlesRestDownloadUrl(
        'https://api.opensubtitles.com/api/v1/download',
        'os-key-auth',
        authFetch,
        {
          username: 'franco',
          password: 'secret'
        },
        902
      )
    ).resolves.toBe('https://cdn.os/auth-sub.srt');
    expect(loginCount).toBe(2);
    expect(downloadAuthHeader).toBe('Bearer jwt-2');

    const stremioTv = await searchOpenSubtitlesStremio(
      {
        mediaKind: 'tv',
        title: 'Dark',
        imdbId: 'tt5753856',
        seasonNumber: 1,
        episodeNumber: 2,
        videoHash: '1234567890abcdef',
        videoSize: 5000,
        sourceFileName: 'Dark.S01E02.mkv'
      },
      async () =>
        new Response(
          JSON.stringify({
            subtitles: [
              { id: 'en-1', url: 'https://x/en.srt', lang: 'eng' },
              {
                id: 'es-1',
                url: 'https://x/es.srt',
                lang: 'spa',
                SubFileName: 'Dark.S01E02.Latino.srt',
                SubDownloadsCnt: 250,
                m: 'h'
              }
            ]
          }),
          { status: 200 }
        )
    );
    expect(stremioTv).toHaveLength(1);
    expect(stremioTv[0]?.hashMatch).toBe(true);
    await expect(
      searchOpenSubtitlesStremio(
        { mediaKind: 'movie', title: 'NoId', sourceFileName: 'NoId.mkv' },
        tvFetch
      )
    ).resolves.toEqual([]);
    await expect(
      searchOpenSubtitlesStremio(
        { mediaKind: 'movie', title: 'Fail', imdbId: 'tt1', sourceFileName: 'Fail.mkv' },
        async () => new Response('', { status: 500 })
      )
    ).resolves.toEqual([]);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-sub-err-'));
    try {
      const cfg = loadConfig({
        CONFIG_DIR: path.join(tmpDir, 'config'),
        INPUT_DIR: tmpDir,
        BACKUP_DIR: path.join(tmpDir, 'backup'),
        OUTPUT_MOVIES_DIR: path.join(tmpDir, 'out-movies'),
        OUTPUT_ANIMATED_MOVIES_DIR: path.join(tmpDir, 'out-anim-movies'),
        OUTPUT_TV_SHOWS_DIR: path.join(tmpDir, 'out-tv'),
        OUTPUT_ANIMATED_SERIES_DIR: path.join(tmpDir, 'out-anim-tv')
      });
      const dummyItem: ScannedItem = {
        id: asItemId('err-1'),
        sourcePath: path.join(tmpDir, 'Err.mkv'),
        relativePath: 'Err.mkv',
        fileName: 'Err.mkv',
        mediaKind: 'movie',
        category: 'movies',
        include: true,
        parsedTitle: 'Err',
        tags: [],
        probe: {
          formatName: 'matroska',
          durationSeconds: 10,
          sizeBytes: 100,
          bitrateBps: 100,
          videoStreams: [],
          audioStreams: [],
          subtitleStreams: []
        },
        externalSubtitles: [],
        candidates: [],
        episodeOrder: 'aired',
        trackSelection: {
          audioTracks: [],
          subtitleMergeMode: 'keep-and-add',
          includedInternalSubtitles: [],
          externalSubtitleOrder: [],
          needsUserPrompt: false
        },
        warnings: []
      };

      await expect(
        downloadSubtitleCandidateForItem(
          dummyItem,
          {
            id: 'e1',
            provider: 'gestdown',
            language: asIso639_2Code('spa'),
            variant: 'neutral',
            releaseName: 'Err',
            downloadUrl: 'https://bad.example/1.srt',
            hashMatch: false,
            score: 10
          },
          cfg,
          { fetchFn: async () => new Response('', { status: 404 }) }
        )
      ).rejects.toThrow('Subtitle download failed');

      await expect(
        downloadSubtitleCandidateForItem(
          dummyItem,
          {
            id: 'e2',
            provider: 'gestdown',
            language: asIso639_2Code('spa'),
            variant: 'neutral',
            releaseName: 'Err',
            downloadUrl: 'https://empty.example/1.srt',
            hashMatch: false,
            score: 10
          },
          cfg,
          { fetchFn: async () => new Response('   ', { status: 200 }) }
        )
      ).rejects.toThrow('empty');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('settles wave 1 keyless subtitle providers before starting wave 2 keyed providers', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-sub-waves-'));
    try {
      const cfg = await loadConfig({
        INPUT_DIR: tmpDir,
        MOVIES_DIR: tmpDir,
        DOCUMENTARIES_DIR: tmpDir,
        ANIMATED_MOVIES_DIR: tmpDir,
        TV_SHOWS_DIR: tmpDir,
        ANIMATED_SERIES_DIR: tmpDir,
        OPENSUBTITLES_API_KEY: 'os-key',
        SUBDL_API_KEY: 'subdl-key'
      });
      const videoPath = path.join(tmpDir, 'Wave Movie (2024).mkv');
      await fs.writeFile(videoPath, Buffer.alloc(128, 1));
      const item: ScannedItem = {
        id: asItemId('wave-1'),
        sourcePath: videoPath,
        relativePath: 'Wave Movie (2024).mkv',
        fileName: 'Wave Movie (2024).mkv',
        mediaKind: 'movie',
        category: 'movies',
        include: true,
        parsedTitle: 'Wave Movie',
        parsedYear: 2024,
        tags: [],
        probe: {
          formatName: 'matroska',
          durationSeconds: 10,
          sizeBytes: 128,
          bitrateBps: 100,
          videoStreams: [],
          audioStreams: [],
          subtitleStreams: []
        },
        selectedMetadata: {
          source: 'imdb',
          title: 'Wave Movie',
          year: 2024,
          imdbId: asImdbId('tt9876543')
        },
        externalSubtitles: [],
        candidates: [],
        episodeOrder: 'aired',
        trackSelection: {
          audioTracks: [],
          subtitleMergeMode: 'keep-and-add',
          includedInternalSubtitles: [],
          externalSubtitleOrder: [],
          needsUserPrompt: false
        },
        warnings: []
      };

      const events: string[] = [];
      let releaseKeyless!: () => void;
      const keylessBarrier = new Promise<void>((resolve) => {
        releaseKeyless = resolve;
      });
      let keyedStartedBeforeBarrier = false;

      const fetchFn: typeof fetch = async (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('opensubtitles.com') || url.includes('subdl.com')) {
          events.push(`keyed:${url}`);
          return new Response(JSON.stringify({ data: [], subtitles: [] }), { status: 200 });
        }
        events.push(`keyless-start:${url}`);
        await keylessBarrier;
        events.push(`keyless-end:${url}`);
        return new Response(JSON.stringify({ subtitles: [], episodes: [] }), { status: 200 });
      };

      const searchPromise = searchSpanishSubtitlesForItem(item, cfg, { fetchFn });
      await new Promise((r) => setTimeout(r, 20));
      keyedStartedBeforeBarrier = events.some((e) => e.startsWith('keyed:'));
      expect(keyedStartedBeforeBarrier).toBe(false);
      expect(events.some((e) => e.startsWith('keyless-start:'))).toBe(true);

      releaseKeyless();
      await searchPromise;
      const lastKeylessEnd = events.findLastIndex((e) => e.startsWith('keyless-end:'));
      const firstKeyed = events.findIndex((e) => e.startsWith('keyed:'));
      expect(lastKeylessEnd).toBeGreaterThanOrEqual(0);
      expect(firstKeyed).toBeGreaterThan(lastKeylessEnd);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('resolves missing imdbId from TVDB remoteIds before querying OpenSubtitles Stremio', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-tvdb-imdb-'));
    try {
      const videoPath = path.join(tmpDir, 'Mr.Robot.S01E05.mkv');
      await fs.writeFile(videoPath, Buffer.alloc(1024, 3));
      const cfg = loadConfig({
        CONFIG_DIR: tmpDir,
        INPUT_DIR: tmpDir,
        OUTPUT_MOVIES_DIR: tmpDir,
        OUTPUT_DOCUMENTARIES_DIR: tmpDir,
        OUTPUT_ANIMATED_MOVIES_DIR: tmpDir,
        OUTPUT_TV_SHOWS_DIR: tmpDir,
        OUTPUT_ANIMATED_SERIES_DIR: tmpDir,
        TVDB_API_KEY: 'tvdb-test-key'
      });

      const item: ScannedItem = {
        id: asItemId('tv-tvdb-only'),
        sourcePath: videoPath,
        relativePath: 'Mr.Robot.S01E05.mkv',
        fileName: 'Mr.Robot.S01E05.mkv',
        mediaKind: 'tv',
        category: 'tv-shows',
        include: true,
        parsedTitle: 'Mr. Robot',
        tags: [],
        episodeOrder: 'aired',
        episode: { seasonNumber: 1, episodeStart: 5 },
        probe: {
          formatName: 'matroska',
          durationSeconds: 2700,
          sizeBytes: 1024,
          bitrateBps: 1000,
          videoStreams: [],
          audioStreams: [],
          subtitleStreams: []
        },
        externalSubtitles: [],
        candidates: [],
        selectedMetadata: {
          title: 'Mr. Robot',
          year: 2015,
          tvdbId: asTvdbId('289590'),
          source: 'tvdb'
        },
        trackSelection: {
          audioTracks: [],
          subtitleMergeMode: 'keep-and-add',
          includedInternalSubtitles: [],
          externalSubtitleOrder: [],
          needsUserPrompt: false
        },
        warnings: []
      };

      const requestedUrls: string[] = [];
      const fetchFn: typeof fetch = async (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        requestedUrls.push(url);
        if (url.includes('thetvdb.com/v4/login')) {
          return new Response(JSON.stringify({ data: { token: 'jwt-1' } }), { status: 200 });
        }
        if (url.includes('thetvdb.com/v4/series/289590/extended')) {
          return new Response(
            JSON.stringify({
              data: {
                name: 'Mr. Robot',
                year: '2015',
                remoteIds: [{ id: 'tt4158110', sourceName: 'IMDB' }]
              }
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ subtitles: [], episodes: [] }), { status: 200 });
      };

      await searchSpanishSubtitlesForItem(item, cfg, { fetchFn });
      expect(
        requestedUrls.some((u) =>
          decodeURIComponent(u).includes('opensubtitles-v3.strem.io/subtitles/series/tt4158110:1:5')
        )
      ).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('blocks downloadItemSubtitle before writing to disk if an active run begins during search', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-sub-toctou-'));
    const inputDir = path.join(tmpDir, 'input');
    const configDir = path.join(tmpDir, 'config');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });

    try {
      const srcFile = path.join(inputDir, 'Movie (2024).mkv');
      await fs.writeFile(srcFile, 'video');
      await fs.writeFile(
        path.join(configDir, 'queue.json'),
        JSON.stringify({
          revision: 1,
          items: [
            {
              id: 'sub-item-1',
              sourcePath: srcFile,
              relativeSourcePath: 'Movie (2024).mkv',
              fileName: 'Movie (2024).mkv',
              extension: '.mkv',
              mediaKind: 'movie',
              category: 'movies',
              parsedTitle: 'Movie',
              parsedYear: 2024,
              episodeOrder: 'aired',
              include: true,
              probe: {
                formatName: 'matroska',
                durationSeconds: 120,
                sizeBytes: 1000,
                bitrateBps: 1000,
                videoStreams: [],
                audioStreams: [],
                subtitleStreams: []
              },
              externalSubtitles: [],
              trackSelection: { audioStreamIndices: [], subtitleStreamIndices: [] },
              candidates: [],
              needsUserPrompt: false,
              warnings: []
            }
          ]
        })
      );

      let releaseSearch!: () => void;
      const searchEntered = new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (searchCalls > 0) {
            clearInterval(timer);
            resolve();
          }
        }, 5);
      });
      let searchCalls = 0;
      const downloadSpy = vi.fn();

      const runner = new JobRunner(
        loadConfig({
          CONFIG_DIR: configDir,
          INPUT_DIR: inputDir,
          BACKUP_DIR: path.join(tmpDir, 'backup'),
          OUTPUT_MOVIES_DIR: tmpDir,
          OUTPUT_DOCUMENTARIES_DIR: tmpDir,
          OUTPUT_ANIMATED_MOVIES_DIR: tmpDir,
          OUTPUT_TV_SHOWS_DIR: tmpDir,
          OUTPUT_ANIMATED_SERIES_DIR: tmpDir
        }),
        {
          autoDownloadSubtitles: false,
          searchSubtitles: async (): Promise<SubtitleCandidate[]> => {
            searchCalls += 1;
            await new Promise<void>((resolve) => {
              releaseSearch = resolve;
            });
            return [
              {
                id: 'sub-cand-1',
                provider: 'subdl',
                language: asIso639_2Code('spa'),
                variant: 'latam',
                releaseName: 'Movie.2024',
                downloadUrl: 'https://example.invalid/sub.zip',
                hashMatch: false,
                downloadCount: 10,
                score: 100
              }
            ];
          },
          downloadSubtitle: downloadSpy
        }
      );
      await runner.init();

      const clientId = asClientId('client-sub:1');
      let pendingDownload: Promise<unknown> | undefined;
      try {
        pendingDownload = runner.downloadItemSubtitle(
          clientId,
          runner.getState().revision,
          asItemId('sub-item-1')
        );
        await searchEntered;
        runner.startScan(clientId);
        releaseSearch();

        await expect(pendingDownload).rejects.toMatchObject({ code: 'JOB_IN_PROGRESS' });
        expect(downloadSpy).not.toHaveBeenCalled();
      } finally {
        releaseSearch?.();
        await pendingDownload?.catch(() => undefined);
        await runner.unlock(clientId, true).catch(() => undefined);
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
