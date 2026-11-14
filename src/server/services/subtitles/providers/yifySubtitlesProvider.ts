import { asIso639_2Code } from '../../../../domain/types.ts';
import { detectSpanishVariant } from '../subtitleScorer.ts';
import {
  createSubtitleHeaders,
  fetchSubtitleOk,
  type FetchLike,
  type SubtitleRawCandidate,
  type SubtitleSearchQuery
} from './providerTypes.ts';

const YIFY_SUBS_BASE_URL = 'https://yts-subs.com';
const MAX_YIFY_RESULTS = 8;

const YIFY_ROW_REGEX =
  /<tr[^>]*data-id="(\d+)"[^>]*>[\s\S]*?<span class="sub-lang">([^<]+)<\/span>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

/** Searches Spanish movie subtitles via the free keyless YIFY Subtitles HTML endpoint. */
export async function searchYifySubtitles(
  query: SubtitleSearchQuery,
  fetchFn: FetchLike = fetch
): Promise<readonly SubtitleRawCandidate[]> {
  if (query.mediaKind !== 'movie' || !query.imdbId) {
    return [];
  }

  const response = await fetchSubtitleOk(
    fetchFn,
    `${YIFY_SUBS_BASE_URL}/movie-imdb/${encodeURIComponent(query.imdbId)}`,
    { headers: createSubtitleHeaders('text/html') }
  );
  if (!response) {
    return [];
  }

  const html = await response.text();
  const results: SubtitleRawCandidate[] = [];
  YIFY_ROW_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null = YIFY_ROW_REGEX.exec(html);
  while (match && results.length < MAX_YIFY_RESULTS) {
    const matchedId = match[1];
    const lang = (match[2] ?? '').trim().toLowerCase();
    const href = match[3] ?? '';
    const rawText = (match[4] ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (matchedId && lang.includes('spanish') && href) {
      const normalizedPath = href.replace(/^\/subtitles\//, '/subtitle/');
      const zipUrl = href.startsWith('http')
        ? href
        : `${YIFY_SUBS_BASE_URL}${normalizedPath.endsWith('.zip') ? normalizedPath : `${normalizedPath}.zip`}`;
      results.push({
        id: matchedId,
        provider: 'yify',
        language: asIso639_2Code('spa'),
        variant: detectSpanishVariant(rawText),
        releaseName: rawText || query.title,
        downloadUrl: zipUrl,
        hashMatch: false,
        isArchive: true
      });
    }
    match = YIFY_ROW_REGEX.exec(html);
  }

  return results;
}
