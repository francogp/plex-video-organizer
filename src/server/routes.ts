import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

import {
  asClientId,
  asItemId,
  asVerifierEntryId,
  type ClientId,
  type ConflictDecision,
  type EpisodeOrderMode,
  type ItemId,
  type ItemPatch,
  type MediaKind,
  type SubtitleCandidate,
  type VerifierEntryId
} from '../domain/types.ts';
import {
  InvalidPreferencesError,
  JobRunner,
  LockConflictError,
  ServerInitializingError
} from './services/jobRunner.ts';
import { MetadataProviderError } from './services/metadata/baseMetadataProvider.ts';
import {
  streamSubtitlePreviewVtt,
  streamTranscodedPreview
} from './services/subtitles/playerPreview.ts';

const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_INTERNAL_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;
const MAX_JSON_BODY_BYTES = 1024 * 1024;

const MIME_TYPES = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon']
]);

function parseVerifierConflictResolutions(
  raw: unknown
): Partial<Record<VerifierEntryId, ConflictDecision>> {
  const result: Partial<Record<VerifierEntryId, ConflictDecision>> = {};
  if (!raw || typeof raw !== 'object') {
    return result;
  }
  for (const [rawId, decision] of Object.entries(raw)) {
    if (decision === 'overwrite' || decision === 'ignore') {
      result[asVerifierEntryId(rawId)] = decision;
    }
  }
  return result;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_JSON_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return (raw ? JSON.parse(raw) : {}) as T;
}

function requireClientId(req: IncomingMessage): ClientId {
  const raw = req.headers['x-client-id'];
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (!val || !val.includes(':')) {
    throw new Error('Missing or invalid X-Client-Id header');
  }
  return asClientId(val);
}

async function serveStaticDist(
  distDir: string,
  reqPath: string,
  res: ServerResponse
): Promise<void> {
  const cleanPath = reqPath === '/' ? '/index.html' : reqPath;
  const resolvedRoot = path.resolve(distDir);
  let target = path.resolve(resolvedRoot, `.${cleanPath}`);
  if (!target.startsWith(`${resolvedRoot}${path.sep}`) && target !== resolvedRoot) {
    sendJson(res, HTTP_NOT_FOUND, { error: 'Not found' });
    return;
  }
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      target = path.join(target, 'index.html');
    }
    const content = await fs.readFile(target);
    const ext = path.extname(target).toLowerCase();
    res.writeHead(HTTP_OK, {
      'Content-Type': MIME_TYPES.get(ext) ?? 'application/octet-stream'
    });
    res.end(content);
  } catch {
    try {
      const indexHtml = await fs.readFile(path.join(resolvedRoot, 'index.html'));
      res.writeHead(HTTP_OK, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(indexHtml);
    } catch {
      sendJson(res, HTTP_NOT_FOUND, { error: 'Not found' });
    }
  }
}

function matchQueueItemRoute(pathname: string, suffix: string): ItemId | null {
  const prefix = '/api/queue/items/';
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const rest = pathname.slice(prefix.length);
  if (!rest.endsWith(suffix)) {
    return null;
  }
  const rawId = rest.slice(0, -suffix.length);
  return rawId.length > 0 ? asItemId(rawId) : null;
}

