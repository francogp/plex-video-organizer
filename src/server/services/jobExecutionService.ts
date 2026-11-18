import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runSlotWorkerPool } from '../../domain/concurrency.ts';
import {
  ORGANIZING_TEMP_MARKER,
  ORGANIZING_TEMP_SUFFIX,
  PROCESS_JOB_CONCURRENCY
} from '../../domain/constants.ts';
import { computeLinearFallbackEta, resolveChannelProfile } from '../../domain/eta.ts';
import {
  collectActiveTasks,
  type ActiveParallelTask,
  type ConflictDecision,
  type EtaChannelProfile,
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
import { buildMountPathsMap, resolvePortableInputPath, type AppConfig } from '../config.ts';
import type { EtaInventoryEntry, EtaPredictor } from './etaPredictor.ts';
import {
  backupAndCleanupAfterJob,
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

const PERCENT_MAX = 100;
const LOUDNORM_PASS1_WEIGHT = 0.45;
const REMUX_WITH_LOUDNORM_WEIGHT = 0.45;
const REMUX_ONLY_WEIGHT = 0.9;
const VERIFY_STAGE_FRACTION = 0.9;
const MOVE_STAGE_WEIGHT = 0.1;
const MS_PER_SECOND = 1000;

type ProcessItemStage = Extract<JobStageKind, 'remuxing' | 'verifying' | 'moving'>;

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
  const streamByOrder = new Map(item.probe.audioStreams.map((s) => [s.streamOrder, s]));
  let maxChannels = 0;
  for (const track of includedTracks) {
    const ch = streamByOrder.get(track.streamOrder)?.channels ?? 0;
    if (ch > maxChannels) {
      maxChannels = ch;
    }
  }
  const profile = resolveChannelProfile(maxChannels > 0 ? maxChannels : undefined);
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

async function resolveExistingDev(
  targetPath: string,
  cache: Map<string, number | null>
): Promise<number | null> {
  let current = path.resolve(targetPath);
  for (;;) {
    const cached = cache.get(current);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const stat = await fs.stat(current);
      const dev = typeof stat.dev === 'number' && stat.dev > 0 ? stat.dev : null;
      cache.set(current, dev);
      return dev;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        cache.set(current, null);
        return null;
      }
      current = parent;
    }
  }
}

async function detectExdevItemIds(
  config: AppConfig,
  toProcess: readonly ScannedItem[],
  projectedByItemId: Readonly<Partial<Record<ItemId, string>>>
): Promise<Set<ItemId>> {
  const exdevIds = new Set<ItemId>();
  const devCache = new Map<string, number | null>();
  const mountPaths = buildMountPathsMap(config);
  for (const item of toProcess) {
    const sourcePath = await resolvePortableInputPath(config, item.sourcePath, item.relativePath);
    const projectedDest = projectedByItemId[item.id];
    const destProbePath = projectedDest ? path.dirname(projectedDest) : mountPaths[item.category];
    const sourceDev = await resolveExistingDev(path.dirname(sourcePath), devCache);
    const destDev = await resolveExistingDev(destProbePath, devCache);
    if (sourceDev === null || destDev === null || sourceDev !== destDev) {
      exdevIds.add(item.id);
    }
  }
  return exdevIds;
}

