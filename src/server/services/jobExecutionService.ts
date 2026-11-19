import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runSlotWorkerPool } from '../../domain/concurrency.ts';
import { PROCESS_JOB_CONCURRENCY } from '../../domain/constants.ts';
import {
  buildEtaAttemptTaskId,
  buildEtaStepId,
  computeLinearFallbackEta,
  resolveChannelProfile
} from '../../domain/eta.ts';
import {
  collectActiveTasks,
  type ActiveParallelTask,
  type ConflictDecision,
  type EtaChannelProfile,
  type EtaSimulationSnapshot,
  type EtaState,
  type EtaWorkType,
  type ItemId,
  type JobId,
  type JobItemError,
  type JobRetryAttempt,
  type JobStageKind,
  type LogLevel,
  type ScannedItem,
  type SseProgressEvent
} from '../../domain/types.ts';
import {
  buildMountPathsMap,
  resolvePortableInputPath,
  resolveServerTag,
  type AppConfig
} from '../config.ts';
import {
  EtaPredictor,
  type EtaQueuePlanItemInput,
  type EtaQueueStepInput
} from './etaPredictor.ts';
import {
  backupAndCleanupAfterJob,
  buildOrganizingTempFileName,
  cleanupOrphanTempFiles,
  moveTempOutputFile,
  purgeExpiredBackups
} from './fileMover.ts';
import {
  buildFfmpegRemuxArgs,
  measureLoudnormPass1,
  normalizeSubtitleToUtf8,
  probeMedia,
  runFfmpegRemux,
  type LoudnormMeasurements
} from './media/ffmpegRunner.ts';
import { openScanCacheDb } from './scanCacheDb.ts';

const PERCENT_MAX = 100;
const LOUDNORM_PASS1_WEIGHT = 0.45;
const REMUX_WITH_LOUDNORM_WEIGHT = 0.45;
const REMUX_ONLY_WEIGHT = 0.9;
const VERIFY_STAGE_FRACTION = 0.9;
const MOVE_STAGE_WEIGHT = 0.1;
const MS_PER_SECOND = 1000;

type ProcessItemStage = Extract<JobStageKind, 'remuxing' | 'verifying' | 'moving' | 'cleanup'>;

export interface ExecuteMoveJobOptions {
  readonly config: AppConfig;
  readonly jobId: JobId;
  readonly toProcess: readonly ScannedItem[];
  readonly projectedByItemId: Readonly<Partial<Record<ItemId, string>>>;
  readonly conflictResolutions: Readonly<Partial<Record<ItemId, ConflictDecision>>>;
  readonly existingCollisionByItemId: Readonly<Partial<Record<ItemId, string>>>;
  readonly isCancelled: () => boolean;
  readonly isDraining?: () => boolean;
  readonly createChildTracker: () => (child: ChildProcess | null) => void;
  readonly etaPredictor?: EtaPredictor;
  readonly onLog: (level: LogLevel, message: string) => void;
  readonly onProgress: (progress: SseProgressEvent) => void;
  readonly onFinalizeMovedItems: (movedItems: readonly ScannedItem[]) => Promise<void>;
  readonly onComplete: (
    movedCount: number,
    attemptErrors: readonly JobItemError[]
  ) => Promise<void>;
  readonly onError: (message: string) => Promise<void>;
}

