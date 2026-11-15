import path from 'node:path';

import {
  PLEX_EDITION_MAX_LENGTH,
  PLEX_MAX_SPLIT_PARTS,
  fitTvEpisodeTitleToBudget,
  sanitizePlexSegment
} from './constants.ts';
import {
  asImdbId,
  asTvdbId,
  type EpisodeInfo,
  type ImdbId,
  type TmdbId,
  type TvdbId
} from './types.ts';

const SPLIT_PART_REGEX =
  /(?:(?:[\s._]+-\s*|[\s._-])(cd|disc|disk|dvd|pt)|(?:-\s*|[._])(part))\s*([1-8])(?:\s*(?:\[[^\]]+\]|\{[^}]+\}))*\s*$/i;

export { sanitizePlexSegment };

/** Extracts a Plex split-part suffix (e.g. `pt1`, `cd2`) when present at the end, up to part 8. */
export function extractSplitPart(nameWithoutExt: string): string | undefined {
  const match = SPLIT_PART_REGEX.exec(nameWithoutExt);
  const label = match?.[1] ?? match?.[2];
  const rawNumber = match?.[3];
  if (!label || !rawNumber) {
    return undefined;
  }
  const partNum = Number(rawNumber);
  if (!Number.isInteger(partNum) || partNum < 1 || partNum > PLEX_MAX_SPLIT_PARTS) {
    return undefined;
  }
  return `${label.toLowerCase()}${String(partNum)}`;
}

/** Formats a Plex `{edition-...}` tag enforcing the 32-character limit. */
export function formatEditionTag(rawEdition?: string): string | undefined {
  if (!rawEdition) {
    return undefined;
  }
  const clean = sanitizePlexSegment(rawEdition).slice(0, PLEX_EDITION_MAX_LENGTH).trim();
  return clean.length > 0 ? `{edition-${clean}}` : undefined;
}

export interface MoviePathInput {
  readonly title: string;
  readonly year?: number;
  readonly imdbId?: ImdbId;
  readonly tmdbId?: TmdbId;
  readonly edition?: string;
  readonly tags?: readonly string[];
  readonly splitPart?: string;
}

/** Formats a title with `(year)` unless the title already ends with `(year)`. */
export function formatTitleWithYear(title: string, year?: number): string {
  const trimmed = title.trim();
  if (!year) {
    return trimmed;
  }
  const suffixRegex = new RegExp(`\\s*\\(${String(year)}\\)$`);
  return suffixRegex.test(trimmed) ? trimmed : `${trimmed} (${String(year)})`;
}

/** Builds relative Plex movie path (`Folder/File.mkv`). */
export function formatMovieRelativePath(input: MoviePathInput): string {
  const parts: string[] = [formatTitleWithYear(sanitizePlexSegment(input.title), input.year)];
  if (input.imdbId) {
    parts.push(`{imdb-${input.imdbId}}`);
  } else if (input.tmdbId) {
    parts.push(`{tmdb-${input.tmdbId}}`);
  }

  const editionTag = formatEditionTag(input.edition);
  if (editionTag) {
    parts.push(editionTag);
  }
  if (input.tags && input.tags.length > 0) {
    parts.push(`[${input.tags.join(', ')}]`);
  }

  const baseName = parts.join(' ');
  const fileName = input.splitPart ? `${baseName} - ${input.splitPart}.mkv` : `${baseName}.mkv`;
  return path.join(baseName, fileName);
}

export interface TvPathInput {
  readonly showTitle: string;
  readonly year?: number;
  readonly tvdbId?: TvdbId;
  readonly tmdbId?: TmdbId;
  readonly edition?: string;
  readonly episode: EpisodeInfo;
  readonly splitPart?: string;
}

function padTwo(value: number): string {
  return String(value).padStart(2, '0');
}

/** Builds relative Plex TV episode path (`Show/Season XX/Episode.mkv`). */
export function formatTvRelativePath(input: TvPathInput): string {
  const cleanShow = sanitizePlexSegment(input.showTitle);
  const showDisplay = formatTitleWithYear(cleanShow, input.year);

  const folderParts: string[] = [showDisplay];
  if (input.tvdbId) {
    folderParts.push(`{tvdb-${input.tvdbId}}`);
  } else if (input.tmdbId) {
    folderParts.push(`{tmdb-${input.tmdbId}}`);
  }

  const editionTag = formatEditionTag(input.edition);
  if (editionTag) {
    folderParts.push(editionTag);
  }

  const showFolder = folderParts.join(' ');
  const seasonFolder = `Season ${padTwo(input.episode.seasonNumber)}`;

  const epParts: string[] = [showDisplay];
  if (input.episode.airDate) {
    epParts.push(input.episode.airDate);
  } else {
    const startCode = `s${padTwo(input.episode.seasonNumber)}e${padTwo(input.episode.episodeStart)}`;
    const epCode =
      input.episode.episodeEnd && input.episode.episodeEnd > input.episode.episodeStart
        ? `${startCode}-e${padTwo(input.episode.episodeEnd)}`
        : startCode;
    epParts.push(epCode);
  }

  const split = input.splitPart ?? input.episode.splitPart;
  const suffixParts = split ? [split] : [];
  const baseFileName = `${[...epParts, ...suffixParts].join(' - ')}.mkv`;
  const baseRelativeLength = path.join(showFolder, seasonFolder, baseFileName).length;

  if (input.episode.episodeTitle) {
    const fittedTitle = fitTvEpisodeTitleToBudget(baseRelativeLength, input.episode.episodeTitle);
    if (fittedTitle.length > 0) {
      epParts.push(fittedTitle);
    }
  }

  if (split) {
    epParts.push(split);
  }

  const fileName = `${epParts.join(' - ')}.mkv`;
  return path.join(showFolder, seasonFolder, fileName);
}

/** Resolves a relative Plex path inside `libraryRoot`, throwing on path traversal. */
export function resolveContainedOutputPath(libraryRoot: string, relativePath: string): string {
  const resolvedRoot = path.resolve(libraryRoot);
  const resolvedTarget = path.resolve(resolvedRoot, relativePath);
  const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(rootPrefix)) {
    throw new Error(`Path traversal rejected: ${relativePath}`);
  }
  return resolvedTarget;
}

export interface ParsedProviderReference {
  readonly imdbId?: ImdbId;
  readonly tvdbId?: TvdbId;
  readonly tvmazeId?: number;
}

/** Extracts an IMDb, TVDB, or TVmaze ID from raw IDs, `{tvdb-...}` tags, or provider URLs. */
export function parseProviderReference(raw: string): ParsedProviderReference {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  const imdbMatch = /(?:imdb\.com\/title\/|\b)(tt\d+)\b/i.exec(trimmed);
  if (imdbMatch?.[1]) {
    return { imdbId: asImdbId(imdbMatch[1].toLowerCase()) };
  }
  const tvmazeMatch = /tvmaze\.com\/shows\/(\d+)/i.exec(trimmed);
  if (tvmazeMatch?.[1]) {
    const id = Number(tvmazeMatch[1]);
    if (Number.isInteger(id) && id > 0) {
      return { tvmazeId: id };
    }
  }
  const tvdbUrlMatch =
    /(?:thetvdb\.com\/(?:[^\s#]*[?&]id=|dereferrer\/series\/)(\d+))|\{tvdb-(\d+)\}/i.exec(trimmed);
  const tvdbDigits = tvdbUrlMatch?.[1] ?? tvdbUrlMatch?.[2];
  if (tvdbDigits) {
    return { tvdbId: asTvdbId(tvdbDigits) };
  }
  return {};
}