function initProcessEtaInventories(
  etaPredictor: EtaPredictor,
  toProcess: readonly ScannedItem[],
  exdevIds: ReadonlySet<ItemId>,
  workerCount: number
): void {
  const p1Entries: EtaInventoryEntry[] = [];
  const remuxBuckets = new Map<
    Extract<EtaWorkType, 'remux_loudnorm' | 'remux_peak_gain' | 'remux_copy'>,
    EtaInventoryEntry[]
  >();
  const exdevEntries: EtaInventoryEntry[] = [];

  for (const item of toProcess) {
    const durationSec = Math.max(1, item.probe.durationSeconds);
    const sizeBytes = Math.max(1, item.probe.sizeBytes);
    const streamByOrder = new Map(item.probe.audioStreams.map((s) => [s.streamOrder, s]));
    if (item.trackSelection.audioNormalization?.mode === 'loudnorm') {
      for (const track of item.trackSelection.audioTracks) {
        if (!track.include) {
          continue;
        }
        p1Entries.push({
          profile: resolveTrackChannelProfile(streamByOrder, track.streamOrder),
          units: durationSec
        });
      }
    }
    const remux = resolveRemuxSpec(item);
    const list = remuxBuckets.get(remux.workType) ?? [];
    list.push({ profile: remux.profile, units: remux.totalUnits });
    remuxBuckets.set(remux.workType, list);
    if (exdevIds.has(item.id)) {
      exdevEntries.push({ profile: 'default', units: sizeBytes });
    }
  }

  const maxTrackCount = toProcess.reduce(
    (max, item) => Math.max(max, item.trackSelection.audioTracks.filter((t) => t.include).length),
    1
  );
  const p1Concurrency = Math.min(maxTrackCount, Math.max(1, os.cpus().length));
  if (p1Entries.length > 0) {
    etaPredictor.initStageInventory('loudnorm_p1', p1Entries, p1Concurrency);
  }
  for (const [workType, entries] of remuxBuckets.entries()) {
    etaPredictor.initStageInventory(workType, entries, workerCount);
  }
  if (exdevEntries.length > 0) {
    etaPredictor.initStageInventory('move_exdev', exdevEntries, 1);
  }
  const initialStage =
    p1Entries.length > 0
      ? 'loudnorm_p1'
      : (remuxBuckets.keys().next().value ?? (exdevEntries.length > 0 ? 'move_exdev' : undefined));
  if (initialStage) {
    etaPredictor.setActiveStage(initialStage);
  }
}

