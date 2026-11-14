import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

class FakeChildProcess extends EventEmitter {
  public readonly stdout = new EventEmitter();
  public readonly stderr = new EventEmitter();
  public readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => true);
}

const spawnQueue: FakeChildProcess[] = [];

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const child = spawnQueue.shift() ?? new FakeChildProcess();
    return child;
  })
}));

const { analyzeAudioVolume } = await import('../../src/server/services/media/ffmpegRunner.ts');

describe('ffmpegRunner stall watchdog', () => {
  afterEach(() => {
    spawnQueue.length = 0;
  });

  it('kills a stalled ffmpeg process and rejects when no output arrives within stallTimeoutMs', async () => {
    const child = new FakeChildProcess();
    spawnQueue.push(child);
    const tracked: unknown[] = [];

    await expect(
      analyzeAudioVolume(
        '/data/input/Supergirl.2026.mp4',
        0,
        120,
        () => undefined,
        (c) => tracked.push(c),
        40
      )
    ).rejects.toThrow('ffmpeg stalled with no output for 40ms');

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(tracked).toEqual([child, null]);
  });

  it('resets the stall watchdog when progress output arrives and resolves on exit code 0', async () => {
    const child = new FakeChildProcess();
    spawnQueue.push(child);

    const promise = analyzeAudioVolume(
      '/data/input/Movie.mkv',
      0,
      100,
      () => undefined,
      undefined,
      60
    );

    setTimeout(() => {
      child.stdout.emit('data', Buffer.from('out_time_us=50000000\n'));
    }, 30);

    setTimeout(() => {
      child.stderr.emit('data', Buffer.from('mean_volume: -18.5 dB\nmax_volume: -1.2 dB\n'));
      child.emit('close', 0);
    }, 65);

    const result = await promise;
    expect(result).toMatchObject({
      streamOrder: 0,
      meanVolumeDb: -18.5,
      maxVolumeDb: -1.2
    });
    expect(child.kill).not.toHaveBeenCalled();
  });
});
