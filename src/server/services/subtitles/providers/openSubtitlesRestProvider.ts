import { asIso639_2Code } from '../../../../domain/types.ts';
import { detectSpanishVariant } from '../subtitleScorer.ts';
import {
  SUBTITLE_REQUEST_TIMEOUT_MS,
  applyMediaTypeAndEpisodeParams,
  createSubtitleHeaders,
  fetchSubtitleOk,
  type FetchLike,
  type SubtitleRawCandidate,
  type SubtitleSearchQuery
} from './providerTypes.ts';

const OS_API_BASE_URL = 'https://api.opensubtitles.com/api/v1';
const OS_USER_AGENT = 'plex-video-organizer v1.0';
const HTTP_UNAUTHORIZED = 401;

interface CachedAuthSession {
  readonly token: string;
  readonly baseUrl?: string;
}

const authSessionCache = new Map<string, CachedAuthSession>();

export interface OpenSubtitlesCredentials {
  readonly username?: string;
  readonly password?: string;
}

interface OpenSubtitlesLoginResponse {
  readonly token?: string;
  readonly base_url?: string;
}

interface OpenSubtitlesApiItem {
  readonly id?: string;
  readonly attributes?: {
    readonly language?: string;
    readonly release?: string;
    readonly download_count?: number;
    readonly moviehash_match?: boolean;
    readonly files?: readonly { readonly file_id?: number; readonly file_name?: string }[];
  };
}

interface OpenSubtitlesApiResponse {
  readonly data?: readonly OpenSubtitlesApiItem[];
}

interface OpenSubtitlesDownloadResponse {
  readonly link?: string;
}

/** Searches Spanish subtitles via the official OpenSubtitles REST v1 API when an API key is set. */
export async function searchOpenSubtitlesRest(
  query: SubtitleSearchQuery,
  apiKey: string | undefined,
  fetchFn: FetchLike = fetch
): Promise<readonly SubtitleRawCandidate[]> {
  if (!apiKey) {
    return [];
  }

  const params = new URLSearchParams({ languages: 'es,ea' });
  if (query.videoHash) {
    params.set('moviehash', query.videoHash);
  }
  if (query.imdbId) {
    params.set('imdb_id', query.imdbId.replace(/^tt/i, ''));
  } else if (query.title) {
    params.set('query', query.title);
  }
  applyMediaTypeAndEpisodeParams(params, query, 'episode');

  const searchHeaders = createOpenSubtitlesHeaders(apiKey);
  const response = await fetchSubtitleOk(
    fetchFn,
    `${OS_API_BASE_URL}/subtitles?${params.toString()}`,
    { headers: searchHeaders }
  );
  if (!response) {
    return [];
  }

  const payload = (await response.json()) as OpenSubtitlesApiResponse;
  const results: SubtitleRawCandidate[] = [];

  for (const item of payload.data ?? []) {
    const attrs = item.attributes;
    const firstFile = attrs?.files?.[0];
    if (!attrs || !firstFile?.file_id) {
      continue;
    }
    const releaseName = attrs.release ?? firstFile.file_name ?? query.title;
    const langHint = attrs.language === 'ea' ? 'latam' : (attrs.language ?? '');
    results.push({
      id: item.id ?? String(firstFile.file_id),
      provider: 'opensubtitles-rest',
      language: asIso639_2Code('spa'),
      variant: detectSpanishVariant(`${langHint} ${releaseName}`),
      releaseName,
      downloadUrl: `${OS_API_BASE_URL}/download?file_id=${String(firstFile.file_id)}`,
      remoteFileId: firstFile.file_id,
      hashMatch: Boolean(attrs.moviehash_match),
      downloadCount: attrs.download_count,
      isArchive: false
    });
  }

  return results;
}

function createOpenSubtitlesHeaders(apiKey: string, includeContentType = false): Headers {
  const headers = createSubtitleHeaders('application/json', OS_USER_AGENT);
  headers.set('Api-Key', apiKey);
  if (includeContentType) {
    headers.set('Content-Type', 'application/json');
  }
  return headers;
}

async function getOrCreateAuthSession(
  apiKey: string,
  credentials: OpenSubtitlesCredentials | undefined,
  fetchFn: FetchLike,
  forceRefresh = false
): Promise<CachedAuthSession | null> {
  if (!credentials?.username || !credentials.password) {
    return null;
  }
  const cacheKey = `${apiKey}:${credentials.username}`;
  if (!forceRefresh) {
    const cached = authSessionCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  } else {
    authSessionCache.delete(cacheKey);
  }

  const loginHeaders = createOpenSubtitlesHeaders(apiKey, true);
  const response = await fetchSubtitleOk(fetchFn, `${OS_API_BASE_URL}/login`, {
    method: 'POST',
    headers: loginHeaders,
    body: JSON.stringify({
      username: credentials.username,
      password: credentials.password
    })
  });
  if (!response) {
    return null;
  }
  const payload = (await response.json()) as OpenSubtitlesLoginResponse;
  if (!payload.token) {
    return null;
  }
  const session: CachedAuthSession = {
    token: payload.token,
    baseUrl: payload.base_url?.trim() || undefined
  };
  authSessionCache.set(cacheKey, session);
  return session;
}

async function postDownloadRequest(
  apiKey: string,
  fileId: number,
  session: CachedAuthSession | null,
  fetchFn: FetchLike
): Promise<Response> {
  const baseUrl = session?.baseUrl ? `https://${session.baseUrl}/api/v1` : OS_API_BASE_URL;
  const headers = createOpenSubtitlesHeaders(apiKey, true);
  if (session?.token) {
    headers.set('Authorization', `Bearer ${session.token}`);
  }
  return await fetchFn(`${baseUrl}/download`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ file_id: fileId }),
    signal: AbortSignal.timeout(SUBTITLE_REQUEST_TIMEOUT_MS)
  });
}

/** Resolves a temporary download URL from an OpenSubtitles REST `remoteFileId` when present. */
export async function resolveOpenSubtitlesRestDownloadUrl(
  downloadUrl: string,
  apiKey: string | undefined,
  fetchFn: FetchLike = fetch,
  credentials?: OpenSubtitlesCredentials,
  remoteFileId?: number
): Promise<string | null> {
  if (remoteFileId === undefined) {
    return downloadUrl;
  }
  if (!apiKey) {
    return null;
  }
  if (!Number.isInteger(remoteFileId) || remoteFileId <= 0) {
    return null;
  }

  let session = await getOrCreateAuthSession(apiKey, credentials, fetchFn);
  let response = await postDownloadRequest(apiKey, remoteFileId, session, fetchFn);
  if (response.status === HTTP_UNAUTHORIZED && session) {
    session = await getOrCreateAuthSession(apiKey, credentials, fetchFn, true);
    if (session) {
      response = await postDownloadRequest(apiKey, remoteFileId, session, fetchFn);
    }
  }
  if (!response.ok) {
    return null;
  }
  const payload = (await response.json()) as OpenSubtitlesDownloadResponse;
  return payload.link ?? null;
}
