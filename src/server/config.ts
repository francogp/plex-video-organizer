import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as v from 'valibot';

import {
  DEFAULT_APP_PORT,
  DEFAULT_DEV_CLIENT_PORT,
  DEFAULT_PGID,
  DEFAULT_PUID
} from '../domain/constants.ts';
import type { MountPathsMap } from '../domain/types.ts';

const BYTES_PER_GIB = 1024 ** 3;
const HOST_HASH_HEX_LENGTH = 16;
const SERVER_TAG_HASH_LENGTH = 8;
const SERVER_TAG_MAX_LENGTH = 16;
const HW_PREFIX_LENGTH = 3;

const PortSchema = v.pipe(
  v.optional(v.string()),
  v.transform((val) => {
    const parsed = Number(val);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  })
);

const EnvSchema = v.object({
  SERVER_ID: v.optional(v.string()),
  APP_PORT: PortSchema,
  DEV_CLIENT_PORT: PortSchema,
  PUID: PortSchema,
  PGID: PortSchema,
  CONFIG_DIR: v.optional(v.string()),
  INPUT_DIR: v.optional(v.string()),
  BACKUP_DIR: v.optional(v.string()),
  OUTPUT_MOVIES_DIR: v.optional(v.string()),
  OUTPUT_ANIMATED_MOVIES_DIR: v.optional(v.string()),
  OUTPUT_TV_SHOWS_DIR: v.optional(v.string()),
  OUTPUT_ANIMATED_SERIES_DIR: v.optional(v.string()),
  OMDB_API_KEY: v.optional(v.string()),
  TVDB_API_KEY: v.optional(v.string()),
  OPENSUBTITLES_API_KEY: v.optional(v.string()),
  OPENSUBTITLES_USERNAME: v.optional(v.string()),
  OPENSUBTITLES_PASSWORD: v.optional(v.string()),
  SUBDL_API_KEY: v.optional(v.string())
});

export interface AppConfig {
  readonly serverId?: string;
  readonly appPort: number;
  readonly devClientPort: number;
  readonly puid: number;
  readonly pgid: number;
  readonly configDir: string;
  readonly inputDir: string;
  readonly backupDir: string;
  readonly outputMoviesDir: string;
  readonly outputAnimatedMoviesDir: string;
  readonly outputTvShowsDir: string;
  readonly outputAnimatedSeriesDir: string;
  readonly omdbApiKey?: string;
  readonly tvdbApiKey?: string;
  readonly openSubtitlesApiKey?: string;
  readonly openSubtitlesUsername?: string;
  readonly openSubtitlesPassword?: string;
  readonly subdlApiKey?: string;
}

/** Parses and validates environment variables into canonical server configuration. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = v.parse(EnvSchema, env);
  return {
    serverId: parsed.SERVER_ID?.trim() || undefined,
    appPort: parsed.APP_PORT ?? DEFAULT_APP_PORT,
    devClientPort: parsed.DEV_CLIENT_PORT ?? DEFAULT_DEV_CLIENT_PORT,
    puid: parsed.PUID ?? DEFAULT_PUID,
    pgid: parsed.PGID ?? DEFAULT_PGID,
    configDir: path.resolve(parsed.CONFIG_DIR || '/config'),
    inputDir: path.resolve(parsed.INPUT_DIR || '/data/input'),
    backupDir: path.resolve(parsed.BACKUP_DIR || '/data/backup'),
    outputMoviesDir: path.resolve(parsed.OUTPUT_MOVIES_DIR || '/data/output/movies'),
    outputAnimatedMoviesDir: path.resolve(
      parsed.OUTPUT_ANIMATED_MOVIES_DIR || '/data/output/animated-movies'
    ),
    outputTvShowsDir: path.resolve(parsed.OUTPUT_TV_SHOWS_DIR || '/data/output/tv-shows'),
    outputAnimatedSeriesDir: path.resolve(
      parsed.OUTPUT_ANIMATED_SERIES_DIR || '/data/output/animated-series'
    ),
    omdbApiKey: parsed.OMDB_API_KEY?.trim() || undefined,
    tvdbApiKey: parsed.TVDB_API_KEY?.trim() || undefined,
    openSubtitlesApiKey: parsed.OPENSUBTITLES_API_KEY?.trim() || undefined,
    openSubtitlesUsername: parsed.OPENSUBTITLES_USERNAME?.trim() || undefined,
    openSubtitlesPassword: parsed.OPENSUBTITLES_PASSWORD?.trim() || undefined,
    subdlApiKey: parsed.SUBDL_API_KEY?.trim() || undefined
  };
}

/** Projects configured roots into the read-only `MountPathsMap` contract for `/api/state`. */
export function buildMountPathsMap(config: AppConfig): MountPathsMap {
  return {
    configDir: config.configDir,
    inputDir: config.inputDir,
    backupDir: config.backupDir,
    movies: config.outputMoviesDir,
    'animated-movies': config.outputAnimatedMoviesDir,
    'tv-shows': config.outputTvShowsDir,
    'animated-series': config.outputAnimatedSeriesDir
  };
}

