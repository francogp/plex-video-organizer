import type { MediaKind, SubtitleCandidate } from '../../../../domain/types.ts';

export interface SubtitleSearchQuery {
  readonly mediaKind: MediaKind;
  readonly title: string;
  readonly year?: number;
  readonly imdbId?: string;
  readonly tvdbId?: string;
  readonly seasonNumber?: number;
  readonly episodeNumber?: number;
  readonly videoHash?: string;
  readonly videoSize?: number;
  readonly sourceFileName: string;
}

export type FetchLike = typeof fetch;

export type SubtitleRawCandidate = Omit<SubtitleCandidate, 'score'>;

const SUBTITLE_USER_AGENT = 'plex-video-organizer/1.0';
export const SUBTITLE_REQUEST_TIMEOUT_MS = 10_000;

/** Builds a Web `Headers` object for subtitle provider HTTP calls. */
export function createSubtitleHeaders(
  accept = 'application/json',
  userAgent = SUBTITLE_USER_AGENT
): Headers {
  return new Headers({
    Accept: accept,
    'User-Agent': userAgent
  });
}

/** Fetches `url` with default subtitle headers and timeout, returning `null` on non-2xx responses. */
export async function fetchSubtitleOk(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit = {}
): Promise<Response | null> {
  const response = await fetchFn(url, {
    ...init,
    headers: init.headers ?? createSubtitleHeaders(),
    signal: init.signal ?? AbortSignal.timeout(SUBTITLE_REQUEST_TIMEOUT_MS)
  });
  return response.ok ? response : null;
}

/** Applies `type`, `season_number`, and `episode_number` URL params for movie/TV subtitle APIs. */
export function applyMediaTypeAndEpisodeParams(
  params: URLSearchParams,
  query: SubtitleSearchQuery,
  tvTypeValue: string
): void {
  if (query.mediaKind === 'tv') {
    params.set('type', tvTypeValue);
    if (query.seasonNumber !== undefined) {
      params.set('season_number', String(query.seasonNumber));
    }
    if (query.episodeNumber !== undefined) {
      params.set('episode_number', String(query.episodeNumber));
    }
    return;
  }
  params.set('type', 'movie');
}
