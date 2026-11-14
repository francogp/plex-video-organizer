import { type SpawnOptions, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import path from 'node:path';

const HTTP_OK = 200;
const HTTP_PARTIAL_CONTENT = 206;

const VIDEO_MIME_TYPES = new Map<string, string>([
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mkv', 'video/x-matroska'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
  ['.avi', 'video/x-msvideo']
]);

export interface OpenPlayerResult {
  readonly launched: boolean;
  readonly fallback?: 'browser-preview';
  readonly reason?: string;
}

async function isDockerContainer(): Promise<boolean> {
  try {
    await fs.access('/.dockerenv');
    return true;
  } catch {
    return false;
  }
}

function isHeadlessLinux(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  return platform === 'linux' && !env['DISPLAY'] && !env['WAYLAND_DISPLAY'];
}

export interface SpawnedPlayerProcess {
  once(event: 'error', listener: (err: Error) => void): unknown;
  unref(): unknown;
}

export type PlayerSpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => SpawnedPlayerProcess;

export interface PreviewVttResponse {
  writeHead(statusCode: number, headers: OutgoingHttpHeaders): unknown;
  end(data: string): unknown;
}

/** Launches the OS default video player on `filePath` when running in a desktop environment. */
export async function openInOsPlayer(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  spawnFn: PlayerSpawnFn = spawn
): Promise<OpenPlayerResult> {
  if ((await isDockerContainer()) || isHeadlessLinux(platform, env)) {
    return { launched: false, fallback: 'browser-preview', reason: 'headless' };
  }

  let command: string;
  let args: readonly string[];

  if (platform === 'win32') {
    command = 'cmd.exe';
    args = ['/c', 'start', '""', filePath];
  } else if (platform === 'darwin') {
    command = 'open';
    args = [filePath];
  } else {
    command = 'xdg-open';
    args = [filePath];
  }

  return new Promise<OpenPlayerResult>((resolve) => {
    try {
      const child = spawnFn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.once('error', (err) => {
        resolve({ launched: false, reason: err.message });
      });
      child.unref();
      resolve({ launched: true });
    } catch (err) {
      resolve({ launched: false, reason: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** Converts an `.srt` subtitle payload into WebVTT (`.vtt`) for HTML5 `<track>` playback. */
function convertSrtToVtt(srtContent: string): string {
  const normalized = srtContent.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
  const trimmed = normalized.trim();
  if (trimmed.startsWith('WEBVTT')) {
    return `${trimmed}\n`;
  }
  const withVttTimestamps = trimmed.replace(
    /(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})/g,
    '$1.$2 --> $3.$4'
  );
  return `WEBVTT\n\n${withVttTimestamps}\n`;
}

/** Streams a local video file to an HTTP response with `Range` (206 Partial Content) support. */
export async function streamVideoFile(
  sourcePath: string,
  rangeHeader: string | undefined,
  res: ServerResponse
): Promise<void> {
  const stat = await fs.stat(sourcePath);
  const mimeType =
    VIDEO_MIME_TYPES.get(path.extname(sourcePath).toLowerCase()) ?? 'application/octet-stream';
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    const chunkSize = Math.max(0, end - start + 1);
    res.writeHead(HTTP_PARTIAL_CONTENT, {
      'Content-Range': `bytes ${String(start)}-${String(end)}/${String(stat.size)}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(chunkSize),
      'Content-Type': mimeType
    });
    createReadStream(sourcePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(HTTP_OK, {
    'Accept-Ranges': 'bytes',
    'Content-Length': String(stat.size),
    'Content-Type': mimeType
  });
  createReadStream(sourcePath).pipe(res);
}

/** Reads an external subtitle file and writes it as a UTF-8 WebVTT HTTP response. */
export async function streamSubtitlePreviewVtt(
  subPath: string,
  res: PreviewVttResponse
): Promise<void> {
  const rawSub = await fs.readFile(subPath, 'utf8');
  const vtt = convertSrtToVtt(rawSub);
  res.writeHead(HTTP_OK, { 'Content-Type': 'text/vtt; charset=utf-8' });
  res.end(vtt);
}
