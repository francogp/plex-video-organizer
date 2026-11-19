import {
  ETA_COPY_FROM_IO_FACTOR,
  ETA_DEFAULT_COLD_RATES,
  ETA_EMA_ALPHA,
  ETA_FALLBACK_CALIBRATING_THRESHOLD,
  ETA_LIVE_WEIGHT_MAX,
  ETA_MULTI_TRACK_CONTENTION_FACTOR,
  ETA_PEAK_FROM_LOUDNORM_FACTOR,
  ETA_PROFILE_CHANNEL_FACTORS,
  ETA_REMUX_LOUDNORM_FROM_P1_FACTOR,
  ETA_SPIKE_CLAMP_FACTOR,
  ETA_TRIM_FRACTION,
  ETA_TRIM_THRESHOLD,
  ETA_WARMUP_ELAPSED_SEC,
  ETA_WARMUP_OUT_TIME_SEC
} from './constants.ts';
import {
  asEtaStageId,
  asEtaStepId,
  type EtaChannelProfile,
  type EtaRateDiagnostic,
  type EtaRateSource,
  type EtaSimulatedSlot,
  type EtaSimulatedSlotItem,
  type EtaSimulatedStep,
  type EtaSimulationEntryId,
  type EtaStageId,
  type EtaState,
  type EtaStepId,
  type EtaStepKind,
  type EtaWorkType,
  type EtaWorkUnitKind,
  type ItemId,
  type JobRetryAttempt
} from './types.ts';

const WORK_UNIT_KIND_BY_TYPE: Readonly<Record<EtaWorkType, EtaWorkUnitKind>> = {
  scan_probe: 'entries',
  volumedetect: 'audio_seconds',
  loudnorm_p1: 'audio_seconds',
  remux_loudnorm: 'audio_seconds',
  remux_peak_gain: 'audio_seconds',
  remux_copy: 'bytes',
  finalize_io: 'bytes',
  verifier_scan_fs: 'entries',
  verifier_scan_probe: 'entries'
};

const SIBLING_PROFILE_PRIORITY: readonly EtaChannelProfile[] = [
  'surround',
  'stereo',
  'mono',
  'default'
];

export type EtaBucketKey = `${EtaWorkType}:${EtaChannelProfile}`;

export interface EtaFfmpegSpeedContext {
  readonly mediaDurationSec?: number;
  readonly itemSizeBytes?: number;
  readonly trackCount?: number;
}

export interface EtaEstimate {
  readonly etaSeconds?: number;
  readonly etaState: EtaState;
  readonly weightedFraction?: number;
}

export interface EtaRateEntry {
  readonly workType: EtaWorkType;
  readonly profile: EtaChannelProfile;
  readonly baselineRate?: number;
  readonly baselineSampleCount: number;
  readonly liveRate?: number;
  readonly liveSamples: number;
  readonly observedFraction: number;
}

export interface EtaResolvedRate {
  readonly rate: number;
  readonly source: EtaRateSource;
  readonly baselineRate?: number;
  readonly liveRate?: number;
  readonly sampleCount: number;
}

export interface EtaQueueStepState {
  readonly stepId: EtaStepId;
  readonly workType: EtaWorkType;
  readonly profile: EtaChannelProfile;
  readonly totalUnits: number;
  readonly completedUnits: number;
  readonly inFlightUnits: number;
  readonly parallelTracks: number;
}

export interface EtaQueueItemState {
  readonly itemId: EtaSimulationEntryId;
  readonly fileName: string;
  readonly activeSlot?: number;
  readonly completed: boolean;
  readonly skipped: boolean;
  readonly steps: readonly EtaQueueStepState[];
}

export interface EtaQueueComputationInput {
  readonly items: readonly EtaQueueItemState[];
  readonly workerCount: number;
  readonly rateIndex: ReadonlyMap<EtaBucketKey, EtaRateEntry>;
  readonly pendingFollowupStages?: number;
}

