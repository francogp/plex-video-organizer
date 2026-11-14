import { asIso639_2Code } from '../../../../domain/types.ts';
import { detectSpanishVariant } from '../subtitleScorer.ts';
import {
  createSubtitleHeaders,
  fetchSubtitleOk,
  type FetchLike,
  type SubtitleRawCandidate,
  type SubtitleSearchQuery
} from './providerTypes.ts';

const PODNAPISI_BASE_URL = 'https://www.podnapisi.net';
const MAX_PODNAPISI_RESULTS = 8;

const PODNAPISI_ITEM_REGEX =
  /<subtitle>[\s\S]*?<pid>([^<]+)<\/pid>[\s\S]*?<url>([^<]+)<\/url>[\s\S]*?<release>([^<]*)<\/release>[\s\S]*?<downloads>(\d+)<\/downloads>[\s\S]*?<\/subtitle>/gi;

function buildPodnapisiSearchParams(query: SubtitleSearchQuery): URLSearchParams {
  const params = new URLSearchParams({
    sXML: '1',
    sL: 'es',
    sK: query.title
  });
  if (query.year) {
    params.set('sY', String(query.year));
  }
  if (query.mediaKind === 'tv') {
    if (query.seasonNumber !== undefined) {
      params.set('sTS', String(query.seasonNumber));
    }
    if (query.episodeNumber !== undefined) {
      params.set('sTE', String(query.episodeNumber));
    }
  }
  return params;
}

/** Searches Spanish subtitles via the free keyless Podnapisi XML endpoint. */
export async function searchPodnapisiSubtitles(
  query: SubtitleSearchQuery,
  fetchFn: FetchLike = fetch
): Promise<readonly SubtitleRawCandidate[]> {
  if (!query.title) {
    return [];
  }

  const params = buildPodnapisiSearchParams(query);
  const response = await fetchSubtitleOk(
    fetchFn,
    `${PODNAPISI_BASE_URL}/subtitles/search/old?${params.toString()}`,
    { headers: createSubtitleHeaders('application/xml') }
  );
  if (!response) {
    return [];
  }

  const xml = await response.text();
  const results: SubtitleRawCandidate[] = [];
  PODNAPISI_ITEM_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null = PODNAPISI_ITEM_REGEX.exec(xml);
  while (match && results.length < MAX_PODNAPISI_RESULTS) {
    const pid = match[1]?.trim();
    const rawUrl = match[2]?.trim();
    const releaseName = match[3]?.trim() || query.title;
    const downloads = Number(match[4] ?? 0);
    if (pid && rawUrl) {
      const normalizedUrl = rawUrl.startsWith('http') ? rawUrl : `${PODNAPISI_BASE_URL}${rawUrl}`;
      const downloadUrl = normalizedUrl.endsWith('/download')
        ? normalizedUrl
        : `${normalizedUrl.replace(/\/$/, '')}/download`;
      results.push({
        id: `podnapisi-${pid}`,
        provider: 'podnapisi',
        language: asIso639_2Code('spa'),
        variant: detectSpanishVariant(releaseName),
        releaseName,
        downloadUrl,
        hashMatch: false,
        downloadCount: Number.isFinite(downloads) ? downloads : undefined,
        isArchive: true
      });
    }
    match = PODNAPISI_ITEM_REGEX.exec(xml);
  }

  return results;
}
