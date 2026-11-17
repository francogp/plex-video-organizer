import {
  ETA_EMA_ALPHA,
  ETA_LIVE_WEIGHT_MAX,
  ETA_SPIKE_CLAMP_FACTOR,
  ETA_TRIM_FRACTION,
  ETA_TRIM_THRESHOLD,
  ETA_WARMUP_ELAPSED_SEC,
  ETA_WARMUP_OUT_TIME_SEC
} from './constants.ts';
import type { EtaChannelProfile, EtaState, EtaWorkType, EtaWorkUnitKind } from './types.ts';

const WORK_UNIT_KIND_BY_TYPE: Readonly<Record<EtaWorkType, EtaWorkUnitKind>> = {
  scan_probe: 'entries',
  volumedetect: 'audio_seconds',
  loudnorm_p1: 'audio_seconds',
  remux_loudnorm: 'audio_seconds',
  remux_peak_gain: 'audio_seconds',
  remux_copy: 'bytes',
  move_exdev: 'bytes',
  verifier_scan_fs: 'entries',
  verifier_scan_probe: 'entries'
};

export type EtaBucketKey = `${EtaWorkType}:${EtaChannelProfile}`;

export interface EtaBucketState {
  readonly workType: EtaWorkType;
  readonly profile: EtaChannelProfile;
  readonly totalUnits: number;
  readonly completedUnits: number;
  readonly inFlightUnits: number;
  readonly baselineRate: number | undefined;
  readonly liveRate: number | undefined;
  readonly liveSamples: number;
  readonly poolConcurrency: number;
  readonly activeOrPendingTasks: number;
}

export interface EtaFfmpegSpeedContext {
  readonly mediaDurationSec?: number;
  readonly itemSizeBytes?: number;
  readonly trackCount?: number;
}

export interface EtaComputationInput {
  readonly buckets: readonly EtaBucketState[];
  readonly activeWorkType?: EtaWorkType;
  readonly pendingFollowupStages: number;
}

export interface EtaEstimate {
  readonly etaSeconds?: number;
  readonly etaState: EtaState;
}

/** Builds the canonical `${workType}:${profile}` bucket key. */
export function buildEtaBucketKey(workType: EtaWorkType, profile: EtaChannelProfile): EtaBucketKey {
  return `${workType}:${profile}`;
}

function getWorkUnitKind(workType: EtaWorkType): EtaWorkUnitKind {
  return WORK_UNIT_KIND_BY_TYPE[workType];
}

/** Maps a numeric audio channel count to its finite `EtaChannelProfile` bucket. */
export function resolveChannelProfile(channels?: number): EtaChannelProfile {
  if (channels === undefined || !Number.isFinite(channels) || channels <= 0) {
    return 'default';
  }
  if (channels === 1) {
    return 'mono';
  }
  if (channels === 2) {
    return 'stereo';
  }
  return 'surround';
}

/** Computes a 10% trimmed median (or plain median when N < 10) from positive throughput samples. */
export function computeTrimmedMedian(samples: readonly number[]): number | undefined {
  const valid = samples
    .filter((value): boolean => Number.isFinite(value) && value > 0)
    .toSorted((a, b): number => a - b);
  if (valid.length === 0) {
    return undefined;
  }
  const trimCount =
    valid.length >= ETA_TRIM_THRESHOLD ? Math.floor(valid.length * ETA_TRIM_FRACTION) : 0;
  const trimmed = valid.slice(trimCount, valid.length - trimCount);
  const mid = Math.floor(trimmed.length / 2);
  if (trimmed.length % 2 === 1) {
    return trimmed[mid];
  }
  const low = trimmed[mid - 1];
  const high = trimmed[mid];
  return low !== undefined && high !== undefined ? (low + high) / 2 : trimmed[0];
}

/** Updates an exponential moving average rate while symmetrically clamping extreme spikes. */
export function updateEmaRate(
  previousRate: number | undefined,
  sampleRate: number,
  alpha = ETA_EMA_ALPHA
): number | undefined {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    return previousRate;
  }
  if (previousRate === undefined || !Number.isFinite(previousRate) || previousRate <= 0) {
    return sampleRate;
  }
  const minAllowed = previousRate / ETA_SPIKE_CLAMP_FACTOR;
  const maxAllowed = previousRate * ETA_SPIKE_CLAMP_FACTOR;
  const clamped = Math.min(maxAllowed, Math.max(minAllowed, sampleRate));
  return alpha * clamped + (1 - alpha) * previousRate;
}

/** Blends historical baseline rate with live EMA rate using observed stage completion weight. */
function blendRates(
  baselineRate: number | undefined,
  liveRate: number | undefined,
  observedFraction: number
): number | undefined {
  const validBaseline =
    baselineRate !== undefined && Number.isFinite(baselineRate) && baselineRate > 0
      ? baselineRate
      : undefined;
  const validLive =
    liveRate !== undefined && Number.isFinite(liveRate) && liveRate > 0 ? liveRate : undefined;

  if (validBaseline === undefined) {
    return validLive;
  }
  if (validLive === undefined) {
    return validBaseline;
  }
  const clampedFraction = Math.min(1, Math.max(0, observedFraction));
  const liveWeight = Math.min(ETA_LIVE_WEIGHT_MAX, ETA_LIVE_WEIGHT_MAX * clampedFraction);
  return liveWeight * validLive + (1 - liveWeight) * validBaseline;
}

