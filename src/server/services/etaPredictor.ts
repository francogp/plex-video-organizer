import { ETA_EMA_ALPHA, ETA_FLUSH_BATCH_SIZE, ETA_MIN_SAMPLE_MS } from '../../domain/constants.ts';
import {
  buildEtaBucketKey,
  buildEtaStageId,
  buildEtaStageStepId,
  computeQueueEta,
  computeTrimmedMedian,
  convertFfmpegSpeedToRate,
  isFfmpegSpeedWarm,
  updateEmaRate,
  type EtaBucketKey,
  type EtaEstimate,
  type EtaFfmpegSpeedContext,
  type EtaQueueComputationResult,
  type EtaQueueItemState,
  type EtaRateEntry
} from '../../domain/eta.ts';
import type {
  EtaChannelProfile,
  EtaSimulationMode,
  EtaSimulationSnapshot,
  EtaStepId,
  EtaWorkType,
  ItemId
} from '../../domain/types.ts';
import { resolveHostKey } from '../config.ts';
import type { EtaSampleInput, ScanCacheDb } from './scanCacheDb.ts';

const MS_PER_SECOND = 1000;

export interface EtaInventoryEntry {
  readonly profile: EtaChannelProfile;
  readonly units: number;
  readonly taskCount?: number;
}

export interface EtaQueueStepInput {
  readonly stepId: EtaStepId;
  readonly workType: EtaWorkType;
  readonly profile: EtaChannelProfile;
  readonly totalUnits: number;
  readonly parallelTracks?: number;
}

export interface EtaQueuePlanItemInput {
  readonly itemId: ItemId;
  readonly fileName: string;
  readonly steps: readonly EtaQueueStepInput[];
}

export interface EtaTaskBinding {
  readonly itemId?: ItemId;
  readonly stepId?: EtaStepId;
  readonly slot?: number;
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

interface MutableQueueStep {
  readonly stepId: EtaStepId;
  readonly workType: EtaWorkType;
  readonly profile: EtaChannelProfile;
  readonly totalUnits: number;
  readonly parallelTracks: number;
  completedUnits: number;
}

interface MutableQueueItem {
  readonly itemId: ItemId;
  readonly fileName: string;
  readonly steps: MutableQueueStep[];
  activeSlot: number | undefined;
  completed: boolean;
  skipped: boolean;
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
  readonly itemId: ItemId | undefined;
  readonly stepId: EtaStepId | undefined;
  inFlightUnits: number;
  skippedBucketUnits: number;
  state: 'active' | 'completed' | 'skipped';
}

interface HostBaselineEntry {
  readonly workType: EtaWorkType;
  readonly profile: EtaChannelProfile;
  readonly rate: number;
  readonly sampleCount: number;
}

/** Coordinates queue/stage ETA simulation, live EMA calibration, and batched SQLite persistence. */
export class EtaPredictor {
  readonly #db: ScanCacheDb | null;
  readonly #hostKey: string;
  readonly #now: () => number;
  readonly #buckets = new Map<EtaBucketKey, MutableBucket>();
  readonly #hostBaselines = new Map<EtaBucketKey, HostBaselineEntry>();
  readonly #tasks = new Map<string, ActiveTaskRecord>();
  readonly #pendingFollowupStages = new Set<EtaWorkType>();
  readonly #pendingFlush: EtaSampleInput[] = [];
  readonly #queueItems: MutableQueueItem[] = [];
  readonly #queueItemById = new Map<ItemId, MutableQueueItem>();
  #queueWorkerCount = 0;
  #activeWorkType: EtaWorkType | undefined;