function readPositiveQuerySeconds(url: URL, key: string): number {
  const raw = Number(url.searchParams.get(key) ?? '0');
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

async function handleQueueItemRoutes(
  runner: JobRunner,
  method: string,
  pathname: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  if (method === 'POST') {
    const searchItemId = matchQueueItemRoute(pathname, '/subtitles/search');
    if (searchItemId) {
      requireClientId(req);
      const candidates = await runner.searchItemSubtitles(searchItemId);
      sendJson(res, HTTP_OK, { candidates });
      return true;
    }
    const downloadItemId = matchQueueItemRoute(pathname, '/subtitles/download');
    if (downloadItemId) {
      const clientId = requireClientId(req);
      const body = await readJsonBody<{
        readonly revision: number;
        readonly candidate?: SubtitleCandidate;
      }>(req);
      const result = await runner.downloadItemSubtitle(
        clientId,
        body.revision,
        downloadItemId,
        body.candidate
      );
      sendJson(res, HTTP_OK, result);
      return true;
    }
  }

  if (method === 'GET') {
    const vttItemId = matchQueueItemRoute(pathname, '/subtitles/preview.vtt');
    if (vttItemId) {
      const subPath = await runner.getItemPreviewSubtitlePath(vttItemId);
      if (!subPath) {
        sendJson(res, HTTP_NOT_FOUND, {
          code: 'SUBTITLE_NOT_FOUND',
          message: 'No external subtitle found for item.'
        });
        return true;
      }
      await streamSubtitlePreviewVtt(subPath, res, readPositiveQuerySeconds(url, 'offset'));
      return true;
    }
    const streamItemId = matchQueueItemRoute(pathname, '/stream');
    if (streamItemId) {
      const streamInfo = await runner.getItemPreviewStreamInfo(streamItemId);
      await streamTranscodedPreview(
        { ...streamInfo, startSeconds: readPositiveQuerySeconds(url, 't') },
        res
      );
      return true;
    }
  }

  return false;
}

async function handleWorkflowAndVerifierRoutes(
  runner: JobRunner,
  method: string,
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  if (method !== 'POST') {
    return false;
  }

  if (pathname === '/api/metadata/search') {
    const clientId = requireClientId(req);
    const body = await readJsonBody<{
      readonly query: string;
      readonly year?: number;
      readonly kind: MediaKind;
      readonly imdbId?: string;
      readonly tvdbId?: string;
      readonly episodeOrder?: EpisodeOrderMode;
    }>(req);
    const candidates = await runner.searchMetadata(clientId, body);
    sendJson(res, HTTP_OK, { candidates });
    return true;
  }

  if (pathname === '/api/conflict-resolutions') {
    const clientId = requireClientId(req);
    const body = await readJsonBody<{
      readonly revision: number;
      readonly conflictResolutions?: Partial<Record<ItemId, ConflictDecision>>;
    }>(req);
    const state = await runner.updateConflictResolutions(
      clientId,
      body.revision,
      body.conflictResolutions ?? {}
    );
    sendJson(res, HTTP_OK, state);
    return true;
  }

  if (pathname === '/api/preflight') {
    const clientId = requireClientId(req);
    const body = await readJsonBody<{ readonly revision: number }>(req);
    const report = await runner.preflight(clientId, body.revision);
    sendJson(res, HTTP_OK, report);
    return true;
  }

  if (pathname === '/api/jobs/start') {
    const clientId = requireClientId(req);
    const body = await readJsonBody<{
      readonly revision: number;
      readonly conflictResolutions: Partial<Record<ItemId, ConflictDecision>>;
    }>(req);
    const result = await runner.startJob(clientId, body.revision, body.conflictResolutions ?? {});
    sendJson(res, HTTP_ACCEPTED, result);
    return true;
  }

  if (pathname === '/api/jobs/unlock') {
    const clientId = requireClientId(req);
    const body = await readJsonBody<{ readonly force?: boolean }>(req);
    const state = await runner.unlock(clientId, Boolean(body.force));
    sendJson(res, HTTP_OK, state);
    return true;
  }

  if (pathname === '/api/logs/clear') {
    const state = runner.clearLogs();
    sendJson(res, HTTP_OK, state);
    return true;
  }

  if (pathname === '/api/preferences') {
    const body = await readJsonBody<{
      readonly preferredLanguages?: unknown;
      readonly audioPreferredLanguages?: unknown;
    }>(req);
    try {
      const state = await runner.updatePreferences(body);
      sendJson(res, HTTP_OK, state);
    } catch (err) {
      if (err instanceof InvalidPreferencesError) {
        sendJson(res, HTTP_BAD_REQUEST, {
          code: 'INVALID_PREFERENCES',
          message: err instanceof Error ? err.message : String(err)
        });
        return true;
      }
      throw err;
    }
    return true;
  }

  if (pathname === '/api/verifier/scan') {
    const clientId = requireClientId(req);
    const body = await readJsonBody<{ readonly recalculateTags?: boolean }>(req).catch(
      (): { readonly recalculateTags?: boolean } => ({})
    );
    const revision = runner.startVerifierScan(clientId, Boolean(body.recalculateTags));
    sendJson(res, HTTP_ACCEPTED, { revision });
    return true;
  }

  if (pathname === '/api/verifier/fix') {
    const clientId = requireClientId(req);
    const body = await readJsonBody<{
      readonly entryIds: readonly string[];
      readonly conflictResolutions?: Readonly<Partial<Record<VerifierEntryId, ConflictDecision>>>;
    }>(req);
    if (!Array.isArray(body.entryIds) || body.entryIds.length === 0) {
      sendJson(res, HTTP_BAD_REQUEST, {
        code: 'INVALID_VERIFIER_FIX',
        message: 'entryIds must be a non-empty array.'
      });
      return true;
    }
    const revision = runner.startVerifierFix(
      clientId,
      body.entryIds.map((id) => asVerifierEntryId(id)),
      parseVerifierConflictResolutions(body.conflictResolutions)
    );
    sendJson(res, HTTP_ACCEPTED, { revision });
    return true;
  }

  return false;
}

function handleRouteError(runner: JobRunner, res: ServerResponse, err: unknown): void {
  if (err instanceof ServerInitializingError) {
    sendJson(res, HTTP_CONFLICT, {
      error: 'SERVER_INITIALIZING',
      message: err.message,
      state: runner.getState()
    });
    return;
  }
  if (err instanceof LockConflictError) {
    sendJson(res, HTTP_CONFLICT, {
      error: err.code,
      message: err.message,
      state: runner.getState()
    });
    return;
  }
  if (err instanceof MetadataProviderError) {
    const status = err.kind === 'rate_limited' ? HTTP_TOO_MANY_REQUESTS : HTTP_BAD_GATEWAY;
    sendJson(res, status, {
      error: err.message,
      code: err.kind,
      provider: err.provider
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  const status =
    message.includes('X-Client-Id') || message.includes('Unresolved conflict')
      ? HTTP_BAD_REQUEST
      : HTTP_INTERNAL_ERROR;
  sendJson(res, status, { error: message });
}

/** Creates the native Node.js HTTP request handler for `/api/*`, SSE `/api/events`, and static `dist/`. */
export function createRequestHandler(runner: JobRunner, distDir: string) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    try {
      if (method === 'GET' && pathname === '/api/state') {
        sendJson(res, HTTP_OK, runner.getState());
        return;
      }

      if (method === 'GET' && pathname === '/api/events') {
        res.writeHead(HTTP_OK, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        const unsubscribe = runner.subscribe({
          send(event, data): void {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          }
        });
        req.on('close', unsubscribe);
        return;
      }

      if (method === 'POST' && pathname === '/api/scan') {
        const clientId = requireClientId(req);
        const revision = runner.startScan(clientId);
        sendJson(res, HTTP_ACCEPTED, { revision });
        return;
      }

      if (method === 'POST' && pathname === '/api/scan/skip') {
        const clientId = requireClientId(req);
        const body = await readJsonBody<{ readonly itemId?: string }>(req);
        if (typeof body.itemId !== 'string' || body.itemId.trim().length === 0) {
          sendJson(res, HTTP_BAD_REQUEST, {
            code: 'INVALID_SKIP_ITEM',
            message: 'itemId must be a non-empty string.'
          });
          return;
        }
        const skipped = runner.skipScanItem(clientId, asItemId(body.itemId));
        sendJson(res, HTTP_OK, { skipped });
        return;
      }

      if (method === 'PATCH' && pathname === '/api/queue/items/bulk') {
        const clientId = requireClientId(req);
        const body = await readJsonBody<{
          readonly revision: number;
          readonly itemIds: readonly string[];
          readonly patch: ItemPatch;
        }>(req);
        if (!Array.isArray(body.itemIds) || body.itemIds.length === 0) {
          sendJson(res, HTTP_BAD_REQUEST, {
            code: 'INVALID_BULK_PATCH',
            message: 'itemIds must be a non-empty array.'
          });
          return;
        }
        const state = await runner.patchItemsBulk(
          clientId,
          body.revision,
          body.itemIds.map((id) => asItemId(id)),
          body.patch
        );
        sendJson(res, HTTP_OK, state);
        return;
      }

      if (method === 'PATCH' && pathname.startsWith('/api/queue/items/')) {
        const clientId = requireClientId(req);
        const rawId = pathname.slice('/api/queue/items/'.length);
        const body = await readJsonBody<{ readonly revision: number; readonly patch: ItemPatch }>(
          req
        );
        const state = await runner.patchItem(clientId, body.revision, asItemId(rawId), body.patch);
        sendJson(res, HTTP_OK, state);
        return;
      }

      if (await handleQueueItemRoutes(runner, method, pathname, url, req, res)) {
        return;
      }

      if (await handleWorkflowAndVerifierRoutes(runner, method, pathname, req, res)) {
        return;
      }

      if (pathname.startsWith('/api/')) {
        sendJson(res, HTTP_NOT_FOUND, { error: 'Unknown API endpoint' });
        return;
      }

      await serveStaticDist(distDir, pathname, res);
    } catch (err) {
      handleRouteError(runner, res, err);
    }
  };
}
