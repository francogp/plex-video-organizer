import fs from 'node:fs/promises';
import path from 'node:path';

import {
  asIso639_2Code,
  type ExternalSubtitleFile,
  type ImdbId,
  type LogLevel,
  type ScannedItem,
  type SubtitleCandidate
} from '../../../domain/types.ts';
import { type AppConfig, resolvePortableInputPath } from '../../config.ts';
import { lookupSeriesByTvdbId } from '../metadata/tvdbClient.ts';
import { searchGestdownSubtitles } from './providers/gestdownProvider.ts';
import {
  resolveOpenSubtitlesRestDownloadUrl,
  searchOpenSubtitlesRest
} from './providers/openSubtitlesRestProvider.ts';
import { searchOpenSubtitlesStremio } from './providers/openSubtitlesStremioProvider.ts';
import { searchPodnapisiSubtitles } from './providers/podnapisiProvider.ts';
import {
  createSubtitleHeaders,
  type FetchLike,
  type SubtitleRawCandidate,
  type SubtitleSearchQuery
} from './providers/providerTypes.ts';
import { searchSubdlSubtitles } from './providers/subdlProvider.ts';
import { searchYifySubtitles } from './providers/yifySubtitlesProvider.ts';
import { rankSubtitleCandidates } from './subtitleScorer.ts';
import { computeOpenSubtitlesHash } from './videoHash.ts';
import { extractSubtitleFromZip } from './zipExtractor.ts';

const DOWNLOAD_TIMEOUT_MS = 15_000;
const ZIP_SIGNATURE_FIRST_BYTE = 0x50;
const ZIP_SIGNATURE_SECOND_BYTE = 0x4b;

export interface SubtitleServiceDeps {
  readonly fetchFn?: FetchLike;
  readonly computeHash?: typeof computeOpenSubtitlesHash;
}

function buildSearchQuery(
  item: ScannedItem,
  videoHash?: string,
  videoSize?: number,
  resolvedImdbId?: ImdbId
): SubtitleSearchQuery {
  const meta = item.selectedMetadata;
  return {
    mediaKind: item.mediaKind,
    title: meta?.title ?? item.parsedTitle,
    year: meta?.year ?? item.parsedYear,
    imdbId: meta?.imdbId ?? resolvedImdbId,
    tvdbId: meta?.tvdbId,
    seasonNumber: item.episode?.seasonNumber,
    episodeNumber: item.episode?.episodeStart,
    videoHash,
    videoSize,
    sourceFileName: item.fileName
  };
}

function isZipBuffer(buf: Buffer): boolean {
  return (
    buf.length >= 2 && buf[0] === ZIP_SIGNATURE_FIRST_BYTE && buf[1] === ZIP_SIGNATURE_SECOND_BYTE
  );
}

async function resolveSubtitleTargetPath(
  item: ScannedItem,
  config: AppConfig,
  extension: string
): Promise<{ readonly absolutePath: string; readonly relativePath: string }> {
  const videoDir = path.dirname(item.sourcePath);
  const videoStem = path.basename(item.fileName, path.extname(item.fileName));
  const preferredFileName = `${videoStem}.spa${extension}`;
  const preferredPath = path.join(videoDir, preferredFileName);

  try {
    await fs.access(videoDir, fs.constants.W_OK);
    return {
      absolutePath: preferredPath,
      relativePath: path.relative(config.inputDir, preferredPath)
    };
  } catch {
    const fallbackDir = path.join(config.configDir, 'subtitles');
    await fs.mkdir(fallbackDir, { recursive: true });
    const fallbackFileName = `${item.id}.spa${extension}`;
    const fallbackPath = path.join(fallbackDir, fallbackFileName);
    return {
      absolutePath: fallbackPath,
      relativePath: fallbackFileName
    };
  }
}

/** Returns true if an item already has Spanish subtitles (embedded or external). */
export function hasSpanishSubtitles(item: ScannedItem): boolean {
  const hasExternal = item.externalSubtitles.some((sub) => sub.language === 'spa');
  const hasEmbedded = item.probe.subtitleStreams.some((sub) => sub.language === 'spa');
  return hasExternal || hasEmbedded;
}

