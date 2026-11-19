import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import {
  buildMountPathsMap,
  loadConfig,
  resolveHostKey,
  resolvePortableInputPath,
  resolveServerTag,
  validateMountDirectories
} from '../../src/server/config.ts';

describe('server config', () => {
  it('loads default values and trims optional API keys', () => {
    const cfg = loadConfig({
      APP_PORT: '4000',
      DEV_CLIENT_PORT: '5174',
      PUID: '1001',
      PGID: '1002',
      OMDB_API_KEY: '  omdb-secret  ',
      TVDB_API_KEY: '   '
    });

    expect(cfg.appPort).toBe(4000);
    expect(cfg.devClientPort).toBe(5174);
    expect(cfg.puid).toBe(1001);
    expect(cfg.pgid).toBe(1002);
    expect(cfg.omdbApiKey).toBe('omdb-secret');
    expect(cfg.tvdbApiKey).toBeUndefined();

    const map = buildMountPathsMap(cfg);
    expect(map.configDir).toBe(cfg.configDir);
    expect(map.inputDir).toBe(cfg.inputDir);
    expect(map.backupDir).toBe(cfg.backupDir);
    expect(map.movies).toBe(cfg.outputMoviesDir);
    expect(map['tv-shows']).toBe(cfg.outputTvShowsDir);
  });

  it('validates existing vs missing mount directories', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-cfg-'));
    try {
      const cfg = loadConfig({
        CONFIG_DIR: tmpDir,
        INPUT_DIR: tmpDir,
        OUTPUT_MOVIES_DIR: tmpDir,
        OUTPUT_DOCUMENTARIES_DIR: tmpDir,
        OUTPUT_ANIMATED_MOVIES_DIR: tmpDir,
        OUTPUT_TV_SHOWS_DIR: tmpDir,
        OUTPUT_ANIMATED_SERIES_DIR: path.join(tmpDir, 'missing-dir')
      });
      const errors = await validateMountDirectories(cfg);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('missing-dir');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls back to default ports and paths when environment variables are omitted or invalid', () => {
    const cfg = loadConfig({
      APP_PORT: 'not-a-port',
      DEV_CLIENT_PORT: '-5',
      PUID: '0',
      PGID: 'abc'
    });

    expect(cfg.appPort).toBe(3000);
    expect(cfg.devClientPort).toBe(5173);
    expect(cfg.puid).toBe(1000);
    expect(cfg.pgid).toBe(1000);
    expect(cfg.omdbApiKey).toBeUndefined();
    expect(cfg.tvdbApiKey).toBeUndefined();
  });

  it('reports backup creation errors when BACKUP_DIR is blocked by a file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-cfg-backup-'));
    try {
      const blockingFile = path.join(tmpDir, 'not-a-dir');
      await fs.writeFile(blockingFile, 'occupied');

      const badCfg = loadConfig({
        CONFIG_DIR: tmpDir,
        INPUT_DIR: tmpDir,
        OUTPUT_MOVIES_DIR: tmpDir,
        OUTPUT_DOCUMENTARIES_DIR: tmpDir,
        OUTPUT_ANIMATED_MOVIES_DIR: tmpDir,
        OUTPUT_TV_SHOWS_DIR: tmpDir,
        OUTPUT_ANIMATED_SERIES_DIR: tmpDir,
        BACKUP_DIR: blockingFile
      });
      const errors = await validateMountDirectories(badCfg);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(blockingFile);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('resolves cross-host input and config subtitle paths across Windows and Docker', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vo-portable-'));
    try {
      const inputDir = path.join(tmpDir, 'input');
      const configDir = path.join(tmpDir, 'config');
      const showDir = path.join(inputDir, 'Show', 'Season 01');
      const subsDir = path.join(configDir, 'subtitles');
      await fs.mkdir(showDir, { recursive: true });
      await fs.mkdir(subsDir, { recursive: true });

      const videoFile = path.join(showDir, 'Show.S01E01.mkv');
      const subFile = path.join(subsDir, '5433501c4728.spa.srt');
      await fs.writeFile(videoFile, 'v');
      await fs.writeFile(subFile, 's');

      const resolvedFromDocker = await resolvePortableInputPath(
        { inputDir, configDir },
        '/data/input/Show/Season 01/Show.S01E01.mkv',
        'Show\\Season 01\\Show.S01E01.mkv'
      );
      expect(resolvedFromDocker).toBe(videoFile);

      const resolvedSubFromWindows = await resolvePortableInputPath(
        { inputDir, configDir },
        'z:\\missing-nas-share\\subtitles\\5433501c4728.spa.srt',
        '5433501c4728.spa.srt'
      );
      expect(resolvedSubFromWindows).toBe(subFile);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('derives deterministic host keys and filesystem-safe per-server temp tags', () => {
    expect(resolveHostKey('NAS')).toBe('env:NAS');
    expect(resolveHostKey('  dev  ')).toBe('env:dev');
    expect(resolveHostKey(undefined)).toMatch(/^hw:[a-f0-9]{16}$/);

    expect(resolveServerTag('NAS')).toBe('nas');
    expect(resolveServerTag('  My_NAS.Server#1  ')).toBe('my_nas-server-1');
    expect(resolveServerTag('***')).toMatch(/^srv-[a-f0-9]{8}$/);
    expect(resolveServerTag(undefined)).toMatch(/^hw-[a-f0-9]{8}$/);
    expect(resolveServerTag(undefined)).toBe(resolveServerTag('   '));
  });
});