  public constructor(options: {
    readonly db?: ScanCacheDb | null;
    readonly serverId?: string;
    readonly now?: () => number;
  }) {
    this.#db = options.db ?? null;
    this.#hostKey = resolveHostKey(options.serverId);
    this.#now = options.now ?? (() => performance.now());
    this.#preloadHostBaselines();
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

  /** Initializes a full item/step simulation plan for multi-stage queue processing. */
  public initQueuePlan(items: readonly EtaQueuePlanItemInput[], workerCount: number): void {
    this.#queueItems.length = 0;
    this.#queueItemById.clear();
    this.#queueWorkerCount = Math.max(1, Math.floor(workerCount));
    this.#buckets.clear();
    this.#pendingFollowupStages.clear();

    const totalsByBucket = new Map<
      EtaBucketKey,
      { workType: EtaWorkType; profile: EtaChannelProfile; units: number; tasks: number }
    >();

    for (const input of items) {
      const steps: MutableQueueStep[] = input.steps.map((step) => {
        const key = buildEtaBucketKey(step.workType, step.profile);
        const prev = totalsByBucket.get(key) ?? {
          workType: step.workType,
          profile: step.profile,
          units: 0,
          tasks: 0
        };
        prev.units += Math.max(0, step.totalUnits);
        prev.tasks += 1;
        totalsByBucket.set(key, prev);
        return {
          stepId: step.stepId,
          workType: step.workType,
          profile: step.profile,
          totalUnits: Math.max(0, step.totalUnits),
          parallelTracks: Math.max(1, step.parallelTracks ?? 1),
          completedUnits: 0
        };
      });
      const item: MutableQueueItem = {
        itemId: input.itemId,
        fileName: input.fileName,
        steps,
        activeSlot: undefined,
        completed: false,
        skipped: false
      };
      this.#queueItems.push(item);
      this.#queueItemById.set(input.itemId, item);
    }

    for (const [key, totals] of totalsByBucket.entries()) {
      this.#buckets.set(
        key,
        this.#createBucket(
          totals.workType,
          totals.profile,
          totals.units,
          totals.tasks,
          this.#queueWorkerCount
        )
      );
    }
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

  public startTask(
    taskId: string,
    workType: EtaWorkType,
    profile: EtaChannelProfile,
    totalUnits: number,
    context: EtaFfmpegSpeedContext = {},
    binding?: EtaTaskBinding
  ): void {
    const existing = this.#tasks.get(taskId);
    if (existing) {
      return;
    }
    const key = buildEtaBucketKey(workType, profile);
    if (!this.#buckets.has(key) && totalUnits > 0) {
      this.#buckets.set(key, this.#createBucket(workType, profile, totalUnits, 1, 1));
    }
    if (binding?.itemId !== undefined && binding.slot !== undefined) {
      const queueItem = this.#queueItemById.get(binding.itemId);
      if (queueItem) {
        queueItem.activeSlot = binding.slot;
      }
    }
    this.#tasks.set(taskId, {
      taskId,
      workType,
      profile,
      bucketKey: key,
      totalUnits: Math.max(0, totalUnits),
      startMs: this.#now(),
      context,
      itemId: binding?.itemId,
      stepId: binding?.stepId,
      inFlightUnits: 0,
      skippedBucketUnits: 0,
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

  #finishTaskStep(
    task: ActiveTaskRecord,
    nextState: 'completed' | 'skipped'
  ): MutableBucket | undefined {
    task.state = nextState;
    task.inFlightUnits = 0;
    const step = this.#findQueueStep(task.itemId, task.stepId);
    if (step) {
      step.completedUnits = Math.min(step.totalUnits, step.completedUnits + task.totalUnits);
    }
    return this.#buckets.get(task.bucketKey);
  }

  public completeTask(taskId: string): void {
    const task = this.#tasks.get(taskId);
    if (!task || task.state !== 'active') {
      return;
    }
    const elapsedMs = Math.max(0, this.#now() - task.startMs);
    const bucket = this.#finishTaskStep(task, 'completed');
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
      const bucket = this.#finishTaskStep(task, 'skipped');
      const prevTotal = bucket?.totalUnits ?? 0;
      this.#decrementBucketPending(bucket, task.totalUnits);
      if (bucket) {
        task.skippedBucketUnits = Math.max(0, prevTotal - bucket.totalUnits);
      }
      return;
    }
    if (workType && profile && units !== undefined && units > 0) {
      this.#decrementBucketPending(this.#buckets.get(buildEtaBucketKey(workType, profile)), units);
    }
  }