/** Checks whether an `ffmpeg` progress tick passes the warm-up threshold for live EMA ingestion. */
export function isFfmpegSpeedWarm(
  speed: number | undefined,
  outTimeSec: number | undefined,
  elapsedSec: number
): speed is number {
  if (speed === undefined || !Number.isFinite(speed) || speed <= 0) {
    return false;
  }
  if (outTimeSec === undefined) {
    return false;
  }
  return outTimeSec >= ETA_WARMUP_OUT_TIME_SEC || elapsedSec >= ETA_WARMUP_ELAPSED_SEC;
}

/** Converts an `ffmpeg` playback speed multiplier into canonical physical `workUnits / sec`. */
export function convertFfmpegSpeedToRate(
  workType: EtaWorkType,
  speed: number,
  context: EtaFfmpegSpeedContext
): number | undefined {
  if (!Number.isFinite(speed) || speed <= 0) {
    return undefined;
  }
  const unitKind = getWorkUnitKind(workType);
  if (unitKind === 'audio_seconds') {
    if (workType === 'remux_loudnorm' || workType === 'remux_peak_gain') {
      const tracks = Math.max(1, context.trackCount ?? 1);
      return speed * tracks;
    }
    return speed;
  }
  if (workType === 'remux_copy') {
    const duration = context.mediaDurationSec ?? 0;
    const sizeBytes = context.itemSizeBytes ?? 0;
    if (duration > 0 && sizeBytes > 0) {
      return speed * (sizeBytes / duration);
    }
  }
  return undefined;
}

function resolveBucketRemainingUnits(bucket: EtaBucketState): number {
  return Math.max(0, bucket.totalUnits - bucket.completedUnits - bucket.inFlightUnits);
}

function resolveBucketEffectiveRate(bucket: EtaBucketState): number | undefined {
  const observedUnits = bucket.completedUnits + bucket.inFlightUnits;
  const observedFraction = bucket.totalUnits > 0 ? observedUnits / bucket.totalUnits : 0;
  const blended = blendRates(bucket.baselineRate, bucket.liveRate, observedFraction);
  if (blended === undefined || blended <= 0) {
    return undefined;
  }
  if (bucket.workType === 'move_exdev') {
    return blended;
  }
  const effectiveConcurrency = Math.max(
    1,
    Math.min(bucket.poolConcurrency, bucket.activeOrPendingTasks)
  );
  return blended * effectiveConcurrency;
}

/** Computes stage-aware remaining seconds and calibration state across all pending buckets. */
export function computeStageAwareEta(input: EtaComputationInput): EtaEstimate {
  const pendingBuckets = input.buckets.filter((b) => resolveBucketRemainingUnits(b) > 0);
  if (pendingBuckets.length === 0) {
    return {
      etaSeconds: input.pendingFollowupStages > 0 ? undefined : 0,
      etaState: input.pendingFollowupStages > 0 ? 'calibrating' : 'live_blended'
    };
  }
  if (input.pendingFollowupStages > 0) {
    return { etaSeconds: undefined, etaState: 'calibrating' };
  }

  let totalSeconds = 0;
  let activeStageSeconds = 0;
  let hasAnyLiveSamples = false;
  let missingAnyRate = false;
  let activeStageMissingRate = false;
  let hasActiveStageWork = false;

  for (const bucket of pendingBuckets) {
    if (bucket.liveSamples > 0) {
      hasAnyLiveSamples = true;
    }
    const remaining = resolveBucketRemainingUnits(bucket);
    const rate = resolveBucketEffectiveRate(bucket);
    const isActive = input.activeWorkType !== undefined && bucket.workType === input.activeWorkType;
    if (isActive) {
      hasActiveStageWork = true;
    }
    if (rate === undefined) {
      missingAnyRate = true;
      if (isActive) {
        activeStageMissingRate = true;
      }
      continue;
    }
    const sec = remaining / rate;
    totalSeconds += sec;
    if (isActive) {
      activeStageSeconds += sec;
    }
  }

  if (missingAnyRate) {
    const canShowStageEta = hasActiveStageWork && !activeStageMissingRate;
    return {
      etaSeconds: canShowStageEta ? Math.max(0, Math.round(activeStageSeconds)) : undefined,
      etaState: 'calibrating'
    };
  }

  return {
    etaSeconds: Math.max(0, Math.round(totalSeconds)),
    etaState: hasAnyLiveSamples ? 'live_blended' : 'estimated'
  };
}

/** Computes a linear fallback ETA when `EtaPredictor` is not attached. */
export function computeLinearFallbackEta(
  fraction: number,
  completed: number,
  total: number,
  elapsedSec: number,
  minFraction = 0.001,
  minElapsedSec = 1
): number | undefined {
  if (fraction <= minFraction || completed >= total || elapsedSec < minElapsedSec) {
    return undefined;
  }
  return Math.max(0, Math.round((elapsedSec * (1 - fraction)) / fraction));
}