/** Searches all configured Spanish subtitle providers and returns ranked candidates. */
export async function searchSpanishSubtitlesForItem(
  item: ScannedItem,
  config: AppConfig,
  deps: SubtitleServiceDeps = {},
  onLog?: (level: LogLevel, message: string) => void
): Promise<readonly SubtitleCandidate[]> {
  const fetchFn = deps.fetchFn ?? fetch;
  const computeHash = deps.computeHash ?? computeOpenSubtitlesHash;

  let videoHash: string | undefined;
  let videoSize: number | undefined;
  try {
    const readableVideoPath = await resolvePortableInputPath(
      config,
      item.sourcePath,
      item.relativePath
    );
    const hashInfo = await computeHash(readableVideoPath);
    videoHash = hashInfo.videoHash;
    videoSize = hashInfo.videoSize;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onLog?.('warn', `Video hash skipped for ${item.fileName}: ${msg}`);
  }

  let resolvedImdbId: ImdbId | undefined = item.selectedMetadata?.imdbId;
  if (!resolvedImdbId && item.selectedMetadata?.tvdbId && config.tvdbApiKey) {
    try {
      const series = await lookupSeriesByTvdbId(
        item.selectedMetadata.tvdbId,
        config.tvdbApiKey,
        fetchFn
      );
      resolvedImdbId = series?.imdbId;
    } catch {
      // Non-fatal fallback: continue searching with tvdbId/title/hash.
    }
  }

  const query = buildSearchQuery(item, videoHash, videoSize, resolvedImdbId);
  const keylessTasks: (() => Promise<readonly SubtitleRawCandidate[]>)[] = [
    () => searchOpenSubtitlesStremio(query, fetchFn),
    () => searchGestdownSubtitles(query, fetchFn),
    () => searchYifySubtitles(query, fetchFn),
    () => searchPodnapisiSubtitles(query, fetchFn)
  ];
  const keyedTasks: (() => Promise<readonly SubtitleRawCandidate[]>)[] = [];
  const openSubtitlesApiKey = config.openSubtitlesApiKey;
  if (openSubtitlesApiKey) {
    keyedTasks.push(() => searchOpenSubtitlesRest(query, openSubtitlesApiKey, fetchFn));
  }
  const subdlApiKey = config.subdlApiKey;
  if (subdlApiKey) {
    keyedTasks.push(() => searchSubdlSubtitles(query, subdlApiKey, fetchFn));
  }

  const combined: SubtitleRawCandidate[] = [];
  const collectSettled = async (
    tasks: readonly (() => Promise<readonly SubtitleRawCandidate[]>)[]
  ): Promise<void> => {
    if (tasks.length === 0) {
      return;
    }
    const settled = await Promise.allSettled(tasks.map((run) => run()));
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        combined.push(...outcome.value);
      }
    }
  };

  await collectSettled(keylessTasks);
  await collectSettled(keyedTasks);

  return rankSubtitleCandidates(combined, item.fileName);
}

/** Downloads a subtitle candidate to disk and returns the registered `ExternalSubtitleFile`. */
export async function downloadSubtitleCandidateForItem(
  item: ScannedItem,
  candidate: SubtitleCandidate,
  config: AppConfig,
  deps: SubtitleServiceDeps = {}
): Promise<ExternalSubtitleFile> {
  const fetchFn = deps.fetchFn ?? fetch;
  const resolvedUrl = await resolveOpenSubtitlesRestDownloadUrl(
    candidate.downloadUrl,
    config.openSubtitlesApiKey,
    fetchFn,
    {
      username: config.openSubtitlesUsername,
      password: config.openSubtitlesPassword
    },
    candidate.remoteFileId
  );
  if (!resolvedUrl) {
    throw new Error('Could not resolve subtitle download URL (check OPENSUBTITLES_API_KEY).');
  }

  const response = await fetchFn(resolvedUrl, {
    headers: createSubtitleHeaders('*/*'),
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(
      `Subtitle download failed (${String(response.status)}) from ${candidate.provider}`
    );
  }

  const rawBuffer = Buffer.from(await response.arrayBuffer());
  let subtitleBuffer: Buffer = rawBuffer;
  let extension = '.srt';

  if (candidate.isArchive || isZipBuffer(rawBuffer)) {
    const extracted = extractSubtitleFromZip(rawBuffer);
    if (!extracted) {
      throw new Error(`Archive from ${candidate.provider} did not contain an .srt or .vtt file.`);
    }
    subtitleBuffer = extracted.content;
    extension = path.extname(extracted.fileName).toLowerCase() === '.vtt' ? '.vtt' : '.srt';
  }

  const text = subtitleBuffer.toString('utf8').trim();
  if (text.length === 0) {
    throw new Error(`Downloaded subtitle from ${candidate.provider} is empty.`);
  }

  const target = await resolveSubtitleTargetPath(item, config, extension);
  await fs.writeFile(target.absolutePath, subtitleBuffer);

  return {
    path: target.absolutePath,
    relativePath: target.relativePath,
    extension,
    language: asIso639_2Code('spa'),
    isForced: false,
    isHearingImpaired: false,
    isLanguageAmbiguous: false,
    downloadedFrom: candidate.provider
  };
}