  public markItemCompleted(itemId: ItemId): void {
    const item = this.#queueItemById.get(itemId);
    if (!item) {
      return;
    }
    item.completed = true;
    item.activeSlot = undefined;
    for (const step of item.steps) {
      step.completedUnits = step.totalUnits;
    }
  }

  #clearItemTasks(itemId: ItemId, rollbackForRetry: boolean): void {
    for (const [taskId, task] of this.#tasks.entries()) {
      if (task.itemId !== itemId) {
        continue;
      }
      if (rollbackForRetry) {
        const bucket = this.#buckets.get(task.bucketKey);
        if (bucket) {
          if (task.state === 'completed') {
            bucket.completedUnits = Math.max(0, bucket.completedUnits - task.totalUnits);
            bucket.pendingTaskCount += 1;
          } else if (task.state === 'skipped') {
            bucket.totalUnits += task.skippedBucketUnits;
            bucket.pendingTaskCount += 1;
          }
        }
      } else if (task.state === 'active') {
        this.skipTask(taskId);
      }
      this.#tasks.delete(taskId);
    }
  }

  public markItemSkipped(itemId: ItemId): void {
    const item = this.#queueItemById.get(itemId);
    if (!item || item.skipped) {
      this.#clearItemTasks(itemId, false);
      return;
    }
    this.#clearItemTasks(itemId, false);
    if (!item.completed) {
      for (const step of item.steps) {
        const unstarted = Math.max(0, step.totalUnits - step.completedUnits);
        if (unstarted > 0) {
          const bucket = this.#buckets.get(buildEtaBucketKey(step.workType, step.profile));
          this.#decrementBucketPending(bucket, unstarted);
          step.completedUnits = step.totalUnits;
        }
      }
    }
    item.skipped = true;
    item.activeSlot = undefined;
  }

  public resetItemForRetry(itemId: ItemId): void {
    this.#clearItemTasks(itemId, true);
    const item = this.#queueItemById.get(itemId);
    if (!item) {
      return;
    }
    item.activeSlot = undefined;
    for (const step of item.steps) {
      step.completedUnits = 0;
    }
  }

  public getEstimate(): EtaEstimate {
    const { result } = this.#computeSimulation(this.#queueWorkerCount === 0);
    return {
      etaSeconds: result.etaSeconds,
      etaState: result.etaState,
      weightedFraction: result.weightedFraction
    };
  }

  /** Builds a full structured ETA simulation snapshot for the live UI modal (`GET /api/eta/simulation`). */
  public getSimulationSnapshot(
    mode: EtaSimulationMode,
    nowMs = Temporal.Now.instant().epochMilliseconds
  ): EtaSimulationSnapshot {
    const useStageMode = this.#queueWorkerCount === 0 && mode === 'scanning';
    const { workerCount, result } = this.#computeSimulation(useStageMode);
    return {
      generatedAtMs: nowMs,
      hostKey: this.#hostKey,
      mode,
      workerCount,
      etaSeconds: result.etaSeconds,
      etaState: result.etaState,
      weightedFraction: result.weightedFraction,
      fallbackShare: result.fallbackShare,
      rates: result.rates,
      slots: result.slots
    };
  }

  public flush(): void {
    if (!this.#db || this.#pendingFlush.length === 0) {
      return;
    }
    const batch = this.#pendingFlush.splice(0);
    this.#db.recordEtaSamplesBatch(batch);
  }

