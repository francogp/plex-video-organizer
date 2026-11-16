import { type SpawnOptions, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';

const HTTP_OK = 200;
const SEEK_PRE_BUFFER_SECONDS = 2;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const MS_PER_SECOND = 1000;
const PAD_TWO = 2;
const PAD_THREE = 3;

const TIMESTAMP_LINE_RE =
  /^(\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s*-->\s*(\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}(.*)$/;
const SINGLE_TIMESTAMP_RE = /^(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})$/;

export interface PreviewStreamOptions {
  readonly sourcePath: string;
  readonly startSeconds?: number;
  readonly audioStreamOrder?: number;
}

export interface PreviewSpawnedProcess {
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(event: 'error' | 'exit', listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type PreviewSpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => PreviewSpawnedProcess;

export interface PreviewVttResponse {
  writeHead(statusCode: number, headers: OutgoingHttpHeaders): unknown;
  end(data: string): unknown;
}

function formatFfmpegSeconds(seconds: number): string {
  return seconds.toFixed(PAD_THREE).replace(/\.?0+$/, '');
}

function parseTimestampToSeconds(raw: string): number | null {
  const match = SINGLE_TIMESTAMP_RE.exec(raw.trim());
  if (!match) {
    return null;
  }
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4]);
  return hours * SECONDS_PER_HOUR + minutes * SECONDS_PER_MINUTE + seconds + millis / MS_PER_SECOND;
}

function formatVttTimestamp(totalSeconds: number): string {
  const safeMs = Math.max(0, Math.round(totalSeconds * MS_PER_SECOND));
  const hours = Math.floor(safeMs / (SECONDS_PER_HOUR * MS_PER_SECOND));
  const remAfterHours = safeMs % (SECONDS_PER_HOUR * MS_PER_SECOND);
  const minutes = Math.floor(remAfterHours / (SECONDS_PER_MINUTE * MS_PER_SECOND));
  const remAfterMinutes = remAfterHours % (SECONDS_PER_MINUTE * MS_PER_SECOND);
  const seconds = Math.floor(remAfterMinutes / MS_PER_SECOND);
  const millis = remAfterMinutes % MS_PER_SECOND;
  return `${String(hours).padStart(PAD_TWO, '0')}:${String(minutes).padStart(PAD_TWO, '0')}:${String(seconds).padStart(PAD_TWO, '0')}.${String(millis).padStart(PAD_THREE, '0')}`;
}

/** Builds fast-seek, low-latency 720p H.264 + AAC fMP4 arguments for in-browser subtitle preview. */
function buildPreviewFfmpegArgs(options: PreviewStreamOptions): readonly string[] {
  const rawStart = options.startSeconds ?? 0;
  const startSeconds = Number.isFinite(rawStart) && rawStart > 0 ? rawStart : 0;
  const args: string[] = ['-hide_banner', '-loglevel', 'error'];

  let accurateSeek = 0;
  if (startSeconds > 0) {
    const fastSeek = Math.max(0, startSeconds - SEEK_PRE_BUFFER_SECONDS);
    accurateSeek = startSeconds - fastSeek;
    if (fastSeek > 0) {
      args.push('-ss', formatFfmpegSeconds(fastSeek));
    }
  }

  args.push('-i', options.sourcePath);
  if (accurateSeek > 0) {
    args.push('-ss', formatFfmpegSeconds(accurateSeek));
  }

  const audioMap =
    options.audioStreamOrder !== undefined && options.audioStreamOrder >= 0
      ? `0:a:${String(options.audioStreamOrder)}?`
      : '0:a:0?';

  args.push(
    '-map',
    '0:v:0',
    '-map',
    audioMap,
    '-sn',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-tune',
    'zerolatency',
    '-crf',
    '28',
    '-pix_fmt',
    'yuv420p',
    '-vf',
    'scale=-2:min(720\\,ih)',
    '-c:a',
    'aac',
    '-ac',
    '2',
    '-b:a',
    '96k',
    '-f',
    'mp4',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1'
  );

  return args;
}

function stripAssOverrideTags(text: string): string {
  return text.replace(/\{\\[^}]+\}/g, '').replace(/<\/?font[^>]*>/gi, '');
}

