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
import {
  collectActiveTasks,
  type ActiveParallelTask,
  type ConflictDecision,
  type ItemId,
  type JobId,
  type JobStageKind,
  type LogLevel,
  type ScannedItem,
  type SseProgressEvent
} from '../../domain/types.ts';
import { buildMountPathsMap, resolvePortableInputPath, type AppConfig } from '../config.ts';
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
const MIN_ETA_FRACTION = 0.001;
const MIN_ETA_ELAPSED_SECONDS = 1;

type ProcessItemStage = Extract<JobStageKind, 'remuxing' | 'verifying' | 'moving'>;

export interface ExecuteMoveJobOptions {
  readonly config: AppConfig;
  readonly jobId: JobId;
  readonly toProcess: readonly ScannedItem[];
  readonly projectedByItemId: Readonly<Partial<Record<ItemId, string>>>;
  readonly conflictResolutions: Readonly<Partial<Record<ItemId, ConflictDecision>>>;
  readonly existingCollisionByItemId: Readonly<Partial<Record<ItemId, string>>>;
  readonly isCancelled: () => boolean;
  readonly createChildTracker: () => (child: ChildProcess | null) => void;
  readonly onLog: (level: LogLevel, message: string) => void;
  readonly onProgress: (progress: SseProgressEvent) => void;
  readonly onFinalizeMovedItems: (movedItems: readonly ScannedItem[]) => Promise<void>;
  readonly onComplete: (movedCount: number) => Promise<void>;
  readonly onError: (message: string) => Promise<void>;
}

function isSameResolvedPath(leftPath: string, rightPath: string): boolean {
  const left = path.resolve(leftPath);
  const right = path.resolve(rightPath);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function measureLoudnormForItem(
  item: ScannedItem,
  downmixStereo: boolean,
  isCancelled: () => boolean,
  createChildTracker: () => (child: ChildProcess | null) => void,
  onLog: (level: LogLevel, message: string) => void,
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

  await runSlotWorkerPool(
    includedTracks,
    workerCount,
    async (track, trackIdx, trackSlot) => {
      const trackLabel = `${item.fileName} · audio #${String(trackIdx + 1)} (${track.language})`;
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
        return;
      }
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
        (fraction, label, activeTrackTasks): void => {
          onProgress(activeTrackTasks, fraction * LOUDNORM_PASS1_WEIGHT, 'remuxing', label);
        }
      )
    : undefined;

  if (isCancelled()) {
    return null;
  }

  const remuxStageLabel = hasLoudnorm ? 'Loudnorm Pass 2/2 (Remuxing)' : 'Remuxing';
  const args = buildFfmpegRemuxArgs(resolvedItem, tempMkvPath, subInputs, loudnormByStreamOrder);
  await runFfmpegRemux(
    args,
    resolvedItem.probe.durationSeconds,
    (percent): void => {
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
    return null;
  }

  const destFileName = path.basename(destPath);
  onProgress(
    { slot, itemId: resolvedItem.id, fileName: `${destFileName} · Verifying` },
    VERIFY_STAGE_FRACTION,
    'verifying',
    'Verifying'
  );
  await probeMedia(tempMkvPath);

  onProgress(
    { slot, itemId: resolvedItem.id, fileName: `${destFileName} · Moving`, percent: 0 },
    VERIFY_STAGE_FRACTION,
    'moving',
    'Moving'
  );
  onLog('info', `Moving ${destFileName} to ${resolvedItem.category}`);

  await moveTempOutputFile(tempMkvPath, destPath, allowOverwrite, (movePercent): void => {
    onProgress(
      { slot, itemId: resolvedItem.id, fileName: `${destFileName} · Moving`, percent: movePercent },
      VERIFY_STAGE_FRACTION + (movePercent / PERCENT_MAX) * MOVE_STAGE_WEIGHT,
      'moving',
      'Moving'
    );
  });

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
    createChildTracker,
    onLog,
    onProgress,
    onFinalizeMovedItems,
    onComplete,
    onError
  } = options;
  const movedItems: ScannedItem[] = [];
  const createdTempSubs: string[] = [];

  try {
    const purged = await purgeExpiredBackups(config.backupDir);
    if (purged.removedFiles > 0) {
      onLog(
        'info',
        `Purged ${String(purged.removedFiles)} expired backup file(s) older than 7 days.`
      );
    }

    const workerCount = Math.min(PROCESS_JOB_CONCURRENCY, Math.max(1, toProcess.length));
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
      const etaSeconds =
        overallFraction > MIN_ETA_FRACTION &&
        completedCount < toProcess.length &&
        elapsedSec >= MIN_ETA_ELAPSED_SECONDS
          ? Math.max(0, Math.round((elapsedSec * (1 - overallFraction)) / overallFraction))
          : undefined;
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
        etaSeconds
      });
    };

    await runSlotWorkerPool(
      toProcess,
      workerCount,
      async (item, idx, slot): Promise<void> => {
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
          onLog,
          onProgress: (slotTasks, itemFraction, stage, stageLabel): void => {
            const tasks = Array.isArray(slotTasks) ? slotTasks : slotTasks ? [slotTasks] : [];
            slotStates[slot] = tasks.length > 0 ? { tasks, stage, stageLabel } : { tasks: [] };
            itemFractions[idx] = itemFraction;
            emitJobProgress(stage, stageLabel);
          }
        });
        slotStates[slot] = { tasks: [] };
        if (!completedItem || isCancelled()) {
          return;
        }
        itemFractions[idx] = 1;
        completedCount += 1;
        movedItems.push(completedItem);
        emitJobProgress('moving', 'Moved');
      },
      isCancelled
    );

    if (isCancelled()) {
      await onFinalizeMovedItems(movedItems);
      return;
    }

    onLog(
      'info',
      `Backing up & cleaning up ${String(movedItems.length)} processed source item(s)...`
    );
    await backupAndCleanupAfterJob(
      movedItems,
      config.inputDir,
      config.backupDir,
      (cleaned, total, fileName): void => {
        const cleanPercent = total > 0 ? Math.round((cleaned / total) * PERCENT_MAX) : PERCENT_MAX;
        onProgress({
          jobId,
          activeTasks: [{ slot: 0, fileName }],
          totalItems: total,
          completedItems: cleaned,
          percent: cleanPercent,
          stage: 'cleanup',
          stageLabel: 'Cleaning up'
        });
      }
    );
    await onFinalizeMovedItems(movedItems);
    await onComplete(movedItems.length);
  } catch (err) {
    if (isCancelled()) {
      await onFinalizeMovedItems(movedItems);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    await cleanupOrphanTempFiles(config.inputDir);
    await onError(msg);
  } finally {
    for (const tempSub of createdTempSubs) {
      await fs.rm(tempSub, { force: true });
    }
  }
}
