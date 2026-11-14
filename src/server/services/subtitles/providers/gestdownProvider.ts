import { asIso639_2Code } from '../../../../domain/types.ts';
import { detectSpanishVariant } from '../subtitleScorer.ts';
import {
  fetchSubtitleOk,
  type FetchLike,
  type SubtitleRawCandidate,
  type SubtitleSearchQuery
} from './providerTypes.ts';

const GESTDOWN_BASE_URL = 'https://api.gestdown.info';

interface GestdownShowLookupResponse {
  readonly shows?: readonly { readonly id?: string; readonly name?: string }[];
}

interface GestdownSubtitlesResponse {
  readonly matchingSubtitles?: readonly {
    readonly subtitleId?: string;
    readonly version?: string;
    readonly language?: string;
    readonly downloadCount?: number;
  }[];
}

async function resolveGestdownShowId(
  query: SubtitleSearchQuery,
  fetchFn: FetchLike
): Promise<string | undefined> {
  if (query.tvdbId) {
    const res = await fetchSubtitleOk(
      fetchFn,
      `${GESTDOWN_BASE_URL}/shows/external/tvdb/${encodeURIComponent(query.tvdbId)}`
    );
    if (res) {
      const data = (await res.json()) as GestdownShowLookupResponse;
      const firstId = data.shows?.[0]?.id;
      if (firstId) {
        return firstId;
      }
    }
  }

  const searchRes = await fetchSubtitleOk(
    fetchFn,
    `${GESTDOWN_BASE_URL}/shows/search/${encodeURIComponent(query.title)}`
  );
  if (!searchRes) {
    return undefined;
  }
  const searchData = (await searchRes.json()) as GestdownShowLookupResponse;
  return searchData.shows?.[0]?.id;
}

/** Searches Spanish TV episode subtitles via the free keyless Gestdown API. */
export async function searchGestdownSubtitles(
  query: SubtitleSearchQuery,
  fetchFn: FetchLike = fetch
): Promise<readonly SubtitleRawCandidate[]> {
  if (
    query.mediaKind !== 'tv' ||
    query.seasonNumber === undefined ||
    query.episodeNumber === undefined
  ) {
    return [];
  }

  const showId = await resolveGestdownShowId(query, fetchFn);
  if (!showId) {
    return [];
  }

  const url = `${GESTDOWN_BASE_URL}/subtitles/get/${encodeURIComponent(showId)}/${String(query.seasonNumber)}/${String(query.episodeNumber)}/spa`;
  const res = await fetchSubtitleOk(fetchFn, url);
  if (!res) {
    return [];
  }

  const data = (await res.json()) as GestdownSubtitlesResponse;
  const subs = data.matchingSubtitles ?? [];
  const results: SubtitleRawCandidate[] = [];

  for (const sub of subs) {
    if (!sub.subtitleId) {
      continue;
    }
    const releaseName =
      sub.version ?? `${query.title} S${String(query.seasonNumber)}E${String(query.episodeNumber)}`;
    results.push({
      id: sub.subtitleId,
      provider: 'gestdown',
      language: asIso639_2Code('spa'),
      variant: detectSpanishVariant(`${sub.language ?? ''} ${releaseName}`),
      releaseName,
      downloadUrl: `${GESTDOWN_BASE_URL}/subtitles/download/${encodeURIComponent(sub.subtitleId)}`,
      hashMatch: false,
      downloadCount: sub.downloadCount,
      isArchive: false
    });
  }

  return results;
}
