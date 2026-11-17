import crypto from 'node:crypto';
import os from 'node:os';

import { ETA_EMA_ALPHA, ETA_FLUSH_BATCH_SIZE, ETA_MIN_SAMPLE_MS } from '../../domain/constants.ts';
import {
  buildEtaBucketKey,
  computeStageAwareEta,
  computeTrimmedMedian,
  convertFfmpegSpeedToRate,
  isFfmpegSpeedWarm,
  updateEmaRate,
  type EtaBucketKey,
  type EtaBucketState,
  type EtaEstimate,
  type EtaFfmpegSpeedContext
} from '../../domain/eta.ts';
import type { EtaChannelProfile, EtaWorkType } from '../../domain/types.ts';
import type { EtaSampleInput, ScanCacheDb } from './scanCacheDb.ts';

const BYTES_PER_GIB = 1024 ** 3;
const HOST_HASH_HEX_LENGTH = 16;
const MS_PER_SECOND = 1000;

export interface EtaInventoryEntry {
  readonly profile: EtaChannelProfile;
  readonly units: number;
  readonly taskCount?: number;
}

interface MutableBucket {
  readonly workType: EtaWorkType;
  readonly profile: EtaChannelProfile;
  totalUnits: number;
  completedUnits: number;
  baselineRate: number | undefined;
  baselineSampleCount: number;
  liveRate: number | undefined;
  liveSamples: number;
  poolConcurrency: number;
  pendingTaskCount: number;
}

export interface EtaBaselineSummary {
  readonly hostKey: string;
  readonly coldStart: boolean;
  readonly loadedBuckets: number;
  readonly totalBaselineSamples: number;
}

interface ActiveTaskRecord {
  readonly taskId: string;
  readonly workType: EtaWorkType;
  readonly profile: EtaChannelProfile;
  readonly bucketKey: EtaBucketKey;
  readonly totalUnits: number;
  readonly startMs: number;
  readonly context: EtaFfmpegSpeedContext;
  inFlightUnits: number;
  state: 'active' | 'completed' | 'skipped';
}

/**
 * Resolves a stable per-server key from `SERVER_ID` or deterministic hardware traits
 * so Docker container recreations retain history and Windows dev never pollutes NAS baselines.
 */
