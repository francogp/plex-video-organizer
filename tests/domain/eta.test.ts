import { describe, expect, it } from 'vite-plus/test';

import {
  computeStageAwareEta,
  computeTrimmedMedian,
  convertFfmpegSpeedToRate,
  isFfmpegSpeedWarm,
  resolveChannelProfile,
  updateEmaRate,
  type EtaBucketState
} from '../../src/domain/eta.ts';

function makeBucket(overrides: Partial<EtaBucketState> = {}): EtaBucketState {
  return {
    workType: 'loudnorm_p1',
    profile: 'stereo',
    totalUnits: 1000,
    completedUnits: 0,
    inFlightUnits: 0,
    baselineRate: undefined,
    liveRate: undefined,
    liveSamples: 0,
    poolConcurrency: 2,
    activeOrPendingTasks: 2,
    ...overrides
  };
}

describe('domain/eta', () => {
  it('maps channel counts to finite profiles', () => {
    expect(resolveChannelProfile(undefined)).toBe('default');
    expect(resolveChannelProfile(0)).toBe('default');
    expect(resolveChannelProfile(1)).toBe('mono');
    expect(resolveChannelProfile(2)).toBe('stereo');
    expect(resolveChannelProfile(6)).toBe('surround');
    expect(resolveChannelProfile(8)).toBe('surround');
  });

  it('computes trimmed median with outlier trimming for >= 10 samples', () => {
    expect(computeTrimmedMedian([])).toBeUndefined();
    expect(computeTrimmedMedian([0, -1, Number.NaN])).toBeUndefined();
    expect(computeTrimmedMedian([10, 30, 20])).toBe(20);
    expect(computeTrimmedMedian([10, 20, 30, 40])).toBe(25);

    const withOutliers = [0.01, 10, 11, 12, 13, 14, 15, 16, 17, 9999];
    expect(computeTrimmedMedian(withOutliers)).toBe(13.5);
  });

  it('updates EMA symmetrically clamped against 3x spikes', () => {
    expect(updateEmaRate(undefined, 0)).toBeUndefined();
    expect(updateEmaRate(undefined, 2)).toBe(2);
    // Upward spike clamped to 2 * 3 = 6 -> 0.3 * 6 + 0.7 * 2 = 3.2
    expect(updateEmaRate(2, 100)).toBeCloseTo(3.2, 5);
    // Downward spike clamped to 2 / 3 -> 0.3 * (2/3) + 0.7 * 2 = 1.6
    expect(updateEmaRate(2, 0.01)).toBeCloseTo(1.6, 5);
  });

  it('blends baseline and live EMA rates with max 0.7 live weight via stage ETA', () => {
    // completed=500 / total=1000 => observed=0.5 => w=0.35 => blended = 0.35*2 + 0.65*4 = 3.3
    // remaining=500 => ETA = round(500 / 3.3) = 152s
    const res = computeStageAwareEta({
      buckets: [
        makeBucket({
          totalUnits: 1000,
          completedUnits: 500,
          inFlightUnits: 0,
          baselineRate: 4,
          liveRate: 2,
          liveSamples: 1,
          poolConcurrency: 1,
          activeOrPendingTasks: 1
        })
      ],
      activeWorkType: 'loudnorm_p1',
      pendingFollowupStages: 0
    });
    expect(res.etaState).toBe('live_blended');
    expect(res.etaSeconds).toBe(152);
  });

  it('checks ffmpeg speed warm-up guard and converts speed to physical rates', () => {
    expect(isFfmpegSpeedWarm(undefined, 10, 10)).toBe(false);
    expect(isFfmpegSpeedWarm(2, undefined, 10)).toBe(false);
    expect(isFfmpegSpeedWarm(2, 2, 1)).toBe(false);
    expect(isFfmpegSpeedWarm(2, 5, 1)).toBe(true);
    expect(isFfmpegSpeedWarm(2, 1, 2)).toBe(true);

    expect(convertFfmpegSpeedToRate('loudnorm_p1', 1.5, { trackCount: 3 })).toBe(1.5);
    expect(convertFfmpegSpeedToRate('remux_loudnorm', 1.5, { trackCount: 3 })).toBe(4.5);
    expect(
      convertFfmpegSpeedToRate('remux_copy', 2, { mediaDurationSec: 100, itemSizeBytes: 5000 })
    ).toBe(100);
    expect(convertFfmpegSpeedToRate('remux_copy', 2, {})).toBeUndefined();
  });

  it('computes calibrating, estimated, and live_blended states across stages', () => {
    // 1. Followup stage pending forces calibrating with undefined etaSeconds
    expect(
      computeStageAwareEta({
        buckets: [makeBucket({ baselineRate: 2 })],
        activeWorkType: 'scan_probe',
        pendingFollowupStages: 1
      })
    ).toEqual({ etaSeconds: undefined, etaState: 'calibrating' });

    // 2. Downstream stage missing rate, active stage has live rate -> stage-scoped calibrating ETA
    expect(
      computeStageAwareEta({
        buckets: [
          makeBucket({
            workType: 'loudnorm_p1',
            totalUnits: 400,
            completedUnits: 100,
            liveRate: 1.5,
            liveSamples: 3,
            poolConcurrency: 2,
            activeOrPendingTasks: 2
          }),
          makeBucket({
            workType: 'remux_loudnorm',
            totalUnits: 400
          })
        ],
        activeWorkType: 'loudnorm_p1',
        pendingFollowupStages: 0
      })
    ).toEqual({ etaSeconds: 100, etaState: 'calibrating' });

    // 3. All stages have historical baselines and no live samples -> estimated
    expect(
      computeStageAwareEta({
        buckets: [
          makeBucket({
            workType: 'loudnorm_p1',
            totalUnits: 400,
            baselineRate: 2,
            poolConcurrency: 2,
            activeOrPendingTasks: 2
          }),
          makeBucket({
            workType: 'move_exdev',
            profile: 'default',
            totalUnits: 1000,
            baselineRate: 100,
            poolConcurrency: 2,
            activeOrPendingTasks: 2
          })
        ],
        activeWorkType: 'loudnorm_p1',
        pendingFollowupStages: 0
      })
    ).toEqual({ etaSeconds: 110, etaState: 'estimated' });

    // 4. Live samples present -> live_blended subtracting inFlightUnits
    expect(
      computeStageAwareEta({
        buckets: [
          makeBucket({
            workType: 'loudnorm_p1',
            totalUnits: 500,
            completedUnits: 100,
            inFlightUnits: 100,
            baselineRate: 1,
            liveRate: 1,
            liveSamples: 4,
            poolConcurrency: 2,
            activeOrPendingTasks: 2
          })
        ],
        activeWorkType: 'loudnorm_p1',
        pendingFollowupStages: 0
      })
    ).toEqual({ etaSeconds: 150, etaState: 'live_blended' });
  });
});
