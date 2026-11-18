import crypto from 'node:crypto';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { runSlotWorkerPool } from '../../domain/concurrency.ts';
import {
  AUDIO_SCAN_CONCURRENCY,
  DISK_IMAGE_EXTENSION_SET,
  DISK_IMAGE_FOLDER_SET,
  EXCLUDED_FOLDER_TOKENS,
  LANGUAGE_CODE_MAP,
  ORGANIZING_TEMP_MARKER,
  ORGANIZING_TEMP_SUFFIX,
  PERCENT_MAX,
  PLEX_EXTRA_FOLDER_SET,
  PLEX_INLINE_EXTRA_SUFFIXES,
  PLEX_SAMPLE_MAX_BYTES,
  SUBTITLE_EXTENSION_SET,
  SUBTITLE_FOLDER_SET,
  isHiddenOrTempEntryName,
  isVideoExtension,
  type LanguageAlias
} from '../../domain/constants.ts';
import { resolveChannelProfile } from '../../domain/eta.ts';
import { extractSplitPart } from '../../domain/plexFormatter.ts';
import { extractPlexTags } from '../../domain/plexTagExtractor.ts';
import { buildFilteredAudioTracks } from '../../domain/trackSelection.ts';
import {
  asImdbId,
  asIso639_2Code,
  asItemId,
  type AudioLanguageCode,
  asTmdbId,
  asTvdbId,
  collectActiveTasks,
  type ActiveParallelTask,
  type AudioTrackAnalysis,
  type EpisodeInfo,
  type EtaChannelProfile,
  type ExternalSubtitleFile,
  type ImdbId,
  type Iso639_2Code,
  type ItemId,
  type MediaKind,
  type MediaProbeSummary,
  type MetadataCandidate,
  type OutputCategory,
  type ScannedItem,
  type TmdbId,
  type TrackSelection,
  type TvdbId
} from '../../domain/types.ts';
import type { EtaInventoryEntry, EtaPredictor } from './etaPredictor.ts';
import { hasIgnoredAncestorSegment } from './fileMover.ts';
import type { FfmpegProgressUpdate } from './media/ffmpegRunner.ts';
import {
  buildFileStatCacheEntry,
  openScanCacheDb,
  probeVideoWithCache,
  type ScanCacheDb
} from './scanCacheDb.ts';

const SEASON_FOLDER_REGEX = /\b(?:season|temporada|specials)\s*(\d{0,2})\b/i;
const STANDALONE_SEASON_REGEX = /(?:^|[\s._-])s\d{1,2}(?=$|[\s._-])/i;
const SXXEXX_REGEX = /\bs(\d{1,2})e(\d{1,3})(?:-?e(\d{1,3}))?\b/i;
const NXNN_REGEX = /(?:^|[\s._-])(\d{1,2})x(\d{2,3})(?=$|[\s._-])/i;
const DATE_YMD_REGEX = /(?:^|[\s._-])(\d{4})[-.\s](\d{2})[-.\s](\d{2})(?=$|[\s._-])/;
const DATE_DMY_REGEX = /(?:^|[\s._-])(\d{2})[-.\s](\d{2})[-.\s](\d{4})(?=$|[\s._-])/;
const YEAR_REGEX = /\b(19\d{2}|20\d{2})\b/;
const RELEASE_MARKER_REGEX =
  /(?:^|[\s._-])(?:2160p|1080p|720p|480p|4k|uhd|hdr\d*|bluray|bdrip|brrip|web-?dl|webrip|hdtv|dvdrip|remux|uncensored|x264|x265|h\.?264|h\.?265|hevc|av1|aac\d*(?:\.\d)?|ac3|eac3|dts|flac|dual|multi|esub|subbed|proper|repack|complete)(?=$|[\s._-])/i;
const INLINE_EXTRA_REGEX = new RegExp(`-(?:${PLEX_INLINE_EXTRA_SUFFIXES.join('|')})\\d*$`, 'i');
const MICRODVD_TEXT_REGEX = /^\{\d+\}\{\d+\}/;
const SAMPLE_SNIFF_BYTES = 128;
const MIN_MEDIA_YEAR = 1888;

export interface PlexmatchHints {
  readonly title?: string;
  readonly year?: number;
  readonly season?: number;
  readonly tvdbId?: TvdbId;
  readonly tmdbId?: TmdbId;
  readonly imdbId?: ImdbId;
  readonly pattern?: string;
  readonly episodes: ReadonlyMap<string, string>;
}