function resolveHostKey(serverId?: string): string {
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

/** Coordinates stage-aware ETA inventory, live EMA calibration, and batched SQLite persistence. */
export class EtaPredictor {
  readonly #db: ScanCacheDb | null;
  readonly #hostKey: string;
  readonly #now: () => number;
  readonly #buckets = new Map<EtaBucketKey, MutableBucket>();
  readonly #tasks = new Map<string, ActiveTaskRecord>();
  readonly #pendingFollowupStages = new Set<EtaWorkType>();
  readonly #pendingFlush: EtaSampleInput[] = [];
  #activeWorkType: EtaWorkType | undefined;

  public constructor(options: {
    readonly db?: ScanCacheDb | null;
    readonly serverId?: string;
    readonly now?: () => number;
  }) {
    this.#db = options.db ?? null;
    this.#hostKey = resolveHostKey(options.serverId);
    this.#now = options.now ?? (() => performance.now());
  }

  public get hostKey(): string {
    return this.#hostKey;
  }

  public hasColdStartBuckets(): boolean {
    for (const bucket of this.#buckets.values()) {
      if (bucket.totalUnits > 0 && bucket.baselineRate === undefined) {
        return true;
      }
    }
    return false;
  }

  public getBaselineSummary(): EtaBaselineSummary {
    let loadedBuckets = 0;
    let totalBaselineSamples = 0;
    for (const bucket of this.#buckets.values()) {
      if (bucket.baselineRate !== undefined) {
        loadedBuckets += 1;
        totalBaselineSamples += bucket.baselineSampleCount;
      }
    }
    return {
      hostKey: this.#hostKey,
      coldStart: this.hasColdStartBuckets(),
      loadedBuckets,
      totalBaselineSamples
    };
  }

  public formatBaselineSummaryLog(): string {
    const summary = this.getBaselineSummary();
    return `ETA calibrator: host=${summary.hostKey}, coldStart=${String(summary.coldStart)}, buckets=${String(summary.loadedBuckets)}, samples=${String(summary.totalBaselineSamples)}`;
  }

  public markStagePending(workType: EtaWorkType): void {
    this.#pendingFollowupStages.add(workType);
  }

  public setActiveStage(workType: EtaWorkType | undefined): void {
    this.#activeWorkType = workType;
  }

  public initStageInventory(
    workType: EtaWorkType,
    entries: readonly EtaInventoryEntry[],
    poolConcurrency: number
  ): void {
    this.#upsertStageBuckets(workType, entries, poolConcurrency, true);
  }

  public reconcileStage(
    workType: EtaWorkType,
    entries: readonly EtaInventoryEntry[],
    poolConcurrency?: number
  ): void {
    this.#upsertStageBuckets(workType, entries, poolConcurrency, false);
  }

  #upsertStageBuckets(
    workType: EtaWorkType,
    entries: readonly EtaInventoryEntry[],
    poolConcurrency: number | undefined,
    overwriteExisting: boolean
  ): void {
    this.#pendingFollowupStages.delete(workType);
    for (const [profile, totals] of this.#aggregateEntries(entries).entries()) {
      const key = buildEtaBucketKey(workType, profile);
      const existing = overwriteExisting ? undefined : this.#buckets.get(key);
      if (existing) {
        existing.totalUnits = totals.units;
        existing.pendingTaskCount = totals.tasks;
        if (poolConcurrency !== undefined) {
          existing.poolConcurrency = Math.max(1, poolConcurrency);
        }
      } else {
        this.#buckets.set(
          key,
          this.#createBucket(workType, profile, totals.units, totals.tasks, poolConcurrency ?? 1)
        );
      }
    }
  }

  public startTask(
    taskId: string,
    workType: EtaWorkType,
    profile: EtaChannelProfile,
    totalUnits: number,
    context: EtaFfmpegSpeedContext = {}
  ): void {
    const existing = this.#tasks.get(taskId);
    if (existing) {
      return;
    }
    const key = buildEtaBucketKey(workType, profile);
    if (!this.#buckets.has(key) && totalUnits > 0) {
      this.#buckets.set(key, this.#createBucket(workType, profile, totalUnits, 1, 1));
    }
    this.#tasks.set(taskId, {
      taskId,
      workType,
      profile,
      bucketKey: key,
      totalUnits: Math.max(0, totalUnits),
      startMs: this.#now(),
      context,
      inFlightUnits: 0,
      state: 'active'
    });
  }

  public recordTaskProgress(
    taskId: string,
    completedUnits: number,
    liveSpeed?: number,
    outTimeSec?: number
  ): void {
    const task = this.#tasks.get(taskId);
    if (!task || task.state !== 'active') {
      return;
    }
    if (Number.isFinite(completedUnits)) {
      task.inFlightUnits = Math.min(task.totalUnits, Math.max(0, completedUnits));
    }
    const elapsedSec = Math.max(0, (this.#now() - task.startMs) / MS_PER_SECOND);
    if (isFfmpegSpeedWarm(liveSpeed, outTimeSec, elapsedSec)) {
      const converted = convertFfmpegSpeedToRate(task.workType, liveSpeed, task.context);
      const bucket = this.#buckets.get(task.bucketKey);
      if (converted !== undefined && bucket) {
        bucket.liveRate = updateEmaRate(bucket.liveRate, converted, ETA_EMA_ALPHA);
        bucket.liveSamples += 1;
      }
    }
  }

  public completeTask(taskId: string): void {
    const task = this.#tasks.get(taskId);
    if (!task || task.state !== 'active') {
      return;
    }
    task.state = 'completed';
    task.inFlightUnits = 0;
    const elapsedMs = Math.max(0, this.#now() - task.startMs);
    const bucket = this.#buckets.get(task.bucketKey);
    if (bucket) {
      bucket.completedUnits += task.totalUnits;
      bucket.pendingTaskCount = Math.max(0, bucket.pendingTaskCount - 1);
      if (task.totalUnits > 0 && elapsedMs >= ETA_MIN_SAMPLE_MS) {
        const rate = task.totalUnits / (elapsedMs / MS_PER_SECOND);
        if (Number.isFinite(rate) && rate > 0) {
          bucket.liveRate = updateEmaRate(bucket.liveRate, rate, ETA_EMA_ALPHA);
          bucket.liveSamples += 1;
          this.#pendingFlush.push({
            hostKey: this.#hostKey,
            workType: task.workType,
            profile: task.profile,
            throughput: rate,
            workUnits: task.totalUnits,
            durationMs: Math.round(elapsedMs)
          });
          if (this.#pendingFlush.length >= ETA_FLUSH_BATCH_SIZE) {
            this.flush();
          }
        }
      }
      this.#advanceActiveStageIfExhausted();
    }
  }

  public skipTask(
    taskId: string,
    workType?: EtaWorkType,
    profile?: EtaChannelProfile,
    units?: number
  ): void {
    const task = this.#tasks.get(taskId);
    if (task) {
      if (task.state !== 'active') {
        return;
      }
      task.state = 'skipped';
      task.inFlightUnits = 0;
      this.#decrementBucketPending(this.#buckets.get(task.bucketKey), task.totalUnits);
      return;
    }
    if (workType && profile && units !== undefined && units > 0) {
      this.#decrementBucketPending(this.#buckets.get(buildEtaBucketKey(workType, profile)), units);
    }
  }

  public getEstimate(): EtaEstimate {
    const inFlightByBucket = new Map<EtaBucketKey, number>();
    for (const task of this.#tasks.values()) {
      if (task.state === 'active' && task.inFlightUnits > 0) {
        inFlightByBucket.set(
          task.bucketKey,
          (inFlightByBucket.get(task.bucketKey) ?? 0) + task.inFlightUnits
        );
      }
    }

    const bucketStates: EtaBucketState[] = [];
    for (const [key, bucket] of this.#buckets.entries()) {
      bucketStates.push({
        workType: bucket.workType,
        profile: bucket.profile,
        totalUnits: bucket.totalUnits,
        completedUnits: bucket.completedUnits,
        inFlightUnits: inFlightByBucket.get(key) ?? 0,
        baselineRate: bucket.baselineRate,
        liveRate: bucket.liveRate,
        liveSamples: bucket.liveSamples,
        poolConcurrency: bucket.poolConcurrency,
        activeOrPendingTasks: Math.max(1, bucket.pendingTaskCount)
      });
    }

    return computeStageAwareEta({
      buckets: bucketStates,
      activeWorkType: this.#activeWorkType,
      pendingFollowupStages: this.#pendingFollowupStages.size
    });
  }

  public flush(): void {
    if (!this.#db || this.#pendingFlush.length === 0) {
      return;
    }
    const batch = this.#pendingFlush.splice(0);
    this.#db.recordEtaSamplesBatch(batch);
  }

  #aggregateEntries(
    entries: readonly EtaInventoryEntry[]
  ): Map<EtaChannelProfile, { units: number; tasks: number }> {
    const aggregated = new Map<EtaChannelProfile, { units: number; tasks: number }>();
    for (const entry of entries) {
      if (!Number.isFinite(entry.units) || entry.units <= 0) {
        continue;
      }
      const prev = aggregated.get(entry.profile) ?? { units: 0, tasks: 0 };
      aggregated.set(entry.profile, {
        units: prev.units + entry.units,
        tasks: prev.tasks + Math.max(1, entry.taskCount ?? 1)
      });
    }
    return aggregated;
  }

  #createBucket(
    workType: EtaWorkType,
    profile: EtaChannelProfile,
    totalUnits: number,
    pendingTaskCount: number,
    poolConcurrency: number
  ): MutableBucket {
    const baseline = this.#loadBaseline(workType, profile);
    return {
      workType,
      profile,
      totalUnits,
      completedUnits: 0,
      baselineRate: baseline.rate,
      baselineSampleCount: baseline.sampleCount,
      liveRate: undefined,
      liveSamples: 0,
      poolConcurrency: Math.max(1, poolConcurrency),
      pendingTaskCount
    };
  }

  #decrementBucketPending(bucket: MutableBucket | undefined, units: number): void {
    if (!bucket) {
      return;
    }
    bucket.totalUnits = Math.max(bucket.completedUnits, bucket.totalUnits - units);
    bucket.pendingTaskCount = Math.max(0, bucket.pendingTaskCount - 1);
    this.#advanceActiveStageIfExhausted();
  }

  #advanceActiveStageIfExhausted(): void {
    if (!this.#activeWorkType) {
      return;
    }
    let currentHasRemaining = false;
    let nextStage: EtaWorkType | undefined;
    for (const bucket of this.#buckets.values()) {
      const remaining = Math.max(0, bucket.totalUnits - bucket.completedUnits);
      if (remaining <= 0) {
        continue;
      }
      if (bucket.workType === this.#activeWorkType) {
        currentHasRemaining = true;
      } else if (!nextStage) {
        nextStage = bucket.workType;
      }
    }
    if (!currentHasRemaining && nextStage) {
      this.#activeWorkType = nextStage;
    }
  }

  #loadBaseline(
    workType: EtaWorkType,
    profile: EtaChannelProfile
  ): { readonly rate: number | undefined; readonly sampleCount: number } {
    if (!this.#db) {
      return { rate: undefined, sampleCount: 0 };
    }
    const samples = this.#db.getEtaSamples(this.#hostKey, workType, profile);
    return { rate: computeTrimmedMedian(samples), sampleCount: samples.length };
  }
}
