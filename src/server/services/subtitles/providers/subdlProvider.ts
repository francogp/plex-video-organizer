import { asIso639_2Code } from '../../../../domain/types.ts';
import { detectSpanishVariant } from '../subtitleScorer.ts';
import {
  applyMediaTypeAndEpisodeParams,
  fetchSubtitleOk,
  type FetchLike,
  type SubtitleRawCandidate,
  type SubtitleSearchQuery
} from './providerTypes.ts';

const SUBDL_API_BASE_URL = 'https://api.subdl.com/api/v1/subtitles';
const SUBDL_DOWNLOAD_BASE_URL = 'https://dl.subdl.com';

interface SubdlEntry {
  readonly sd_id?: number;
  readonly release_name?: string;
  readonly name?: string;
  readonly lang?: string;
  readonly url?: string;
}

interface SubdlResponse {
  readonly status?: boolean;
  readonly subtitles?: readonly SubdlEntry[];
}

/** Searches Spanish subtitles via SubDL API when `SUBDL_API_KEY` is configured. */
export async function searchSubdlSubtitles(
  query: SubtitleSearchQuery,
  apiKey: string | undefined,
  fetchFn: FetchLike = fetch
): Promise<readonly SubtitleRawCandidate[]> {
  if (!apiKey) {
    return [];
  }

  const params = new URLSearchParams({
    api_key: apiKey,
    languages: 'ES',
    subs_per_page: '10'
  });
  if (query.imdbId) {
    params.set('imdb_id', query.imdbId);
  } else {
    params.set('film_name', query.title);
    if (query.year) {
      params.set('year', String(query.year));
    }
  }
  applyMediaTypeAndEpisodeParams(params, query, 'tv');

  const response = await fetchSubtitleOk(fetchFn, `${SUBDL_API_BASE_URL}?${params.toString()}`);
  if (!response) {
    return [];
  }

  const payload = (await response.json()) as SubdlResponse;
  if (!payload.status || !Array.isArray(payload.subtitles)) {
    return [];
  }

  const results: SubtitleRawCandidate[] = [];
  for (const sub of payload.subtitles) {
    if (!sub.url) {
      continue;
    }
    const releaseName = sub.release_name ?? sub.name ?? query.title;
    const downloadUrl = sub.url.startsWith('http')
      ? sub.url
      : `${SUBDL_DOWNLOAD_BASE_URL}${sub.url}`;
    results.push({
      id: sub.sd_id ? String(sub.sd_id) : downloadUrl,
      provider: 'subdl',
      language: asIso639_2Code('spa'),
      variant: detectSpanishVariant(`${sub.lang ?? ''} ${releaseName}`),
      releaseName,
      downloadUrl,
      hashMatch: false,
      isArchive: true
    });
  }

  return results;
}