export interface EtaQueueComputationResult {
  readonly etaSeconds?: number;
  readonly etaState: EtaState;
  readonly weightedFraction: number;
  readonly fallbackShare: number;
  readonly slots: readonly EtaSimulatedSlot[];
  readonly rates: readonly EtaRateDiagnostic[];
}

/** Builds the canonical `${workType}:${profile}` bucket key. */
export function buildEtaBucketKey(workType: EtaWorkType, profile: EtaChannelProfile): EtaBucketKey {
  return `${workType}:${profile}`;
}

/** Builds a branded `EtaStepId` invariant across item retry attempts. */
export function buildEtaStepId(kind: EtaStepKind, itemId: ItemId): EtaStepId {
  return asEtaStepId(`${kind}:${itemId}`);
}

/** Builds an attempt-scoped runtime task ID distinct from `EtaStepId`. */
export function buildEtaAttemptTaskId(
  kind: EtaStepKind,
  itemId: ItemId,
  attempt: JobRetryAttempt,
  streamOrder?: number
): string {
  return streamOrder !== undefined
    ? `${kind}:${itemId}:a${String(attempt)}:${String(streamOrder)}`
    : `${kind}:${itemId}:a${String(attempt)}`;
}

/** Builds a branded `EtaStageId` for stage-based Scan/Verifier slices. */
export function buildEtaStageId(
  workType: EtaWorkType,
  profile: EtaChannelProfile,
  sliceIndex = 0
): EtaStageId {
  return asEtaStageId(
    sliceIndex > 0
      ? `stage:${workType}:${profile}:${String(sliceIndex)}`
      : `stage:${workType}:${profile}`
  );
}

/** Builds a branded `EtaStepId` for stage-based Scan/Verifier slices. */
export function buildEtaStageStepId(
  workType: EtaWorkType,
  profile: EtaChannelProfile,
  sliceIndex = 0
): EtaStepId {
  return asEtaStepId(
    sliceIndex > 0
      ? `stage-step:${workType}:${profile}:${String(sliceIndex)}`
      : `stage-step:${workType}:${profile}`
  );
}