async function measureLoudnormForItem(
  item: ScannedItem,
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
      const p1TaskId = `p1:${item.id}:${String(track.streamOrder)}`;
      const trackProfile = resolveTrackChannelProfile(streamByOrder, track.streamOrder);
      etaPredictor?.startTask(p1TaskId, 'loudnorm_p1', trackProfile, durationSec, {
        mediaDurationSec: durationSec,
        trackCount: 1
      });
      trackSlotTasks[trackSlot] = {
        slot: trackSlot,
        itemId: item.id,
        fileName: trackLabel,
        percent: 0
      };
      emitPass1Progress();

      const measured = await measureLoudnormPass1(
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
      trackSlotTasks[trackSlot] = undefined;
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
  readonly item: ScannedItem;
  readonly slot: number;
  readonly destPath: string;
  readonly allowOverwrite: boolean;
  readonly oldExistingPath: string | undefined;
  readonly createdTempSubs: string[];
  readonly isCancelled: () => boolean;
  readonly createChildTracker: () => (child: ChildProcess | null) => void;
  readonly etaPredictor?: EtaPredictor;
  readonly isExdev: boolean;
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
    item,
    slot,
    destPath,
    allowOverwrite,
    oldExistingPath,
    createdTempSubs,
    isCancelled,
    createChildTracker,
    etaPredictor,
    isExdev,
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
  const tempMkvPath = path.join(
    sourceDir,
    `${baseNoExt}${ORGANIZING_TEMP_MARKER}${jobId}.${resolvedItem.id}${ORGANIZING_TEMP_SUFFIX}`
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
  const remuxTaskId = `remux:${resolvedItem.id}`;
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

    const moveTaskId = `move:${resolvedItem.id}`;
    if (isExdev) {
      etaPredictor?.startTask(moveTaskId, 'move_exdev', 'default', sizeBytes, {
        itemSizeBytes: sizeBytes
      });
    }

    await moveTempOutputFile(tempMkvPath, destPath, allowOverwrite, (movePercent): void => {
      if (isExdev) {
        etaPredictor?.recordTaskProgress(moveTaskId, (movePercent / PERCENT_MAX) * sizeBytes);
      }
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
    if (isExdev) {
      etaPredictor?.completeTask(moveTaskId);
    }
  } catch (err) {
    try {
      await fs.rm(tempMkvPath, { force: true });
    } catch (cleanupErr) {
      const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      onLog('warn', `Failed to remove temp file ${path.basename(tempMkvPath)}: ${cleanupMsg}`);
    }
    throw err;
  }

  if (allowOverwrite && oldExistingPath && !isSameResolvedPath(oldExistingPath, destPath)) {
    await fs.rm(oldExistingPath, { force: true });
    await pruneEmptyOldParentDirs(config, oldExistingPath);
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
  let finalizeChain: Promise<void> = Promise.resolve();

  try {
    const purged = await purgeExpiredBackups(config.backupDir);
    if (purged.removedFiles > 0) {
      onLog(
        'info',
        `Purged ${String(purged.removedFiles)} expired backup file(s) older than 7 days.`
      );
    }

    const workerCount = Math.min(PROCESS_JOB_CONCURRENCY, Math.max(1, toProcess.length));
    const exdevIds = etaPredictor
      ? await detectExdevItemIds(config, toProcess, projectedByItemId)
      : new Set<ItemId>();
    if (etaPredictor) {
      initProcessEtaInventories(etaPredictor, toProcess, exdevIds, workerCount);
      onLog('info', etaPredictor.formatBaselineSummaryLog());
    }
    const slotStates: Array<{
      tasks: readonly ActiveParallelTask[];
      stage?: ProcessItemStage;
      stageLabel?: string;
    }> = Array.from({ length: workerCount }, () => ({ tasks: [] }));
    const enqueueItemFinalization = (completedItem: ScannedItem): Promise<void> => {
      const next = finalizeChain.then(async () => {
        onProgress({
          jobId,
          activeTasks: [{ slot: 0, fileName: completedItem.fileName }],
          totalItems: toProcess.length,
          completedItems: movedItems.length,
          percent: Math.min(
            PERCENT_MAX,
            Math.round(((movedItems.length + 1) / toProcess.length) * PERCENT_MAX)
          ),
          stage: 'cleanup',
          stageLabel: 'Cleaning up'
        });
        await backupAndCleanupAfterJob([completedItem], config.inputDir, config.backupDir);
        movedItems.push(completedItem);
        await onFinalizeMovedItems([completedItem]);
      });
      finalizeChain = next.catch((err: unknown) => {
        onLog('error', err instanceof Error ? err.message : String(err));
      });
      return next;
    };
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

    const emitJobProgress = (fallbackStage: ProcessItemStage, fallbackLabel: string): void => {
      if (isCancelled()) {
        return;
      }
      let doneBytes = 0;
      for (let i = 0; i < itemBytes.length; i++) {
        doneBytes += (itemBytes[i] ?? 0) * (itemFractions[i] ?? 0);
      }
      const overallFraction = totalBytes > 0 ? Math.max(0, Math.min(1, doneBytes / totalBytes)) : 1;
      const percent = Math.min(PERCENT_MAX, Math.round(overallFraction * PERCENT_MAX));
      const elapsedSec = (performance.now() - jobStartedAtMs) / MS_PER_SECOND;
      const etaEstimate = etaPredictor?.getEstimate();
      const etaSeconds = etaPredictor
        ? etaEstimate?.etaSeconds
        : computeLinearFallbackEta(overallFraction, completedCount, toProcess.length, elapsedSec);
      const etaState: EtaState | undefined = etaEstimate?.etaState;
      const activeTasks = slotStates
        .flatMap((state) => state.tasks)
        .map((task, index) => ({ ...task, slot: index }));
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

    const attemptErrors: JobItemError[] = [];
    const retryItems: ScannedItem[] = [];
    const itemIndexById = new Map<ItemId, number>(toProcess.map((it, index) => [it.id, index]));

    const runItemAttempt = async (
      item: ScannedItem,
      idx: number,
      slot: number,
      attempt: JobRetryAttempt
    ): Promise<void> => {
      try {
        const destPath = projectedByItemId[item.id];
        if (!destPath) {
          throw new Error(`Missing projected destination for ${item.id}`);
        }
        const completedItem = await processSingleJobItem({
          config,
          jobId,
          item,
          slot,
          destPath,
          allowOverwrite: conflictResolutions[item.id] === 'overwrite',
          oldExistingPath: existingCollisionByItemId[item.id],
          createdTempSubs,
          isCancelled,
          createChildTracker,
          etaPredictor,
          isExdev: exdevIds.has(item.id),
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
          return;
        }
        await enqueueItemFinalization(completedItem);
        itemFractions[idx] = 1;
        completedCount += 1;
        if (isCancelled()) {
          return;
        }
        emitJobProgress('moving', 'Moved');
      } catch (err) {
        slotStates[slot] = { tasks: [] };
        if (isCancelled()) {
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
          retryItems.push(item);
          itemFractions[idx] = 0;
          onLog('error', `[Attempt 1/2] ${item.fileName} failed: ${message} — deferred for retry.`);
        } else {
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
    await cleanupOrphanTempFiles(config.inputDir);
    await onError(msg);
  } finally {
    etaPredictor?.flush();
    for (const tempSub of createdTempSubs) {
      await fs.rm(tempSub, { force: true });
    }
  }
}