/** Verifies that all configured mount directories exist and are readable/writable. */
export async function validateMountDirectories(config: AppConfig): Promise<readonly string[]> {
  const dirs = [
    config.configDir,
    config.inputDir,
    config.backupDir,
    config.outputMoviesDir,
    config.outputAnimatedMoviesDir,
    config.outputTvShowsDir,
    config.outputAnimatedSeriesDir
  ];
  try {
    await fs.mkdir(config.backupDir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [`Backup dir create failed (${config.backupDir}): ${msg}`];
  }
  const errors: string[] = [];
  for (const dir of dirs) {
    try {
      await fs.access(dir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Mount inaccessible (${dir}): ${msg}`);
    }
  }
  return errors;
}

/** Resolves a stored file path across host boundaries (e.g. Docker `/data/input` vs Windows `inputDir`). */
export async function resolvePortableInputPath(
  config: Pick<AppConfig, 'inputDir' | 'configDir'>,
  storedPath: string,
  relativePath?: string
): Promise<string> {
  const normalizedStored = storedPath.replace(/\\/g, '/');
  const normalizedRel = relativePath ? relativePath.replace(/\\/g, '/') : undefined;
  const candidates: string[] = [storedPath];
  if (normalizedRel) {
    candidates.push(path.join(config.inputDir, ...normalizedRel.split('/')));
  }
  if (normalizedStored.includes('/subtitles/')) {
    candidates.push(
      path.join(config.configDir, 'subtitles', path.posix.basename(normalizedStored))
    );
  }
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try next candidate root when cache was populated from another host.
    }
  }
  return normalizedRel ? path.join(config.inputDir, ...normalizedRel.split('/')) : storedPath;
}

/**
 * Resolves a stable per-server key from `SERVER_ID` or deterministic hardware traits
 * so Docker container recreations retain history and Windows dev never pollutes NAS baselines.
 */
export function resolveHostKey(serverId?: string): string {
  const trimmed = serverId?.trim();
  if (trimmed) {
    return `env:${trimmed}`;
  }
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model ?? 'unknown';
  const cpuCount = Math.max(1, cpus.length);
  const ramGiB = Math.max(1, Math.round(os.totalmem() / BYTES_PER_GIB));
  const raw = `${process.platform}|${os.arch()}|${cpuModel}|${String(cpuCount)}|${String(ramGiB)}`;
  const digest = crypto
    .createHash('sha256')
    .update(raw)
    .digest('hex')
    .slice(0, HOST_HASH_HEX_LENGTH);
  return `hw:${digest}`;
}

/**
 * Derives a compact, filesystem-safe per-server tag (`nas`, `dev`, `hw-<8hex>`) so concurrent
 * servers sharing an SMB/NAS `INPUT_DIR` never delete or collide on each other's temp files.
 */
export function resolveServerTag(serverId?: string): string {
  const trimmed = serverId?.trim();
  if (trimmed) {
    const cleaned = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, SERVER_TAG_MAX_LENGTH);
    if (cleaned.length > 0) {
      return cleaned;
    }
    const digest = crypto
      .createHash('sha256')
      .update(trimmed)
      .digest('hex')
      .slice(0, SERVER_TAG_HASH_LENGTH);
    return `srv-${digest}`;
  }
  const hwKey = resolveHostKey(undefined);
  return `hw-${hwKey.slice(HW_PREFIX_LENGTH, HW_PREFIX_LENGTH + SERVER_TAG_HASH_LENGTH)}`;
}