  #preloadHostBaselines(): void {
    if (!this.#db) {
      return;
    }
    const groups = this.#db.getAllEtaSamplesForHost(this.#hostKey);
    for (const group of groups) {
      const rate = computeTrimmedMedian(group.samples);
      if (rate !== undefined && rate > 0) {
        const key = buildEtaBucketKey(group.workType, group.profile);
        this.#hostBaselines.set(key, {
          workType: group.workType,
          profile: group.profile,
          rate,
          sampleCount: group.samples.length
        });
      }
    }
  }

  #buildRateIndex(): ReadonlyMap<EtaBucketKey, EtaRateEntry> {
    const index = new Map<EtaBucketKey, EtaRateEntry>();
    for (const [key, baseline] of this.#hostBaselines.entries()) {
      index.set(key, {
        workType: baseline.workType,
        profile: baseline.profile,
        baselineRate: baseline.rate,
        baselineSampleCount: baseline.sampleCount,
        liveSamples: 0,
        observedFraction: 0
      });
    }
    const inFlightByBucket = this.#collectInFlightByBucket();
    for (const [key, bucket] of this.#buckets.entries()) {
      const observedUnits = bucket.completedUnits + (inFlightByBucket.get(key) ?? 0);
      const observedFraction = bucket.totalUnits > 0 ? observedUnits / bucket.totalUnits : 0;
      const existing = index.get(key);
      index.set(key, {
        workType: bucket.workType,
        profile: bucket.profile,
        baselineRate: bucket.baselineRate ?? existing?.baselineRate,
        baselineSampleCount: bucket.baselineSampleCount || (existing?.baselineSampleCount ?? 0),
        liveRate: bucket.liveRate,
        liveSamples: bucket.liveSamples,
        observedFraction
      });
    }
    return index;
  }

  #collectInFlightByBucket(): Map<EtaBucketKey, number> {
    const inFlightByBucket = new Map<EtaBucketKey, number>();
    for (const task of this.#tasks.values()) {
      if (task.state === 'active' && task.inFlightUnits > 0) {
        inFlightByBucket.set(
          task.bucketKey,
          (inFlightByBucket.get(task.bucketKey) ?? 0) + task.inFlightUnits
        );
      }
    }
    return inFlightByBucket;
  }

  #buildQueueStates(): readonly EtaQueueItemState[] {
    const inFlightByStep = new Map<string, number>();
    for (const task of this.#tasks.values()) {
      if (task.state === 'active' && task.itemId && task.stepId && task.inFlightUnits > 0) {
        const key = `${task.itemId}::${task.stepId}`;
        inFlightByStep.set(key, (inFlightByStep.get(key) ?? 0) + task.inFlightUnits);
      }
    }

    return this.#queueItems.map((item) => ({
      itemId: item.itemId,
      fileName: item.fileName,
      activeSlot: item.activeSlot,
      completed: item.completed,
      skipped: item.skipped,
      steps: item.steps.map((step) => ({
        stepId: step.stepId,
        workType: step.workType,
        profile: step.profile,
        totalUnits: step.totalUnits,
        completedUnits: step.completedUnits,
        inFlightUnits: inFlightByStep.get(`${item.itemId}::${step.stepId}`) ?? 0,
        parallelTracks: step.parallelTracks
      }))
    }));
  }

  #computeSimulation(useStageMode: boolean): {
    readonly workerCount: number;
    readonly result: EtaQueueComputationResult;
  } {
    const rateIndex = this.#buildRateIndex();
    if (!useStageMode) {
      const workerCount = Math.max(1, this.#queueWorkerCount);
      return {
        workerCount,
        result: computeQueueEta({
          items: this.#buildQueueStates(),
          workerCount,
          rateIndex,
          pendingFollowupStages: 0
        })
      };
    }
    const stage = this.#buildStageQueueStates();
    return {
      workerCount: stage.workerCount,
      result: computeQueueEta({
        items: stage.items,
        workerCount: stage.workerCount,
        rateIndex,
        pendingFollowupStages: this.#pendingFollowupStages.size
      })
    };
  }

  #buildStageQueueStates(): {
    readonly items: readonly EtaQueueItemState[];
    readonly workerCount: number;
  } {
    let maxPoolConcurrency = 1;
    for (const bucket of this.#buckets.values()) {
      if (bucket.poolConcurrency > maxPoolConcurrency) {
        maxPoolConcurrency = bucket.poolConcurrency;
      }
    }
    const workerCount = Math.max(1, maxPoolConcurrency);
    const inFlightByBucket = this.#collectInFlightByBucket();

    const slicesList: Array<{
      readonly state: Omit<EtaQueueItemState, 'activeSlot'>;
      readonly isActiveStage: boolean;
      readonly isCompleted: boolean;
      readonly hasInFlight: boolean;
      readonly remainingUnits: number;
      activeSlot?: number;
    }> = [];

    for (const [key, bucket] of this.#buckets.entries()) {
      const slices =
        bucket.workType === 'finalize_io'
          ? 1
          : Math.max(1, Math.min(bucket.poolConcurrency, Math.max(1, bucket.pendingTaskCount)));
      const inFlight = inFlightByBucket.get(key) ?? 0;
      const isCompleted = bucket.totalUnits > 0 && bucket.completedUnits >= bucket.totalUnits;
      const isActiveStage = bucket.workType === this.#activeWorkType;
      const totalUnits = bucket.totalUnits / slices;
      const completedUnits = bucket.completedUnits / slices;
      const inFlightUnits = inFlight / slices;
      const remainingUnits = isCompleted
        ? 0
        : Math.max(0, totalUnits - completedUnits - inFlightUnits);

      for (let sliceIdx = 0; sliceIdx < slices; sliceIdx += 1) {
        slicesList.push({
          state: {
            itemId: buildEtaStageId(bucket.workType, bucket.profile, sliceIdx),
            fileName:
              slices > 1
                ? `${bucket.workType} (${bucket.profile}) · #${String(sliceIdx + 1)}`
                : `${bucket.workType} (${bucket.profile})`,
            completed: isCompleted,
            skipped: false,
            steps: [
              {
                stepId: buildEtaStageStepId(bucket.workType, bucket.profile, sliceIdx),
                workType: bucket.workType,
                profile: bucket.profile,
                totalUnits,
                completedUnits,
                inFlightUnits,
                parallelTracks: 1
              }
            ]
          },
          isActiveStage,
          isCompleted,
          hasInFlight: inFlightUnits > 0,
          remainingUnits
        });
      }
    }

    const activeCandidates = slicesList
      .filter((slice) => slice.isActiveStage && !slice.isCompleted)
      .toSorted((a, b) => {
        if (a.hasInFlight !== b.hasInFlight) {
          return Number(b.hasInFlight) - Number(a.hasInFlight);
        }
        return b.remainingUnits - a.remainingUnits;
      });
    for (let slotIdx = 0; slotIdx < Math.min(workerCount, activeCandidates.length); slotIdx += 1) {
      activeCandidates[slotIdx]!.activeSlot = slotIdx;
    }

    const items: EtaQueueItemState[] = slicesList.map((slice) => ({
      ...slice.state,
      activeSlot: slice.activeSlot
    }));

    return { items, workerCount };
  }

  #findQueueStep(itemId?: ItemId, stepId?: EtaStepId): MutableQueueStep | undefined {
    if (!itemId || !stepId) {
      return undefined;
    }
    const item = this.#queueItemById.get(itemId);
    return item?.steps.find((s) => s.stepId === stepId);
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
    const baseline = this.#hostBaselines.get(buildEtaBucketKey(workType, profile));
    return {
      workType,
      profile,
      totalUnits,
      completedUnits: 0,
      baselineRate: baseline?.rate,
      baselineSampleCount: baseline?.sampleCount ?? 0,
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
}