/** Returns the canonical measurement unit kind for an `EtaWorkType`. */
export function getWorkUnitKind(workType: EtaWorkType): EtaWorkUnitKind {
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

function findWorkTypeEntry(
  workType: EtaWorkType,
  preferredProfile: EtaChannelProfile,
  rateIndex: ReadonlyMap<EtaBucketKey, EtaRateEntry>
): { readonly entry: EtaRateEntry; readonly rate: number; readonly exact: boolean } | undefined {
  const exactEntry = rateIndex.get(buildEtaBucketKey(workType, preferredProfile));
  if (exactEntry) {
    const exactRate = blendRates(
      exactEntry.baselineRate,
      exactEntry.liveRate,
      exactEntry.observedFraction
    );
    if (exactRate !== undefined) {
      return { entry: exactEntry, rate: exactRate, exact: true };
    }
  }
  for (const candidateProfile of SIBLING_PROFILE_PRIORITY) {
    if (candidateProfile === preferredProfile) {
      continue;
    }
    const candidate = rateIndex.get(buildEtaBucketKey(workType, candidateProfile));
    if (!candidate) {
      continue;
    }
    const rate = blendRates(candidate.baselineRate, candidate.liveRate, candidate.observedFraction);
    if (rate !== undefined) {
      return { entry: candidate, rate, exact: false };
    }
  }
  return undefined;
}

function scaleRateBetweenProfiles(
  workType: EtaWorkType,
  rate: number,
  fromProfile: EtaChannelProfile,
  toProfile: EtaChannelProfile
): number {
  if (getWorkUnitKind(workType) !== 'audio_seconds' || fromProfile === toProfile) {
    return rate;
  }
  const fromFactor = ETA_PROFILE_CHANNEL_FACTORS[fromProfile];
  const toFactor = ETA_PROFILE_CHANNEL_FACTORS[toProfile];
  return rate * (toFactor / fromFactor);
}

function resolveRelatedWorkTypeRate(
  workType: EtaWorkType,
  profile: EtaChannelProfile,
  rateIndex: ReadonlyMap<EtaBucketKey, EtaRateEntry>
): EtaResolvedRate | undefined {
  let relation: { readonly targetType: EtaWorkType; readonly factor: number } | undefined;
  switch (workType) {
    case 'remux_peak_gain':
      relation = { targetType: 'remux_loudnorm', factor: ETA_PEAK_FROM_LOUDNORM_FACTOR };
      break;
    case 'remux_loudnorm':
      relation = { targetType: 'loudnorm_p1', factor: ETA_REMUX_LOUDNORM_FROM_P1_FACTOR };
      break;
    case 'loudnorm_p1':
      relation = { targetType: 'remux_loudnorm', factor: 1 / ETA_REMUX_LOUDNORM_FROM_P1_FACTOR };
      break;
    case 'remux_copy':
      relation = { targetType: 'finalize_io', factor: ETA_COPY_FROM_IO_FACTOR };
      break;
    case 'finalize_io':
      relation = { targetType: 'remux_copy', factor: 1 / ETA_COPY_FROM_IO_FACTOR };
      break;
    case 'verifier_scan_probe':
      relation = { targetType: 'scan_probe', factor: 1 };
      break;
    case 'scan_probe':
      relation = { targetType: 'verifier_scan_probe', factor: 1 };
      break;
    default:
      relation = undefined;
  }
  if (!relation) {
    return undefined;
  }
  const found = findWorkTypeEntry(relation.targetType, profile, rateIndex);
  if (!found) {
    return undefined;
  }
  const scaled =
    scaleRateBetweenProfiles(relation.targetType, found.rate, found.entry.profile, profile) *
    relation.factor;
  return {
    rate: scaled,
    source: 'related_work_type',
    baselineRate: found.entry.baselineRate,
    liveRate: found.entry.liveRate,
    sampleCount: found.entry.baselineSampleCount + found.entry.liveSamples
  };
}

/**
 * Resolves a rate for `(workType, profile)` via 4-tier hierarchy:
 * 1) exact match (`live_blended`/`baseline`), 2) sibling channel profile,
 * 3) related work type on same host, 4) cold default rate.
 */
function resolveHierarchicalRate(
  workType: EtaWorkType,
  profile: EtaChannelProfile,
  rateIndex: ReadonlyMap<EtaBucketKey, EtaRateEntry>
): EtaResolvedRate {
  const direct = findWorkTypeEntry(workType, profile, rateIndex);
  if (direct) {
    if (direct.exact) {
      return {
        rate: direct.rate,
        source: direct.entry.liveSamples > 0 ? 'live_blended' : 'baseline',
        baselineRate: direct.entry.baselineRate,
        liveRate: direct.entry.liveRate,
        sampleCount: direct.entry.baselineSampleCount + direct.entry.liveSamples
      };
    }
    return {
      rate: scaleRateBetweenProfiles(workType, direct.rate, direct.entry.profile, profile),
      source: 'sibling_profile',
      baselineRate: direct.entry.baselineRate,
      liveRate: direct.entry.liveRate,
      sampleCount: direct.entry.baselineSampleCount + direct.entry.liveSamples
    };
  }

  const related = resolveRelatedWorkTypeRate(workType, profile, rateIndex);
  if (related) {
    return related;
  }

  const coldBase = ETA_DEFAULT_COLD_RATES[workType];
  const coldRate =
    getWorkUnitKind(workType) === 'audio_seconds'
      ? scaleRateBetweenProfiles(workType, coldBase, 'surround', profile)
      : coldBase;
  return { rate: coldRate, source: 'cold_default', sampleCount: 0 };
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

function resolveStepEffectiveRate(step: EtaQueueStepState, baseRate: number): number {
  if (step.workType === 'loudnorm_p1' && step.parallelTracks > 1) {
    return baseRate * step.parallelTracks * ETA_MULTI_TRACK_CONTENTION_FACTOR;
  }
  return baseRate;
}

interface SimulatedItemAccumulator {
  readonly item: EtaQueueItemState;
  readonly evaluatedSteps: EtaSimulatedStep[];
  readonly totalSeconds: number;
  readonly remainingSeconds: number;
  readonly coldRemainingSeconds: number;
  readonly nonDirectRemainingSeconds: number;
}

function evaluateQueueItem(
  item: EtaQueueItemState,
  rateIndex: ReadonlyMap<EtaBucketKey, EtaRateEntry>,
  diagnostics: Map<EtaBucketKey, EtaRateDiagnostic>
): SimulatedItemAccumulator {
  const evaluatedSteps: EtaSimulatedStep[] = [];
  let totalSeconds = 0;
  let remainingSeconds = 0;
  let coldRemainingSeconds = 0;
  let nonDirectRemainingSeconds = 0;

  for (const step of item.steps) {
    const key = buildEtaBucketKey(step.workType, step.profile);
    const resolved = resolveHierarchicalRate(step.workType, step.profile, rateIndex);
    const effectiveRate = resolveStepEffectiveRate(step, resolved.rate);

    if (!diagnostics.has(key)) {
      diagnostics.set(key, {
        workType: step.workType,
        profile: step.profile,
        baselineRate: resolved.baselineRate,
        liveRate: resolved.liveRate,
        effectiveRate: resolved.rate,
        source: resolved.source,
        sampleCount: resolved.sampleCount
      });
    }

    const stepTotalSec = step.totalUnits > 0 ? step.totalUnits / effectiveRate : 0;
    const completedUnits = item.completed
      ? step.totalUnits
      : Math.min(step.totalUnits, Math.max(0, step.completedUnits + step.inFlightUnits));
    const remainingUnits = item.completed ? 0 : Math.max(0, step.totalUnits - completedUnits);
    const stepRemSec = remainingUnits > 0 ? remainingUnits / effectiveRate : 0;

    totalSeconds += stepTotalSec;
    remainingSeconds += stepRemSec;
    if (resolved.source === 'cold_default') {
      coldRemainingSeconds += stepRemSec;
    }
    if (resolved.source !== 'live_blended' && resolved.source !== 'baseline') {
      nonDirectRemainingSeconds += stepRemSec;
    }

    evaluatedSteps.push({
      workType: step.workType,
      profile: step.profile,
      totalUnits: step.totalUnits,
      completedUnits,
      remainingUnits,
      totalSeconds: stepTotalSec,
      remainingSeconds: stepRemSec,
      rateUsed: effectiveRate,
      rateSource: resolved.source
    });
  }

  return {
    item,
    evaluatedSteps,
    totalSeconds,
    remainingSeconds,
    coldRemainingSeconds,
    nonDirectRemainingSeconds
  };
}

function assignItemToSlot(
  slot: { totalSeconds: number; items: EtaSimulatedSlotItem[] },
  evaluated: SimulatedItemAccumulator,
  status: EtaSimulatedSlotItem['status']
): void {
  slot.totalSeconds += evaluated.remainingSeconds;
  slot.items.push({
    itemId: evaluated.item.itemId,
    fileName: evaluated.item.fileName,
    status,
    totalSeconds: evaluated.totalSeconds,
    remainingSeconds: evaluated.remainingSeconds,
    steps: evaluated.evaluatedSteps
  });
}

/**
 * Simulates the entire known queue item-by-item and step-by-step across `workerCount`
 * parallel slots, returning makespan ETA, time-weighted progress fraction, and slot schedules.
 */
export function computeQueueEta(input: EtaQueueComputationInput): EtaQueueComputationResult {
  const workerCount = Math.max(1, Math.floor(input.workerCount));
  const slotBuckets: Array<{ totalSeconds: number; items: EtaSimulatedSlotItem[] }> = Array.from(
    { length: workerCount },
    () => ({ totalSeconds: 0, items: [] })
  );
  const diagnostics = new Map<EtaBucketKey, EtaRateDiagnostic>();

  let totalWorkSeconds = 0;
  let completedWorkSeconds = 0;
  let remainingWorkSeconds = 0;
  let coldRemainingSeconds = 0;
  let nonDirectRemainingSeconds = 0;

  const activeItems: SimulatedItemAccumulator[] = [];
  const pendingItems: SimulatedItemAccumulator[] = [];

  for (const item of input.items) {
    if (item.skipped) {
      continue;
    }
    const evaluated = evaluateQueueItem(item, input.rateIndex, diagnostics);
    totalWorkSeconds += evaluated.totalSeconds;
    completedWorkSeconds += Math.max(0, evaluated.totalSeconds - evaluated.remainingSeconds);

    if (item.completed || evaluated.remainingSeconds <= 0) {
      continue;
    }
    remainingWorkSeconds += evaluated.remainingSeconds;
    coldRemainingSeconds += evaluated.coldRemainingSeconds;
    nonDirectRemainingSeconds += evaluated.nonDirectRemainingSeconds;

    if (item.activeSlot !== undefined && item.activeSlot >= 0 && item.activeSlot < workerCount) {
      activeItems.push(evaluated);
    } else {
      pendingItems.push(evaluated);
    }
  }

  for (const active of activeItems) {
    assignItemToSlot(slotBuckets[active.item.activeSlot!]!, active, 'active');
  }

  for (const pending of pendingItems) {
    let target = slotBuckets[0]!;
    for (const candidate of slotBuckets) {
      if (candidate.totalSeconds < target.totalSeconds) {
        target = candidate;
      }
    }
    assignItemToSlot(target, pending, 'pending');
  }

  const maxSlotSeconds = slotBuckets.reduce((max, s) => Math.max(max, s.totalSeconds), 0);
  const weightedFraction =
    totalWorkSeconds > 0 ? Math.min(1, Math.max(0, completedWorkSeconds / totalWorkSeconds)) : 0;
  const fallbackShare =
    remainingWorkSeconds > 0 ? nonDirectRemainingSeconds / remainingWorkSeconds : 0;
  const coldShare = remainingWorkSeconds > 0 ? coldRemainingSeconds / remainingWorkSeconds : 0;

  let hasAnyLiveSamples = false;
  for (const entry of input.rateIndex.values()) {
    if (entry.liveSamples > 0) {
      hasAnyLiveSamples = true;
      break;
    }
  }

  let etaSeconds: number | undefined;
  let etaState: EtaState;
  if ((input.pendingFollowupStages ?? 0) > 0 || totalWorkSeconds <= 0) {
    etaSeconds = undefined;
    etaState = 'calibrating';
  } else {
    etaSeconds = Math.max(0, Math.round(maxSlotSeconds));
    if (remainingWorkSeconds <= 0) {
      etaState = 'live_blended';
    } else if (coldShare >= ETA_FALLBACK_CALIBRATING_THRESHOLD) {
      etaState = 'calibrating';
    } else if (hasAnyLiveSamples) {
      etaState = 'live_blended';
    } else {
      etaState = 'estimated';
    }
  }

  const slots: EtaSimulatedSlot[] = slotBuckets.map((slot, slotIndex) => ({
    slotIndex,
    totalSeconds: slot.totalSeconds,
    items: slot.items
  }));
  const rates = [...diagnostics.values()].toSorted((a, b) =>
    `${a.workType}:${a.profile}`.localeCompare(`${b.workType}:${b.profile}`)
  );

  return {
    etaSeconds,
    etaState,
    weightedFraction,
    fallbackShare,
    slots,
    rates
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