/** Converts an `.srt` or `.vtt` subtitle payload into WebVTT shifted by `offsetSeconds`. */
function convertSrtToVtt(srtContent: string, offsetSeconds = 0): string {
  const normalized = stripAssOverrideTags(srtContent.replace(/\r\n/g, '\n').replace(/^\uFEFF/, ''));
  const trimmed = normalized.trim();
  const safeOffset = Number.isFinite(offsetSeconds) && offsetSeconds > 0 ? offsetSeconds : 0;

  if (safeOffset === 0) {
    if (trimmed.startsWith('WEBVTT')) {
      return `${trimmed}\n`;
    }
    const withVttTimestamps = trimmed.replace(
      /(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})/g,
      '$1.$2 --> $3.$4'
    );
    return `WEBVTT\n\n${withVttTimestamps}\n`;
  }

  const blocks = trimmed.split(/\n{2,}/);
  const shiftedBlocks: string[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    const timeLineIdx = lines.findIndex((line) => TIMESTAMP_LINE_RE.test(line.trim()));
    if (timeLineIdx === -1) {
      continue;
    }

    const rawTimeLine = lines[timeLineIdx];
    if (rawTimeLine === undefined) {
      continue;
    }

    const timeLine = rawTimeLine.trim();
    const [rawStartPart, rawEndPart] = timeLine.split('-->');
    if (rawStartPart === undefined || rawEndPart === undefined) {
      continue;
    }

    const startRaw = rawStartPart.trim();
    const endAndMeta = rawEndPart.trim();
    const spaceIdx = endAndMeta.search(/\s/);
    const endRaw = spaceIdx === -1 ? endAndMeta : endAndMeta.slice(0, spaceIdx);
    const cueSettings = spaceIdx === -1 ? '' : endAndMeta.slice(spaceIdx);

    const startSec = parseTimestampToSeconds(startRaw);
    const endSec = parseTimestampToSeconds(endRaw);
    if (startSec === null || endSec === null || endSec <= safeOffset) {
      continue;
    }

    const shiftedStart = formatVttTimestamp(Math.max(0, startSec - safeOffset));
    const shiftedEnd = formatVttTimestamp(endSec - safeOffset);
    const textLines = lines.slice(timeLineIdx + 1);
    if (textLines.length === 0) {
      continue;
    }
    shiftedBlocks.push(`${shiftedStart} --> ${shiftedEnd}${cueSettings}\n${textLines.join('\n')}`);
  }

  return shiftedBlocks.length > 0 ? `WEBVTT\n\n${shiftedBlocks.join('\n\n')}\n` : 'WEBVTT\n\n';
}

let activePreviewCleanup: (() => void) | null = null;

/** Streams a real-time 720p H.264 + AAC fMP4 preview via `ffmpeg`, terminating `ffmpeg` on client abort. */
export async function streamTranscodedPreview(
  options: PreviewStreamOptions,
  res: ServerResponse,
  spawnFn: PreviewSpawnFn = spawn as PreviewSpawnFn
): Promise<void> {
  await fs.stat(options.sourcePath);
  if (activePreviewCleanup) {
    activePreviewCleanup();
    activePreviewCleanup = null;
  }

  const ffmpegBin = process.env['FFMPEG_BIN'] ?? 'ffmpeg';
  const args = buildPreviewFfmpegArgs(options);

  res.writeHead(HTTP_OK, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store'
  });

  const child = spawnFn(ffmpegBin, [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  let closed = false;
  const terminateChild = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    if (activePreviewCleanup === terminateChild) {
      activePreviewCleanup = null;
    }
    res.off('close', onResponseClose);
    try {
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill('SIGKILL');
    } catch {
      // Process may have already exited.
    }
    if (!res.writableEnded) {
      res.end();
    }
  };

  const onResponseClose = (): void => {
    if (!res.writableFinished) {
      terminateChild();
    }
  };

  activePreviewCleanup = terminateChild;
  res.on('close', onResponseClose);

  child.stderr.resume();
  child.stdout.pipe(res);

  await new Promise<void>((resolve) => {
    const finish = (): void => {
      if (activePreviewCleanup === terminateChild) {
        activePreviewCleanup = null;
      }
      res.off('close', onResponseClose);
      if (!res.writableEnded) {
        res.end();
      }
      resolve();
    };
    child.once('error', finish);
    child.once('exit', finish);
  });
}

/** Reads an external subtitle file and writes it as a UTF-8 WebVTT HTTP response. */
export async function streamSubtitlePreviewVtt(
  subPath: string,
  res: PreviewVttResponse,
  offsetSeconds = 0
): Promise<void> {
  const rawSub = await fs.readFile(subPath, 'utf8');
  const vtt = convertSrtToVtt(rawSub, offsetSeconds);
  res.writeHead(HTTP_OK, {
    'Content-Type': 'text/vtt; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(vtt);
}