function isSameResolvedPath(leftPath: string, rightPath: string): boolean {
  const left = path.resolve(leftPath);
  const right = path.resolve(rightPath);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

const FINALIZE_PROGRESS_MOVE_WEIGHT = 0.7;

function resolveDominantAudioProfile(item: ScannedItem): EtaChannelProfile {
  const includedTracks = item.trackSelection.audioTracks.filter((t) => t.include);
  const streamByOrder = new Map(item.probe.audioStreams.map((s) => [s.streamOrder, s]));
  let maxChannels = 0;
  for (const track of includedTracks) {
    const ch = streamByOrder.get(track.streamOrder)?.channels ?? 0;
    if (ch > maxChannels) {
      maxChannels = ch;
    }
  }
  return resolveChannelProfile(maxChannels > 0 ? maxChannels : undefined);
}

function resolveTrackChannelProfile(
  streamByOrder: ReadonlyMap<number, ScannedItem['probe']['audioStreams'][number]>,
  streamOrder: number
): EtaChannelProfile {
  return resolveChannelProfile(streamByOrder.get(streamOrder)?.channels);
}

function resolveRemuxSpec(item: ScannedItem): {
  readonly workType: Extract<EtaWorkType, 'remux_loudnorm' | 'remux_peak_gain' | 'remux_copy'>;
  readonly profile: EtaChannelProfile;
  readonly totalUnits: number;
  readonly trackCount: number;
} {
  const mode = item.trackSelection.audioNormalization?.mode ?? 'copy';
  const includedTracks = item.trackSelection.audioTracks.filter((t) => t.include);
  const trackCount = Math.max(1, includedTracks.length);
  const durationSec = Math.max(1, item.probe.durationSeconds);
  const sizeBytes = Math.max(1, item.probe.sizeBytes);
  const profile = resolveDominantAudioProfile(item);
  if (mode === 'loudnorm') {
    return {
      workType: 'remux_loudnorm',
      profile,
      totalUnits: durationSec * trackCount,
      trackCount
    };
  }
  if (mode === 'peak') {
    return {
      workType: 'remux_peak_gain',
      profile,
      totalUnits: durationSec * trackCount,
      trackCount
    };
  }
  return { workType: 'remux_copy', profile: 'default', totalUnits: sizeBytes, trackCount };
}

/** Filters queue items eligible for processing, excluding ignored conflicts. */
export function selectProcessableQueueItems(
  items: readonly ScannedItem[],
  conflictResolutions: Readonly<Partial<Record<ItemId, ConflictDecision>>>
): readonly ScannedItem[] {
  return items.filter((item) => item.include && conflictResolutions[item.id] !== 'ignore');
}

/** Builds ordered step-by-step ETA plans for every item scheduled for processing. */
function buildProcessQueuePlan(
  toProcess: readonly ScannedItem[]
): readonly EtaQueuePlanItemInput[] {
  const cpuCount = Math.max(1, os.cpus().length);
  return toProcess.map((item): EtaQueuePlanItemInput => {
    const durationSec = Math.max(1, item.probe.durationSeconds);
    const sizeBytes = Math.max(1, item.probe.sizeBytes);
    const includedTracks = item.trackSelection.audioTracks.filter((t) => t.include);
    const steps: EtaQueueStepInput[] = [];

    if (item.trackSelection.audioNormalization?.mode === 'loudnorm' && includedTracks.length > 0) {
      steps.push({
        stepId: buildEtaStepId('p1', item.id),
        workType: 'loudnorm_p1',
        profile: resolveDominantAudioProfile(item),
        totalUnits: durationSec * includedTracks.length,
        parallelTracks: Math.min(includedTracks.length, cpuCount)
      });
    }

    const remux = resolveRemuxSpec(item);
    steps.push({
      stepId: buildEtaStepId('remux', item.id),
      workType: remux.workType,
      profile: remux.profile,
      totalUnits: remux.totalUnits,
      parallelTracks: 1
    });

    steps.push({
      stepId: buildEtaStepId('finalize', item.id),
      workType: 'finalize_io',
      profile: 'default',
      totalUnits: sizeBytes,
      parallelTracks: 1
    });

    return {
      itemId: item.id,
      fileName: item.fileName,
      steps
    };
  });
}

/** Projects an idle queue ETA simulation snapshot from host SQLite baselines. */
export async function buildIdleEtaSimulationSnapshot(options: {
  readonly configDir: string;
  readonly serverId?: string;
  readonly items: readonly ScannedItem[];
  readonly conflictResolutions: Readonly<Partial<Record<ItemId, ConflictDecision>>>;
  readonly onDbFallbackWarning?: (msg: string) => void;
}): Promise<EtaSimulationSnapshot> {
  const db = await openScanCacheDb(options.configDir, undefined, options.onDbFallbackWarning);
  try {
    const predictor = new EtaPredictor({ db, serverId: options.serverId });
    const processable = selectProcessableQueueItems(options.items, options.conflictResolutions);
    const workerCount = Math.min(PROCESS_JOB_CONCURRENCY, Math.max(1, processable.length));
    predictor.initQueuePlan(buildProcessQueuePlan(processable), workerCount);
    return predictor.getSimulationSnapshot('preview');
  } finally {
    db.close();
  }
}

async function measureLoudnormForItem(
  item: ScannedItem,
  slot: number,
  attempt: JobRetryAttempt,
  downmixStereo: boolean,
  isCancelled: () => boolean,
  createChildTracker: () => (child: ChildProcess | null) => void,
  onLog: (level: LogLevel, message: string) => void,
  etaPredictor?: EtaPredictor,
  onProgress?: (
    fraction: number,
    label: string,
    activeTrackTasks: readonly ActiveParallelTask[]
  ) => void
): Promise<ReadonlyMap<number, LoudnormMeasurements>> {
  onLog('info', `Measuring EBU R128 loudness (pass 1) for ${item.fileName}...`);
  const includedTracks = item.trackSelection.audioTracks.filter((t) => t.include);
  const measuredMap = new Map<number, LoudnormMeasurements>();
  if (includedTracks.length === 0) {
    return measuredMap;
  }

  const workerCount = Math.min(includedTracks.length, Math.max(1, os.cpus().length));
  const trackSlotTasks = Array.from<ActiveParallelTask | undefined>({ length: workerCount });
  const trackPercents = Array.from({ length: includedTracks.length }, (): number => 0);
  let completedTracks = 0;

  const emitPass1Progress = (): void => {
    const sumPct = trackPercents.reduce((acc, p): number => acc + p, 0);
    const fraction = Math.max(0, Math.min(1, sumPct / (includedTracks.length * PERCENT_MAX)));
    const label = `Loudnorm Pass 1/2 (${String(completedTracks)}/${String(includedTracks.length)} tracks)`;
    onProgress?.(fraction, label, collectActiveTasks(trackSlotTasks));
  };

  const streamByOrder = new Map(item.probe.audioStreams.map((s) => [s.streamOrder, s]));
  const durationSec = Math.max(1, item.probe.durationSeconds);

  await runSlotWorkerPool(
    includedTracks,
    workerCount,
    async (track, trackIdx, trackSlot) => {
      const trackLabel = `${item.fileName} · audio #${String(trackIdx + 1)} (${track.language})`;
      const p1StepId = buildEtaStepId('p1', item.id);
      const p1TaskId = buildEtaAttemptTaskId('p1', item.id, attempt, track.streamOrder);
      const trackProfile = resolveTrackChannelProfile(streamByOrder, track.streamOrder);
      etaPredictor?.startTask(
        p1TaskId,
        'loudnorm_p1',
        trackProfile,
        durationSec,
        {
          mediaDurationSec: durationSec,
          trackCount: 1
        },
        {
          itemId: item.id,
          stepId: p1StepId,
          slot
        }
      );
      trackSlotTasks[trackSlot] = {
        slot: trackSlot,
        itemId: item.id,
        fileName: trackLabel,
        percent: 0
      };
      emitPass1Progress();

      let measured: LoudnormMeasurements;
      try {
        measured = await measureLoudnormPass1(
          item.sourcePath,
          track.streamOrder,
          downmixStereo,
          item.probe.durationSeconds,
          (update): void => {
            if (isCancelled()) {
              return;
            }
            etaPredictor?.recordTaskProgress(
              p1TaskId,
              update.outTimeSec ?? (update.percent / PERCENT_MAX) * durationSec,
              update.speed,
              update.outTimeSec
            );
            trackPercents[trackIdx] = update.percent;
            trackSlotTasks[trackSlot] = {
              slot: trackSlot,
              itemId: item.id,
              fileName: trackLabel,
              percent: update.percent
            };
            emitPass1Progress();
          },
          createChildTracker()
        );
      } catch (err) {
        etaPredictor?.skipTask(p1TaskId);
        throw err;
      } finally {
        trackSlotTasks[trackSlot] = undefined;
      }
      if (isCancelled()) {
        etaPredictor?.skipTask(p1TaskId);
        return;
      }
      etaPredictor?.completeTask(p1TaskId);
      measuredMap.set(track.streamOrder, measured);
      completedTracks += 1;
      trackPercents[trackIdx] = PERCENT_MAX;
      emitPass1Progress();
    },
    isCancelled
  );
  return measuredMap;
}

async function pruneEmptyOldParentDirs(config: AppConfig, oldFilePath: string): Promise<void> {
  const maxPruneDepth = 2;
  const protectedRoots = Object.values(buildMountPathsMap(config));
  let current = path.resolve(path.dirname(oldFilePath));
  for (let depth = 0; depth < maxPruneDepth; depth += 1) {
    if (protectedRoots.some((root) => isSameResolvedPath(root, current))) {
      break;
    }
    try {
      await fs.rmdir(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

async function processSingleJobItem(options: {
  readonly config: AppConfig;
  readonly jobId: JobId;
  readonly attempt: JobRetryAttempt;
  readonly item: ScannedItem;
  readonly slot: number;
  readonly destPath: string;
  readonly allowOverwrite: boolean;
  readonly oldExistingPath: string | undefined;
  readonly createdTempSubs: string[];
  readonly isCancelled: () => boolean;
  readonly createChildTracker: () => (child: ChildProcess | null) => void;
  readonly etaPredictor?: EtaPredictor;
  readonly onLog: (level: LogLevel, message: string) => void;
  readonly onProgress: (
    slotTasks: ActiveParallelTask | readonly ActiveParallelTask[] | undefined,
    itemFraction: number,
    stage: ProcessItemStage,
    stageLabel: string
  ) => void;
}): Promise<ScannedItem | null> {
  const {
    config,
    jobId,
    attempt,
    item,
    slot,
    destPath,
    allowOverwrite,
    oldExistingPath,
    createdTempSubs,
    isCancelled,
    createChildTracker,
    etaPredictor,
    onLog,
    onProgress
  } = options;

  const resolvedSourcePath = await resolvePortableInputPath(
    config,
    item.sourcePath,
    item.relativePath
  );
  const resolvedSubByStoredPath = new Map<string, (typeof item.externalSubtitles)[number]>();
  const resolvedExternalSubtitles = await Promise.all(
    item.externalSubtitles.map(async (sub) => {
      const resolvedSubPath = await resolvePortableInputPath(config, sub.path, sub.relativePath);
      const resolvedSub = resolvedSubPath === sub.path ? sub : { ...sub, path: resolvedSubPath };
      resolvedSubByStoredPath.set(sub.path, resolvedSub);
      return resolvedSub;
    })
  );
  const resolvedItem: ScannedItem = {
    ...item,
    sourcePath: resolvedSourcePath,
    externalSubtitles: resolvedExternalSubtitles
  };

  const sourceDir = path.dirname(resolvedItem.sourcePath);
  const baseNoExt = path.basename(resolvedItem.sourcePath, path.extname(resolvedItem.sourcePath));
  const serverTag = resolveServerTag(config.serverId);
  const tempMkvPath = path.join(
    sourceDir,
    buildOrganizingTempFileName(baseNoExt, serverTag, jobId, resolvedItem.id)
  );

  const subInputs: {
    readonly sub: (typeof item.externalSubtitles)[number];
    readonly inputPath: string;
  }[] = [];
  for (const subPath of resolvedItem.trackSelection.externalSubtitleOrder) {
    const subObj = resolvedSubByStoredPath.get(subPath);
    if (!subObj) {
      continue;
    }
    const normalized = await normalizeSubtitleToUtf8(subObj, sourceDir);
    if (normalized.tempCreated) {
      createdTempSubs.push(normalized.tempCreated);
    }
    subInputs.push({ sub: subObj, inputPath: normalized.inputPath });
  }

  onProgress(
    { slot, itemId: resolvedItem.id, fileName: resolvedItem.fileName, percent: 0 },
    0,
    'remuxing',
    'Remuxing'
  );
  onLog('info', `Remuxing ${resolvedItem.fileName} -> ${path.basename(destPath)}`);

  const norm = resolvedItem.trackSelection.audioNormalization;
  const hasLoudnorm = norm?.mode === 'loudnorm';
  const remuxWeight = hasLoudnorm ? REMUX_WITH_LOUDNORM_WEIGHT : REMUX_ONLY_WEIGHT;
  const remuxOffset = hasLoudnorm ? LOUDNORM_PASS1_WEIGHT : 0;

  const loudnormByStreamOrder = hasLoudnorm
    ? await measureLoudnormForItem(
        resolvedItem,
        slot,
        attempt,
        norm.downmixStereo,
        isCancelled,
        createChildTracker,
        onLog,
        etaPredictor,
        (fraction, label, activeTrackTasks): void => {
          onProgress(activeTrackTasks, fraction * LOUDNORM_PASS1_WEIGHT, 'remuxing', label);
        }
      )
    : undefined;

  if (isCancelled()) {
    return null;
  }

  const remuxSpec = resolveRemuxSpec(resolvedItem);
  const remuxStepId = buildEtaStepId('remux', resolvedItem.id);
  const remuxTaskId = buildEtaAttemptTaskId('remux', resolvedItem.id, attempt);
  const finalizeStepId = buildEtaStepId('finalize', resolvedItem.id);
  const finalizeTaskId = buildEtaAttemptTaskId('finalize', resolvedItem.id, attempt);
  const durationSec = Math.max(1, resolvedItem.probe.durationSeconds);
  const sizeBytes = Math.max(1, resolvedItem.probe.sizeBytes);
  etaPredictor?.startTask(
    remuxTaskId,
    remuxSpec.workType,
    remuxSpec.profile,
    remuxSpec.totalUnits,
    {
      mediaDurationSec: durationSec,
      itemSizeBytes: sizeBytes,
      trackCount: remuxSpec.trackCount
    },
    {
      itemId: resolvedItem.id,
      stepId: remuxStepId,
      slot
    }
  );

  const remuxStageLabel = hasLoudnorm ? 'Loudnorm Pass 2/2 (Remuxing)' : 'Remuxing';
  const args = buildFfmpegRemuxArgs(resolvedItem, tempMkvPath, subInputs, loudnormByStreamOrder);
  try {
    await runFfmpegRemux(
      args,
      resolvedItem.probe.durationSeconds,
      (percent, _eta, update): void => {
        const completedUnits =
          remuxSpec.workType === 'remux_copy'
            ? (percent / PERCENT_MAX) * sizeBytes
            : (update?.outTimeSec ?? (percent / PERCENT_MAX) * durationSec) * remuxSpec.trackCount;
        etaPredictor?.recordTaskProgress(
          remuxTaskId,
          completedUnits,
          update?.speed,
          update?.outTimeSec
        );
        onProgress(
          {
            slot,
            itemId: resolvedItem.id,
            fileName: hasLoudnorm ? `${resolvedItem.fileName} · Pass 2/2` : resolvedItem.fileName,
            percent
          },
          remuxOffset + (percent / PERCENT_MAX) * remuxWeight,
          'remuxing',
          remuxStageLabel
        );
      },
      createChildTracker()
    );

    if (isCancelled()) {
      etaPredictor?.skipTask(remuxTaskId);
      return null;
    }
    etaPredictor?.completeTask(remuxTaskId);

    const destFileName = path.basename(destPath);
    etaPredictor?.startTask(
      finalizeTaskId,
      'finalize_io',
      'default',
      sizeBytes,
      { itemSizeBytes: sizeBytes },
      { itemId: resolvedItem.id, stepId: finalizeStepId, slot }
    );
    onProgress(
      { slot, itemId: resolvedItem.id, fileName: `${destFileName} · Verifying` },
      VERIFY_STAGE_FRACTION,
      'verifying',
      'Verifying'
    );
    onLog('info', `Verifying ${destFileName}...`);
    await probeMedia(tempMkvPath);

    onProgress(
      { slot, itemId: resolvedItem.id, fileName: `${destFileName} · Moving`, percent: 0 },
      VERIFY_STAGE_FRACTION,
      'moving',
      'Moving'
    );
    onLog('info', `Moving ${destFileName} to ${resolvedItem.category}`);

    await moveTempOutputFile(tempMkvPath, destPath, allowOverwrite, (movePercent): void => {
      etaPredictor?.recordTaskProgress(
        finalizeTaskId,
        (movePercent / PERCENT_MAX) * sizeBytes * FINALIZE_PROGRESS_MOVE_WEIGHT
      );
      onProgress(
        {
          slot,
          itemId: resolvedItem.id,
          fileName: `${destFileName} · Moving`,
          percent: movePercent
        },
        VERIFY_STAGE_FRACTION + (movePercent / PERCENT_MAX) * MOVE_STAGE_WEIGHT,
        'moving',
        'Moving'
      );
    });

    if (allowOverwrite && oldExistingPath && !isSameResolvedPath(oldExistingPath, destPath)) {
      await fs.rm(oldExistingPath, { force: true });
      await pruneEmptyOldParentDirs(config, oldExistingPath);
    }
  } catch (err) {
    etaPredictor?.skipTask(remuxTaskId);
    etaPredictor?.skipTask(finalizeTaskId);
    try {
      await fs.rm(tempMkvPath, { force: true });
    } catch (cleanupErr) {
      const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      onLog('warn', `Failed to remove temp file ${path.basename(tempMkvPath)}: ${cleanupMsg}`);
    }
    throw err;
  }

  onProgress(undefined, 1, 'moving', 'Moved');
  return resolvedItem;
}

/** Executes the parallel remux, verification, move, and backup cleanup job pipeline. */
export async function executeMoveJob(options: ExecuteMoveJobOptions): Promise<void> {
  const {
    config,
    jobId,
    toProcess,
    projectedByItemId,
    conflictResolutions,
    existingCollisionByItemId,
    isCancelled,
    isDraining,
    createChildTracker,
    etaPredictor,
    onLog,
    onProgress,
    onFinalizeMovedItems,
    onComplete,
    onError
  } = options;
  const movedItems: ScannedItem[] = [];
  const createdTempSubs: string[] = [];
  const serverTag = resolveServerTag(config.serverId);
  let finalizeChain: Promise<void> = Promise.resolve();

  try {
    const workerCount = Math.min(PROCESS_JOB_CONCURRENCY, Math.max(1, toProcess.length));
    if (etaPredictor) {
      etaPredictor.initQueuePlan(buildProcessQueuePlan(toProcess), workerCount);
      onLog('info', etaPredictor.formatBaselineSummaryLog());
    }

    const purged = await purgeExpiredBackups(config.backupDir);
    if (purged.removedFiles > 0) {
      onLog(
        'info',
        `Purged ${String(purged.removedFiles)} expired backup file(s) older than 7 days.`
      );
    }

    const slotStates: Array<{
      tasks: readonly ActiveParallelTask[];
      stage?: ProcessItemStage;
      stageLabel?: string;
    }> = Array.from({ length: workerCount }, () => ({ tasks: [] }));
    const itemBytes = toProcess.map((item) => Math.max(1, item.probe.sizeBytes));
    const totalBytes = itemBytes.reduce((sum, b) => sum + b, 0);
    const itemFractions = toProcess.map(() => 0);
    const jobStartedAtMs = performance.now();
    let completedCount = 0;

    const resolveActiveStage = (
      fallbackStage: ProcessItemStage,
      fallbackLabel: string
    ): { readonly stage: ProcessItemStage; readonly stageLabel: string } => {
      for (const candidate of ['remuxing', 'verifying', 'moving'] as const) {
        const activeSlot = slotStates.find(
          (state) => state.tasks.length > 0 && state.stage === candidate
        );
        if (activeSlot) {
          return { stage: candidate, stageLabel: activeSlot.stageLabel ?? fallbackLabel };
        }
      }
      return { stage: fallbackStage, stageLabel: fallbackLabel };
    };

    const emitJobProgress = (
      fallbackStage: ProcessItemStage,
      fallbackLabel: string,
      fallbackTasks?: readonly ActiveParallelTask[]
    ): void => {
      if (isCancelled()) {
        return;
      }
      let doneBytes = 0;
      for (let i = 0; i < itemBytes.length; i++) {
        doneBytes += (itemBytes[i] ?? 0) * (itemFractions[i] ?? 0);
      }
      const overallFraction = totalBytes > 0 ? Math.max(0, Math.min(1, doneBytes / totalBytes)) : 1;
      const elapsedSec = (performance.now() - jobStartedAtMs) / MS_PER_SECOND;
      const etaEstimate = etaPredictor?.getEstimate();
      const progressFraction =
        etaPredictor && etaEstimate?.weightedFraction !== undefined
          ? etaEstimate.weightedFraction
          : overallFraction;
      const percent = Math.min(PERCENT_MAX, Math.round(progressFraction * PERCENT_MAX));
      const etaSeconds = etaPredictor
        ? etaEstimate?.etaSeconds
        : computeLinearFallbackEta(overallFraction, completedCount, toProcess.length, elapsedSec);
      const etaState: EtaState | undefined = etaEstimate?.etaState;
      const slotTasks = slotStates
        .flatMap((state) => state.tasks)
        .map((task, index) => ({ ...task, slot: index }));
      const activeTasks = slotTasks.length > 0 ? slotTasks : (fallbackTasks ?? []);
      const resolved = resolveActiveStage(fallbackStage, fallbackLabel);
      onProgress({
        jobId,
        activeTasks,
        totalItems: toProcess.length,
        completedItems: completedCount,
        percent,
        stage: resolved.stage,
        stageLabel: resolved.stageLabel,
        etaSeconds,
        etaState
      });
    };

    const enqueueItemFinalization = (completedItem: ScannedItem): Promise<void> => {
      const next = finalizeChain.then(async () => {
        emitJobProgress('cleanup', 'Cleaning up', [{ slot: 0, fileName: completedItem.fileName }]);
        await backupAndCleanupAfterJob([completedItem], config.inputDir, config.backupDir);
        movedItems.push(completedItem);
        await onFinalizeMovedItems([completedItem]);
      });
      finalizeChain = next.catch((err: unknown) => {
        onLog('error', err instanceof Error ? err.message : String(err));
      });
      return next;
    };

    const attemptErrors: JobItemError[] = [];
    const retryItems: ScannedItem[] = [];
    const itemIndexById = new Map<ItemId, number>(toProcess.map((it, index) => [it.id, index]));

    const runItemAttempt = async (
      item: ScannedItem,
      idx: number,
      slot: number,
      attempt: JobRetryAttempt
    ): Promise<void> => {
      const attemptFinalizeTaskId = buildEtaAttemptTaskId('finalize', item.id, attempt);
      try {
        const destPath = projectedByItemId[item.id];
        if (!destPath) {
          throw new Error(`Missing projected destination for ${item.id}`);
        }
        const completedItem = await processSingleJobItem({
          config,
          jobId,
          attempt,
          item,
          slot,
          destPath,
          allowOverwrite: conflictResolutions[item.id] === 'overwrite',
          oldExistingPath: existingCollisionByItemId[item.id],
          createdTempSubs,
          isCancelled,
          createChildTracker,
          etaPredictor,
          onLog,
          onProgress: (slotTasks, itemFraction, stage, stageLabel): void => {
            const tasks = Array.isArray(slotTasks) ? slotTasks : slotTasks ? [slotTasks] : [];
            slotStates[slot] = tasks.length > 0 ? { tasks, stage, stageLabel } : { tasks: [] };
            itemFractions[idx] = itemFraction;
            emitJobProgress(stage, stageLabel);
          }
        });
        slotStates[slot] = { tasks: [] };
        if (!completedItem) {
          etaPredictor?.markItemSkipped(item.id);
          return;
        }
        await enqueueItemFinalization(completedItem);
        etaPredictor?.completeTask(attemptFinalizeTaskId);
        etaPredictor?.markItemCompleted(item.id);
        itemFractions[idx] = 1;
        completedCount += 1;
        if (isCancelled()) {
          return;
        }
        emitJobProgress('moving', 'Moved');
      } catch (err) {
        slotStates[slot] = { tasks: [] };
        etaPredictor?.skipTask(attemptFinalizeTaskId);
        if (isCancelled()) {
          etaPredictor?.markItemSkipped(item.id);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        attemptErrors.push({
          itemId: item.id,
          fileName: item.fileName,
          attempt,
          message,
          timestamp: Temporal.Now.instant().toString()
        });
        if (attempt === 1) {
          etaPredictor?.resetItemForRetry(item.id);
          retryItems.push(item);
          itemFractions[idx] = 0;
          onLog('error', `[Attempt 1/2] ${item.fileName} failed: ${message} — deferred for retry.`);
        } else {
          etaPredictor?.markItemSkipped(item.id);
          itemFractions[idx] = 1;
          onLog('error', `[Attempt 2/2] ${item.fileName} failed: ${message}`);
        }
      }
    };

    await runSlotWorkerPool(
      toProcess,
      workerCount,
      (item, idx, slot) => runItemAttempt(item, idx, slot, 1),
      (): boolean => isCancelled() || Boolean(isDraining?.())
    );

    if (!isCancelled() && !isDraining?.() && retryItems.length > 0) {
      onLog('info', `Retrying ${String(retryItems.length)} failed item(s) (attempt 2/2)...`);
      await runSlotWorkerPool(
        retryItems,
        workerCount,
        (item, _idx, slot) => runItemAttempt(item, itemIndexById.get(item.id) ?? 0, slot, 2),
        (): boolean => isCancelled() || Boolean(isDraining?.())
      );
    }

    await finalizeChain;
    if (isCancelled()) {
      return;
    }

    await onComplete(movedItems.length, attemptErrors);
  } catch (err) {
    await finalizeChain;
    if (isCancelled()) {
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    await cleanupOrphanTempFiles(config.inputDir, { serverTag, jobId });
    await onError(msg);
  } finally {
    etaPredictor?.flush();
    for (const tempSub of createdTempSubs) {
      await fs.rm(tempSub, { force: true });
    }
  }
}