function escapeGlobToRegex(glob: string): RegExp {
  const escaped = glob.replaceAll(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesPlexignore(
  relPosixPath: string,
  fileName: string,
  rules: readonly { readonly dirPosix: string; readonly pattern: string }[]
): boolean {
  for (const rule of rules) {
    const clean = rule.pattern.trim();
    if (!clean || clean.startsWith('#')) {
      continue;
    }
    if (clean.includes('/')) {
      const target = rule.dirPosix ? `${rule.dirPosix}/${clean}` : clean;
      if (escapeGlobToRegex(target.replaceAll(/^\//g, '')).test(relPosixPath)) {
        return true;
      }
    } else if (escapeGlobToRegex(clean).test(fileName)) {
      return true;
    }
  }
  return false;
}

interface MutablePlexmatchHints {
  title?: string;
  year?: number;
  season?: number;
  tvdbId?: TvdbId;
  tmdbId?: TmdbId;
  imdbId?: ImdbId;
  pattern?: string;
  readonly episodes: Map<string, string>;
}

function applyPlexmatchGuid(hints: MutablePlexmatchHints, val: string): void {
  const imdbMatch = /^imdb:\/\/(tt\d+)/i.exec(val);
  if (imdbMatch?.[1]) {
    hints.imdbId = asImdbId(imdbMatch[1]);
    return;
  }
  const tvdbMatch = /^tvdb:\/\/(\d+)/i.exec(val);
  if (tvdbMatch?.[1]) {
    hints.tvdbId = asTvdbId(tvdbMatch[1]);
    return;
  }
  const tmdbMatch = /^tmdb:\/\/(\d+)/i.exec(val);
  if (tmdbMatch?.[1]) {
    hints.tmdbId = asTmdbId(tmdbMatch[1]);
  }
}

function applyPlexmatchKeyVal(hints: MutablePlexmatchHints, key: string, val: string): void {
  if (key === 'title' || key === 'show') {
    hints.title = val;
    return;
  }
  if (key === 'year') {
    const y = Number(val);
    if (Number.isInteger(y) && y >= MIN_MEDIA_YEAR) {
      hints.year = y;
    }
    return;
  }
  if (key === 'season') {
    const s = Number(val);
    if (Number.isInteger(s) && s >= 0) {
      hints.season = s;
    }
    return;
  }
  if (key === 'tvdbid' && /^\d+$/.test(val)) {
    hints.tvdbId = asTvdbId(val);
    return;
  }
  if (key === 'tmdbid' && /^\d+$/.test(val)) {
    hints.tmdbId = asTmdbId(val);
    return;
  }
  if (key === 'imdbid') {
    const normalized = val.startsWith('tt') ? val : `tt${val}`;
    if (/^tt\d+$/.test(normalized)) {
      hints.imdbId = asImdbId(normalized);
    }
    return;
  }
  if (key === 'guid') {
    applyPlexmatchGuid(hints, val);
    return;
  }
  if (key === 'pattern' || key === 'pt') {
    hints.pattern = val;
    return;
  }
  if (key === 'ep' || key === 'episode') {
    const epColon = val.indexOf(':');
    if (epColon > 0) {
      hints.episodes.set(val.slice(epColon + 1).trim(), val.slice(0, epColon).trim());
    }
  }
}

function parsePlexmatchContent(raw: string): PlexmatchHints {
  const hints: MutablePlexmatchHints = { episodes: new Map<string, string>() };

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) {
      continue;
    }
    applyPlexmatchKeyVal(
      hints,
      line.slice(0, colonIdx).trim().toLowerCase(),
      line.slice(colonIdx + 1).trim()
    );
  }

  return hints;
}

function resolveCascadedPlexmatchHints(
  startDir: string,
  inputDir: string,
  plexmatchByDir: ReadonlyMap<string, PlexmatchHints>
): PlexmatchHints | undefined {
  const chain: PlexmatchHints[] = [];
  let cursor = path.resolve(startDir);
  const root = path.resolve(inputDir);

  while (cursor.startsWith(root)) {
    const hint = plexmatchByDir.get(cursor);
    if (hint) {
      chain.unshift(hint);
    }
    if (cursor === root) {
      break;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  if (chain.length === 0) {
    return undefined;
  }

  const mergedEpisodes = new Map<string, string>();
  let title: string | undefined;
  let year: number | undefined;
  let season: number | undefined;
  let tvdbId: TvdbId | undefined;
  let tmdbId: TmdbId | undefined;
  let imdbId: ImdbId | undefined;
  let pattern: string | undefined;

  for (const hint of chain) {
    title = hint.title ?? title;
    year = hint.year ?? year;
    season = hint.season ?? season;
    tvdbId = hint.tvdbId ?? tvdbId;
    tmdbId = hint.tmdbId ?? tmdbId;
    imdbId = hint.imdbId ?? imdbId;
    pattern = hint.pattern ?? pattern;
    for (const [k, v] of hint.episodes) {
      mergedEpisodes.set(k, v);
    }
  }

  return { title, year, season, tvdbId, tmdbId, imdbId, pattern, episodes: mergedEpisodes };
}

function applyPlexmatchEpisodeOverride(
  fileName: string,
  baseNoExt: string,
  relPosix: string,
  dirHints: PlexmatchHints | undefined,
  fallbackEpisode: EpisodeInfo | undefined
): EpisodeInfo | undefined {
  const rawCode =
    dirHints?.episodes.get(fileName) ??
    dirHints?.episodes.get(relPosix) ??
    dirHints?.episodes.get(baseNoExt);
  if (!rawCode) {
    return fallbackEpisode;
  }
  const sxx = SXXEXX_REGEX.exec(rawCode);
  if (sxx) {
    return {
      seasonNumber: Number(sxx[1]),
      episodeStart: Number(sxx[2]),
      episodeEnd: sxx[3] ? Number(sxx[3]) : undefined
    };
  }
  const nxn = NXNN_REGEX.exec(rawCode);
  if (nxn) {
    return {
      seasonNumber: Number(nxn[1]),
      episodeStart: Number(nxn[2])
    };
  }
  const numOnly = /^(\d{1,3})$/.exec(rawCode.trim());
  if (numOnly) {
    return {
      seasonNumber: dirHints?.season ?? fallbackEpisode?.seasonNumber ?? 1,
      episodeStart: Number(numOnly[1])
    };
  }
  return fallbackEpisode;
}

function isExcludedFolderSegment(segment: string): boolean {
  if (isHiddenOrTempEntryName(segment)) {
    return true;
  }
  const lower = segment.toLowerCase();
  if (
    DISK_IMAGE_FOLDER_SET.has(
      lower as typeof DISK_IMAGE_FOLDER_SET extends ReadonlySet<infer U> ? U : never
    ) ||
    PLEX_EXTRA_FOLDER_SET.has(
      lower as typeof PLEX_EXTRA_FOLDER_SET extends ReadonlySet<infer U> ? U : never
    ) ||
    SUBTITLE_FOLDER_SET.has(
      lower as typeof SUBTITLE_FOLDER_SET extends ReadonlySet<infer U> ? U : never
    )
  ) {
    return true;
  }
  return EXCLUDED_FOLDER_TOKENS.some((token): boolean => lower.includes(token));
}

function normalizeIsoLanguage(token: string): Iso639_2Code | undefined {
  const lower = token.toLowerCase();
  if (Object.hasOwn(LANGUAGE_CODE_MAP, lower)) {
    return asIso639_2Code(LANGUAGE_CODE_MAP[lower as LanguageAlias]);
  }
  return undefined;
}

async function isBinarySubFile(subPath: string): Promise<boolean> {
  try {
    const handle = await fs.open(subPath, 'r');
    try {
      const buf = Buffer.alloc(SAMPLE_SNIFF_BYTES);
      const { bytesRead } = await handle.read(buf, 0, SAMPLE_SNIFF_BYTES, 0);
      const snippet = buf.subarray(0, bytesRead).toString('utf8');
      if (snippet.includes('\u0000')) {
        return true;
      }
      return !MICRODVD_TEXT_REGEX.test(snippet.trim()) && !snippet.trim().startsWith('#');
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

function detectSubtitleLanguageAndFlags(tokens: readonly string[]): {
  readonly isForced: boolean;
  readonly isHearingImpaired: boolean;
  readonly detectedLang: Iso639_2Code | undefined;
} {
  const isForced = tokens.includes('forced');
  const isHearingImpaired = tokens.includes('sdh') || tokens.includes('cc');
  let detectedLang: Iso639_2Code | undefined;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const tok = tokens[i];
    if (!tok || tok === 'forced' || tok === 'sdh' || tok === 'cc') {
      continue;
    }
    detectedLang = normalizeIsoLanguage(tok);
    if (detectedLang) {
      break;
    }
  }
  return { isForced, isHearingImpaired, detectedLang };
}

async function resolveExternalSubtitleEntry(
  entry: { readonly name: string },
  dir: string,
  videoDir: string,
  videoStem: string,
  inputDir: string,
  hasMultipleVideosInDir: boolean,
  idxFiles: ReadonlySet<string>
): Promise<ExternalSubtitleFile | null> {
  const ext = path.extname(entry.name).toLowerCase();
  if (
    ext === '.idx' ||
    !SUBTITLE_EXTENSION_SET.has(
      ext as typeof SUBTITLE_EXTENSION_SET extends ReadonlySet<infer U> ? U : never
    )
  ) {
    return null;
  }

  const fullPath = path.join(dir, entry.name);
  const baseName = path.basename(entry.name, ext);
  const lowerBase = baseName.toLowerCase();
  if (dir === videoDir && !lowerBase.startsWith(videoStem) && hasMultipleVideosInDir) {
    return null;
  }

  const subtitleTokens =
    lowerBase.startsWith(videoStem) && lowerBase.length > videoStem.length
      ? lowerBase.slice(videoStem.length).split('.').filter(Boolean)
      : lowerBase.split('.').slice(1);
  const { isForced, isHearingImpaired, detectedLang } =
    detectSubtitleLanguageAndFlags(subtitleTokens);

  let idxPairPath: string | undefined;
  let missingIdxWarning: string | undefined;
  if (ext === '.sub') {
    if (idxFiles.has(lowerBase)) {
      idxPairPath = path.join(dir, `${baseName}.idx`);
    } else if (await isBinarySubFile(fullPath)) {
      missingIdxWarning = `Binary VobSub file "${entry.name}" is missing its companion .idx file.`;
    }
  }

  return {
    path: fullPath,
    relativePath: path.relative(inputDir, fullPath),
    extension: ext,
    language: detectedLang ?? asIso639_2Code('und'),
    isForced,
    isHearingImpaired,
    isLanguageAmbiguous: !detectedLang,
    idxPairPath,
    missingIdxWarning
  };
}

async function collectExternalSubtitles(
  videoPath: string,
  inputDir: string
): Promise<readonly ExternalSubtitleFile[]> {
  const videoDir = path.dirname(videoPath);
  const videoStem = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  const candidateDirs = [videoDir];

  try {
    const entries = await fs.readdir(videoDir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !isHiddenOrTempEntryName(entry.name) &&
        SUBTITLE_FOLDER_SET.has(entry.name.toLowerCase() as 'subs' | 'subtitles')
      ) {
        candidateDirs.push(path.join(videoDir, entry.name));
      }
    }
  } catch {
    // Ignore unreadable subfolder
  }

  const results: ExternalSubtitleFile[] = [];
  for (const dir of candidateDirs) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const fileEntries = entries.filter(
      (e): boolean => e.isFile() && !isHiddenOrTempEntryName(e.name)
    );
    const idxFiles = new Set(
      fileEntries
        .filter((e): boolean => path.extname(e.name).toLowerCase() === '.idx')
        .map((e): string => path.basename(e.name, path.extname(e.name)).toLowerCase())
    );
    const hasMultipleVideosInDir =
      fileEntries.filter((e): boolean => isVideoExtension(path.extname(e.name).toLowerCase()))
        .length > 1;

    for (const entry of fileEntries) {
      const sub = await resolveExternalSubtitleEntry(
        entry,
        dir,
        videoDir,
        videoStem,
        inputDir,
        hasMultipleVideosInDir,
        idxFiles
      );
      if (sub) {
        results.push(sub);
      }
    }
  }

  return results;
}

function parseEpisodeInfo(
  relativePath: string,
  fileNameNoExt: string,
  plexmatchSeason?: number
): EpisodeInfo | undefined {
  const sxxExx = SXXEXX_REGEX.exec(fileNameNoExt);
  if (sxxExx?.[1] && sxxExx[2]) {
    return {
      seasonNumber: Number(sxxExx[1]),
      episodeStart: Number(sxxExx[2]),
      episodeEnd: sxxExx[3] ? Number(sxxExx[3]) : undefined,
      splitPart: extractSplitPart(fileNameNoExt)
    };
  }

  const nxnn = NXNN_REGEX.exec(fileNameNoExt);
  if (nxnn?.[1] && nxnn[2]) {
    return {
      seasonNumber: Number(nxnn[1]),
      episodeStart: Number(nxnn[2]),
      splitPart: extractSplitPart(fileNameNoExt)
    };
  }

  const ymd = DATE_YMD_REGEX.exec(fileNameNoExt);
  if (ymd?.[1] && ymd[2] && ymd[3]) {
    return {
      seasonNumber: plexmatchSeason ?? Number(ymd[1]),
      episodeStart: 1,
      airDate: `${ymd[1]}-${ymd[2]}-${ymd[3]}`,
      splitPart: extractSplitPart(fileNameNoExt)
    };
  }

  const dmy = DATE_DMY_REGEX.exec(fileNameNoExt);
  if (dmy?.[1] && dmy[2] && dmy[3]) {
    return {
      seasonNumber: plexmatchSeason ?? Number(dmy[3]),
      episodeStart: 1,
      airDate: `${dmy[3]}-${dmy[2]}-${dmy[1]}`,
      splitPart: extractSplitPart(fileNameNoExt)
    };
  }

  const segments = path.dirname(relativePath).split(path.sep);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const seg = segments[i];
    if (!seg) {
      continue;
    }
    const seasonMatch = SEASON_FOLDER_REGEX.exec(seg);
    if (seasonMatch) {
      const seasonNum = seg.toLowerCase().includes('special') ? 0 : Number(seasonMatch[1] || '1');
      return {
        seasonNumber: plexmatchSeason ?? seasonNum,
        episodeStart: 1,
        splitPart: extractSplitPart(fileNameNoExt)
      };
    }
  }

  return undefined;
}

export function cleanTitleFromName(rawName: string): {
  readonly title: string;
  readonly year?: number;
} {
  const yearMatch = YEAR_REGEX.exec(rawName);
  const year = yearMatch?.[1] ? Number(yearMatch[1]) : undefined;

  const cutCandidates = [
    SXXEXX_REGEX.exec(rawName)?.index,
    NXNN_REGEX.exec(rawName)?.index,
    DATE_YMD_REGEX.exec(rawName)?.index,
    DATE_DMY_REGEX.exec(rawName)?.index,
    SEASON_FOLDER_REGEX.exec(rawName)?.index,
    STANDALONE_SEASON_REGEX.exec(rawName)?.index,
    RELEASE_MARKER_REGEX.exec(rawName)?.index,
    yearMatch?.index
  ].filter((idx): idx is number => typeof idx === 'number' && idx > 0);

  let title = cutCandidates.length > 0 ? rawName.slice(0, Math.min(...cutCandidates)) : rawName;
  const leadingBracketMatch = /^(\[[^\]]+\])/.exec(title);
  const leadingBracket = leadingBracketMatch?.[1] ?? '';
  const remainderTitle = leadingBracket ? title.slice(leadingBracket.length) : title;
  const cleanedRemainder = remainderTitle
    .replaceAll(/\[[^\]]*\]/g, ' ')
    .replaceAll(/\{[^}]*\}/g, ' ')
    .replaceAll(/[._]/g, ' ')
    .replaceAll(/[()]/g, ' ')
    .replaceAll(/[\s-]+$/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim();
  title = `${leadingBracket} ${cleanedRemainder}`.trim();
  return { title: title || rawName, year };
}

function buildInitialTrackSelection(
  probe: MediaProbeSummary,
  externalSubtitles: readonly ExternalSubtitleFile[],
  audioPreferredLanguages?: readonly AudioLanguageCode[]
): TrackSelection {
  const audioTracks = buildFilteredAudioTracks(probe.audioStreams, audioPreferredLanguages);

  const subtitleCollisionKey = (sub: {
    readonly language: string;
    readonly isForced: boolean;
    readonly isHearingImpaired: boolean;
  }): string => `${sub.language}:${String(sub.isForced)}:${String(sub.isHearingImpaired)}`;

  const hasAmbiguousLang = externalSubtitles.some(
    (s) => s.isLanguageAmbiguous || Boolean(s.missingIdxWarning)
  );
  const internalKeys = new Set(probe.subtitleStreams.map(subtitleCollisionKey));
  const externalLangCounts = new Map<string, number>();
  let hasInternalExternalCollision = false;
  for (const sub of externalSubtitles) {
    const key = subtitleCollisionKey(sub);
    externalLangCounts.set(key, (externalLangCounts.get(key) ?? 0) + 1);
    if (internalKeys.has(key)) {
      hasInternalExternalCollision = true;
    }
  }
  const hasDuplicateCollision = Array.from(externalLangCounts.values()).some((c): boolean => c > 1);

  const needsUserPrompt = hasAmbiguousLang || hasDuplicateCollision || hasInternalExternalCollision;
  let promptReason: string | undefined;
  if (hasAmbiguousLang) {
    promptReason =
      'One or more external subtitle files have an unrecognized language or missing .idx pair.';
  } else if (hasDuplicateCollision) {
    promptReason = 'Multiple external subtitles share the same language and flags.';
  } else if (hasInternalExternalCollision) {
    promptReason =
      'One or more external subtitles share the same language and flags as an existing embedded subtitle.';
  }

  return {
    audioTracks,
    subtitleMergeMode: 'keep-and-add',
    includedInternalSubtitles: probe.subtitleStreams.map((s) => s.streamOrder),
    externalSubtitleOrder: externalSubtitles.map((s) => s.path),
    needsUserPrompt,
    promptReason
  };
}

export type ProbeFn = (filePath: string) => Promise<MediaProbeSummary>;

interface PlexignoreRule {
  readonly dirPosix: string;
  readonly pattern: string;
}

interface ScanEntryLike {
  isFile(): boolean;
  readonly name: string;
  readonly parentPath: string;
}

async function collectDirectoryHints(
  entries: readonly ScanEntryLike[],
  inputDir: string,
  shouldCancel?: () => boolean
): Promise<{
  readonly plexignoreRules: readonly PlexignoreRule[];
  readonly plexmatchByDir: ReadonlyMap<string, PlexmatchHints>;
}> {
  const plexignoreRules: PlexignoreRule[] = [];
  const plexmatchByDir = new Map<string, PlexmatchHints>();

  for (const entry of entries) {
    if (shouldCancel?.()) {
      break;
    }
    if (!entry.isFile() || hasIgnoredAncestorSegment(inputDir, entry.parentPath)) {
      continue;
    }
    const fullPath = path.join(entry.parentPath, entry.name);
    const relDirPosix = path.relative(inputDir, entry.parentPath).split(path.sep).join('/');
    if (entry.name === '.plexignore') {
      const content = await fs.readFile(fullPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        plexignoreRules.push({ dirPosix: relDirPosix === '.' ? '' : relDirPosix, pattern: line });
      }
    } else if (entry.name === '.plexmatch') {
      const content = await fs.readFile(fullPath, 'utf8');
      plexmatchByDir.set(entry.parentPath, parsePlexmatchContent(content));
    }
  }

  return { plexignoreRules, plexmatchByDir };
}

function isSkippableVideoEntry(entry: ScanEntryLike, inputDir: string): boolean {
  if (
    !entry.isFile() ||
    isHiddenOrTempEntryName(entry.name) ||
    hasIgnoredAncestorSegment(inputDir, entry.parentPath)
  ) {
    return true;
  }
  return entry.name.includes(ORGANIZING_TEMP_MARKER) && entry.name.endsWith(ORGANIZING_TEMP_SUFFIX);
}

interface CandidateEntryPaths {
  readonly fullPath: string;
  readonly relPath: string;
  readonly relPosix: string;
  readonly baseNoExt: string;
  readonly dirSegments: readonly string[];
}

function resolveCandidateEntryPaths(
  entry: ScanEntryLike,
  inputDir: string,
  plexignoreRules: readonly PlexignoreRule[]
): CandidateEntryPaths | null {
  if (isSkippableVideoEntry(entry, inputDir)) {
    return null;
  }

  const fullPath = path.join(entry.parentPath, entry.name);
  const relPath = path.relative(inputDir, fullPath);
  const relPosix = relPath.split(path.sep).join('/');
  const ext = path.extname(entry.name).toLowerCase();
  const baseNoExt = path.basename(entry.name, ext);

  if (
    DISK_IMAGE_EXTENSION_SET.has(ext as never) ||
    !isVideoExtension(ext) ||
    INLINE_EXTRA_REGEX.test(baseNoExt)
  ) {
    return null;
  }

  const dirSegments = path
    .dirname(relPath)
    .split(path.sep)
    .filter((s): boolean => s !== '.');
  if (
    dirSegments.some((seg): boolean => isExcludedFolderSegment(seg)) ||
    matchesPlexignore(relPosix, entry.name, plexignoreRules)
  ) {
    return null;
  }

  return { fullPath, relPath, relPosix, baseNoExt, dirSegments };
}

async function buildScannedItemFromEntry(
  entry: ScanEntryLike,
  inputDir: string,
  probeFile: ProbeFn,
  plexignoreRules: readonly PlexignoreRule[],
  plexmatchByDir: ReadonlyMap<string, PlexmatchHints>,
  audioPreferredLanguages?: readonly AudioLanguageCode[]
): Promise<ScannedItem | null> {
  const paths = resolveCandidateEntryPaths(entry, inputDir, plexignoreRules);
  if (!paths) {
    return null;
  }
  const { fullPath, relPath, relPosix, baseNoExt, dirSegments } = paths;

  const stat = await fs.stat(fullPath);
  if (entry.name.toLowerCase().includes('sample') && stat.size < PLEX_SAMPLE_MAX_BYTES) {
    return null;
  }

  const dirHints = resolveCascadedPlexmatchHints(entry.parentPath, inputDir, plexmatchByDir);
  const parsedEpisode = parseEpisodeInfo(relPath, baseNoExt, dirHints?.season);
  const episode = applyPlexmatchEpisodeOverride(
    entry.name,
    baseNoExt,
    relPosix,
    dirHints,
    parsedEpisode
  );
  const mediaKind: MediaKind = episode ? 'tv' : 'movie';
  const category: OutputCategory = mediaKind === 'tv' ? 'tv-shows' : 'movies';

  const probe = await probeFile(fullPath);
  const externalSubtitles = await collectExternalSubtitles(fullPath, inputDir);
  const warnings = externalSubtitles
    .map((sub) => sub.missingIdxWarning)
    .filter((w): w is string => Boolean(w));

  const nameHintSource = mediaKind === 'tv' && dirSegments[0] ? dirSegments[0] : baseNoExt;
  const parsedFromPath = cleanTitleFromName(nameHintSource);
  const parsedTitle = dirHints?.title ?? parsedFromPath.title;
  const fallbackFileYear =
    parsedFromPath.year === undefined && nameHintSource !== baseNoExt
      ? cleanTitleFromName(baseNoExt).year
      : undefined;
  const parsedYear = dirHints?.year ?? parsedFromPath.year ?? fallbackFileYear;

  const candidates: MetadataCandidate[] = [];
  if (dirHints?.imdbId || dirHints?.tvdbId || dirHints?.tmdbId) {
    candidates.push({
      title: parsedTitle,
      year: parsedYear,
      imdbId: dirHints.imdbId,
      tvdbId: dirHints.tvdbId,
      tmdbId: dirHints.tmdbId,
      source: 'plexmatch'
    });
  }

  const trackSelection = buildInitialTrackSelection(
    probe,
    externalSubtitles,
    audioPreferredLanguages
  );
  const idHash = crypto.createHash('sha1').update(relPosix).digest('hex').slice(0, 12);
  return {
    id: asItemId(idHash),
    sourcePath: fullPath,
    relativePath: relPath,
    fileName: entry.name,
    mediaKind,
    category,
    include: true,
    parsedTitle,
    parsedYear,
    tags: extractPlexTags(baseNoExt, probe, { trackSelection }),
    splitPart: extractSplitPart(baseNoExt),
    episode,
    probe,
    externalSubtitles,
    candidates,
    selectedMetadata: candidates[0],
    episodeOrder: 'aired',
    trackSelection,
    warnings
  };
}

/** Options for `scanInputDirectory` enabling persistent `ffprobe` caching and progress callbacks. */
export interface ScanInputOptions {
  readonly configDir?: string;
  readonly audioPreferredLanguages?: readonly AudioLanguageCode[];
  readonly onProgress?: (completed: number, total: number) => void;
  readonly etaPredictor?: EtaPredictor;
}

function isCandidateVideoEntry(
  entry: Dirent,
  inputDir: string,
  plexignoreRules: readonly PlexignoreRule[]
): boolean {
  return resolveCandidateEntryPaths(entry, inputDir, plexignoreRules) !== null;
}

/** Walks `inputDir` with Node 26 native recursive `readdir` and produces `ScannedItem[]`. */
export async function scanInputDirectory(
  inputDir: string,
  probeFile: ProbeFn,
  shouldCancel?: () => boolean,
  options?: ScanInputOptions
): Promise<readonly ScannedItem[]> {
  const entries = await fs.readdir(inputDir, { recursive: true, withFileTypes: true });
  const { plexignoreRules, plexmatchByDir } = await collectDirectoryHints(
    entries,
    inputDir,
    shouldCancel
  );

  const candidateEntries = entries.filter((entry) =>
    isCandidateVideoEntry(entry, inputDir, plexignoreRules)
  );
  if (candidateEntries.length === 0) {
    return [];
  }

  const probeDb = options?.configDir ? await openScanCacheDb(options.configDir) : null;
  const cacheHitPaths = new Set<string>();
  const cachedProbeFile: ProbeFn = (filePath) =>
    probeVideoWithCache(
      probeDb,
      filePath,
      path.relative(inputDir, filePath).split(path.sep).join('/'),
      probeFile,
      '',
      (hit) => {
        if (hit) {
          cacheHitPaths.add(filePath);
        }
      }
    );

  const results = Array.from<ScannedItem | null>({ length: candidateEntries.length }).fill(null);
  const completedIndices = new Set<number>();
  const workerCount = Math.min(AUDIO_SCAN_CONCURRENCY, candidateEntries.length);
  if (options?.etaPredictor) {
    options.etaPredictor.markStagePending('volumedetect');
    options.etaPredictor.initStageInventory(
      'scan_probe',
      [
        {
          profile: 'default',
          units: candidateEntries.length,
          taskCount: candidateEntries.length
        }
      ],
      workerCount
    );
    options.etaPredictor.setActiveStage('scan_probe');
  }
  let nextIndex = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    while (nextIndex < candidateEntries.length) {
      if (shouldCancel?.()) {
        break;
      }
      const currentIdx = nextIndex;
      nextIndex += 1;
      const entry = candidateEntries[currentIdx]!;
      const probeTaskId = `scan_probe:${String(currentIdx)}`;
      options?.etaPredictor?.startTask(probeTaskId, 'scan_probe', 'default', 1);
      const item = await buildScannedItemFromEntry(
        entry,
        inputDir,
        cachedProbeFile,
        plexignoreRules,
        plexmatchByDir,
        options?.audioPreferredLanguages
      );
      if (!shouldCancel?.()) {
        if (!item || cacheHitPaths.has(item.sourcePath)) {
          options?.etaPredictor?.skipTask(probeTaskId, 'scan_probe', 'default', 1);
        } else {
          options?.etaPredictor?.completeTask(probeTaskId);
        }
        results[currentIdx] = item;
        completedIndices.add(currentIdx);
        completed += 1;
        options?.onProgress?.(completed, candidateEntries.length);
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    options?.etaPredictor?.flush();
    probeDb?.close();
  }

  const finalItems: ScannedItem[] = [];
  for (let i = 0; i < results.length; i += 1) {
    if (shouldCancel?.() && !completedIndices.has(i)) {
      continue;
    }
    const item = results[i];
    if (item) {
      finalItems.push(item);
    }
  }
  return finalItems;
}

export type AudioAnalysisFn = (
  filePath: string,
  streamOrder: number,
  durationSeconds?: number,
  onProgress?: (update: FfmpegProgressUpdate) => void,
  itemId?: ItemId
) => Promise<AudioTrackAnalysis | null>;

function resolveVolumedetectTaskMeta(item: ScannedItem): {
  readonly streamOrder: number;
  readonly profile: EtaChannelProfile;
  readonly totalUnits: number;
} | null {
  const includedTracks = item.trackSelection.audioTracks.filter((t) => t.include);
  const targetTrack = includedTracks.find((t) => t.isDefault) ?? includedTracks[0];
  if (!targetTrack) {
    return null;
  }
  const channels = item.probe.audioStreams.find(
    (s) => s.streamOrder === targetTrack.streamOrder
  )?.channels;
  return {
    streamOrder: targetTrack.streamOrder,
    profile: resolveChannelProfile(channels),
    totalUnits: Math.max(1, item.probe.durationSeconds ?? 1)
  };
}

function buildVolumedetectInventory(items: readonly ScannedItem[]): readonly EtaInventoryEntry[] {
  const unitsByProfile = new Map<EtaChannelProfile, { units: number; count: number }>();
  for (const item of items) {
    const meta = resolveVolumedetectTaskMeta(item);
    if (!meta) {
      continue;
    }
    const current = unitsByProfile.get(meta.profile) ?? { units: 0, count: 0 };
    current.units += meta.totalUnits;
    current.count += 1;
    unitsByProfile.set(meta.profile, current);
  }
  return Array.from(unitsByProfile, ([profile, data]) => ({
    profile,
    units: data.units,
    taskCount: data.count
  }));
}

async function analyzeItemAudio(
  item: ScannedItem,
  db: ScanCacheDb,
  analyzeAudio: AudioAnalysisFn,
  onItemProgress?: (fraction: number) => void,
  shouldSkipItem?: (itemId: ItemId) => boolean,
  etaPredictor?: EtaPredictor
): Promise<{
  readonly item: ScannedItem;
  readonly cacheHit: boolean;
  readonly skipped: boolean;
}> {
  const meta = resolveVolumedetectTaskMeta(item);
  const taskId = `volumedetect:${item.id}`;

  if (shouldSkipItem?.(item.id)) {
    if (meta) {
      etaPredictor?.skipTask(taskId, 'volumedetect', meta.profile, meta.totalUnits);
    }
    return { item, cacheHit: false, skipped: true };
  }
  if (!meta) {
    return { item, cacheHit: false, skipped: false };
  }

  const { streamOrder, profile, totalUnits } = meta;
  const relPosix = item.relativePath.split(path.sep).join('/');
  const statEntry = await buildFileStatCacheEntry(item.sourcePath, relPosix);

  const cached = statEntry ? db.getAudio(statEntry.key) : undefined;
  const analyses: AudioTrackAnalysis[] = cached ? [...cached] : [];

  if (cached) {
    etaPredictor?.skipTask(taskId, 'volumedetect', profile, totalUnits);
  } else {
    if (shouldSkipItem?.(item.id)) {
      etaPredictor?.skipTask(taskId, 'volumedetect', profile, totalUnits);
      return { item, cacheHit: false, skipped: true };
    }
    etaPredictor?.startTask(taskId, 'volumedetect', profile, totalUnits, {
      mediaDurationSec: totalUnits
    });
    try {
      const res = await analyzeAudio(
        item.sourcePath,
        streamOrder,
        item.probe.durationSeconds,
        (update) => {
          const trackFraction = Math.max(0, Math.min(1, update.percent / 100));
          onItemProgress?.(trackFraction);
          etaPredictor?.recordTaskProgress(
            taskId,
            trackFraction * totalUnits,
            update.speed,
            update.outTimeSec
          );
        },
        item.id
      );
      if (shouldSkipItem?.(item.id)) {
        etaPredictor?.skipTask(taskId, 'volumedetect', profile, totalUnits);
        return { item, cacheHit: false, skipped: true };
      }
      if (res) {
        analyses.push(res);
      }
    } catch {
      if (shouldSkipItem?.(item.id)) {
        etaPredictor?.skipTask(taskId, 'volumedetect', profile, totalUnits);
        return { item, cacheHit: false, skipped: true };
      }
      // Non-fatal: item remains usable without volumedetect metrics.
    }
    etaPredictor?.completeTask(taskId);
    if (statEntry && analyses.length > 0) {
      db.setAudio(statEntry.key, statEntry.meta, analyses);
    }
  }

  if (analyses.length === 0) {
    return { item, cacheHit: false, skipped: false };
  }
  return {
    item: {
      ...item,
      probe: {
        ...item.probe,
        audioAnalysis: analyses
      }
    },
    cacheHit: cached !== undefined,
    skipped: false
  };
}

/** Progress callback emitted when concurrent audio analysis starts, updates, or finishes a slot. */
export type AudioScanProgressCallback = (
  completed: number,
  total: number,
  activeTasks: readonly ActiveParallelTask[],
  overallFraction?: number,
  activeFraction?: number
) => void;

export interface AudioScanStats {
  readonly cacheHits: number;
  readonly analyzed: number;
  readonly pruned: number;
}

/**
 * Runs `volumedetect` analysis across scanned items with bounded concurrency and
 * immediate per-file SQLite caching keyed by `(relativePath, sizeBytes, mtimeMs)`.
 */
export async function enrichItemsWithAudioAnalysis(
  items: readonly ScannedItem[],
  configDir: string,
  analyzeAudio: AudioAnalysisFn,
  onProgress?: AudioScanProgressCallback,
  shouldCancel?: () => boolean,
  onStats?: (stats: AudioScanStats) => void,
  shouldSkipItem?: (itemId: ItemId) => boolean,
  etaPredictor?: EtaPredictor
): Promise<readonly ScannedItem[]> {
  if (items.length === 0) {
    return items;
  }

  const db = await openScanCacheDb(configDir);
  const results = [...items];
  const completedIndices = new Set<number>();
  const cachedIndices = new Set<number>();
  const itemBytes = items.map((item) => Math.max(1, item.probe.sizeBytes));
  const totalBytes = itemBytes.reduce((sum, bytes) => sum + bytes, 0);
  const itemFractions = items.map(() => 0);
  let completed = 0;
  let cacheHits = 0;
  let analyzed = 0;

  function computeOverallFraction(): number {
    if (totalBytes <= 0) {
      return items.length > 0 ? completed / items.length : 1;
    }
    let doneBytes = 0;
    for (let i = 0; i < itemBytes.length; i++) {
      doneBytes += (itemBytes[i] ?? 0) * (itemFractions[i] ?? 0);
    }
    return Math.max(0, Math.min(1, doneBytes / totalBytes));
  }

  function computeActiveFraction(): number {
    let activeTotal = 0;
    let activeDone = 0;
    for (let i = 0; i < itemBytes.length; i++) {
      if (cachedIndices.has(i)) {
        continue;
      }
      const bytes = itemBytes[i] ?? 0;
      activeTotal += bytes;
      activeDone += bytes * (itemFractions[i] ?? 0);
    }
    if (activeTotal <= 0) {
      return 1;
    }
    return Math.max(0, Math.min(1, activeDone / activeTotal));
  }

  const workerCount = Math.min(AUDIO_SCAN_CONCURRENCY, items.length);
  const activeBySlot = Array.from<ActiveParallelTask | undefined>({ length: workerCount });
  if (etaPredictor) {
    etaPredictor.initStageInventory('volumedetect', buildVolumedetectInventory(items), workerCount);
    etaPredictor.setActiveStage('volumedetect');
  }

  try {
    await runSlotWorkerPool(
      items,
      workerCount,
      async (item, currentIdx, slot) => {
        activeBySlot[slot] = {
          slot,
          itemId: item.id,
          fileName: item.fileName,
          percent: 0
        };
        onProgress?.(
          completed,
          items.length,
          collectActiveTasks(activeBySlot),
          computeOverallFraction(),
          computeActiveFraction()
        );
        const outcome = await analyzeItemAudio(
          item,
          db,
          analyzeAudio,
          (fraction) => {
            if (!shouldCancel?.() && !shouldSkipItem?.(item.id)) {
              itemFractions[currentIdx] = fraction;
              activeBySlot[slot] = {
                slot,
                itemId: item.id,
                fileName: item.fileName,
                percent: Math.min(PERCENT_MAX, Math.round(fraction * PERCENT_MAX))
              };
              onProgress?.(
                completed,
                items.length,
                collectActiveTasks(activeBySlot),
                computeOverallFraction(),
                computeActiveFraction()
              );
            }
          },
          shouldSkipItem,
          etaPredictor
        );
        activeBySlot[slot] = undefined;
        if (shouldCancel?.()) {
          return;
        }
        results[currentIdx] = outcome.item;
        completedIndices.add(currentIdx);
        itemFractions[currentIdx] = 1;
        if (outcome.cacheHit || outcome.skipped) {
          cachedIndices.add(currentIdx);
        }
        if (outcome.cacheHit) {
          cacheHits += 1;
        } else if (!outcome.skipped) {
          analyzed += 1;
        }
        completed += 1;
        onProgress?.(
          completed,
          items.length,
          collectActiveTasks(activeBySlot),
          computeOverallFraction(),
          computeActiveFraction()
        );
      },
      shouldCancel
    );

    if (!shouldCancel?.()) {
      const pruned = db.pruneExpired();
      onStats?.({
        cacheHits,
        analyzed,
        pruned: pruned.probeDeleted + pruned.audioDeleted
      });
    }
  } finally {
    etaPredictor?.flush();
    db.close();
  }

  if (shouldCancel?.()) {
    return results.filter((_, idx) => completedIndices.has(idx));
  }
  return results;
}
