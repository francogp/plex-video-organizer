import { asIso639_2Code } from '../../../../domain/types.ts';
import { detectSpanishVariant } from '../subtitleScorer.ts';
import {
  fetchSubtitleOk,
  type FetchLike,
  type SubtitleRawCandidate,
  type SubtitleSearchQuery
} from './providerTypes.ts';

const STREMIO_OS_BASE_URL = 'https://opensubtitles-v3.strem.io/subtitles';
const SPANISH_LANG_CODES = new Set([
  'spa',
  'es',
  'es-419',
  'es-es',
  'spl',
  'spn',
  'lat',
  'spanish'
]);

interface StremioSubtitleEntry {
  readonly id?: string;
  readonly url?: string;
  readonly lang?: string;
  readonly SubFileName?: string;
  readonly SubDownloadsCnt?: string | number;
  readonly MatchedBy?: string;
  readonly m?: string;
  readonly g?: string;
}

interface StremioSubtitleResponse {
  readonly subtitles?: readonly StremioSubtitleEntry[];
}

function isSpanishLang(lang?: string): boolean {
  if (!lang) {
    return false;
  }
  const normalized = lang.trim().toLowerCase();
  return SPANISH_LANG_CODES.has(normalized) || normalized.startsWith('spanish');
}

/** Searches Spanish subtitles via the public keyless OpenSubtitles Stremio v3 endpoint. */
export async function searchOpenSubtitlesStremio(
  query: SubtitleSearchQuery,
  fetchFn: FetchLike = fetch
): Promise<readonly SubtitleRawCandidate[]> {
  if (!query.imdbId) {
    return [];
  }

  const mediaType = query.mediaKind === 'tv' ? 'series' : 'movie';
  const mediaId =
    query.mediaKind === 'tv' &&
    query.seasonNumber !== undefined &&
    query.episodeNumber !== undefined
      ? `${query.imdbId}:${String(query.seasonNumber)}:${String(query.episodeNumber)}`
      : query.imdbId;

  const extraParts: string[] = [];
  if (query.videoHash) {
    extraParts.push(`videoHash=${encodeURIComponent(query.videoHash)}`);
  }
  if (query.videoSize && query.videoSize > 0) {
    extraParts.push(`videoSize=${String(query.videoSize)}`);
  }

  const extraSuffix = extraParts.length > 0 ? `/${extraParts.join('&')}` : '';
  const url = `${STREMIO_OS_BASE_URL}/${mediaType}/${encodeURIComponent(mediaId)}${extraSuffix}.json`;

  const response = await fetchSubtitleOk(fetchFn, url);
  if (!response) {
    return [];
  }

  const payload = (await response.json()) as StremioSubtitleResponse;
  const entries = payload.subtitles ?? [];
  const results: SubtitleRawCandidate[] = [];

  for (const entry of entries) {
    if (!entry.url || !isSpanishLang(entry.lang)) {
      continue;
    }
    const releaseName = entry.SubFileName ?? query.title;
    const hashMatch =
      entry.MatchedBy === 'moviehash' ||
      entry.m === 'h' ||
      (Boolean(query.videoHash) && entry.url.includes(query.videoHash ?? ''));
    const downloads =
      typeof entry.SubDownloadsCnt === 'number'
        ? entry.SubDownloadsCnt
        : Number(entry.SubDownloadsCnt ?? 0);

    results.push({
      id: entry.id ?? entry.url,
      provider: 'opensubtitles-stremio',
      language: asIso639_2Code('spa'),
      variant: detectSpanishVariant(`${entry.lang ?? ''} ${releaseName}`),
      releaseName,
      downloadUrl: entry.url,
      hashMatch,
      downloadCount: Number.isFinite(downloads) && downloads > 0 ? downloads : undefined,
      isArchive: entry.url.toLowerCase().endsWith('.zip')
    });
  }

  return results;
}
