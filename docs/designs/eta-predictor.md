# Unified Stage-Aware ETA Predictor (`EtaPredictor`)

- **Author:** Franco Gastón Pellegrini
- **Status:** Approved
- **Date:** 2026-11-16

---

## Overview

`EtaPredictor` is a shared remaining-time estimation module for all three long-running workflows in **Plex Video Organizer**: **Process** (remuxing, 2-pass `Loudnorm`, verification, and file moving), **Scan** (media probing and audio volume analysis), and **Verifier** (Plex naming compliance scan and bottom-up renaming).

It replaces the duplicated linear extrapolations in `jobExecutionService.ts`, `scanMetadataService.ts`, and `libraryVerifierService.ts` with a stage-aware physical work-unit inventory, bounded per-host historical samples (`SERVER_ID` or hardware fingerprint) in `plex-video-organizer.sqlite`, and a live in-memory EMA fed by `ffmpeg -progress pipe:1`.

## The Problem

Each workflow currently estimates ETA independently using mismatched physical assumptions:

1. **Mixed physical regimes (`Process`)**: `jobExecutionService.ts` weights all queued items by `sizeBytes` and applies static per-item stage weights (`0.45` Pass 1, `0.45` Pass 2, `0.10` Move). Because Loudnorm Pass 1 and Pass 2 are governed by audio duration, track count, and channel layout (CPU) rather than file size in bytes (I/O), initial projections underestimate total runtime whenever Pass 1 progresses faster than Pass 2 + Move, causing the ETA to stall or grow over hours.
2. **Discarded live `ffmpeg` throughput signals**: `ffmpegRunner.ts` already parses `speed=` and `out_time_us=` (emitting `speed` in `FfmpegProgressUpdate`), but `runFfmpegRemux`, `analyzeAudioVolume`, and callers (`analyzeItemAudio`, `measureLoudnormForItem`) drop `speed` and forward only `percent`.
3. **No per-host memory and no `EXDEV` distinction**: Without per-host historical baselines, the first minutes of `Process` have zero measurements for `Pass 2` or `Moving` (`EXDEV` byte copy vs. `O(1)` same-filesystem `rename`). At the same time, sharing `plex-video-organizer.sqlite` between Windows development and a Docker NAS would pollute NAS estimates unless partitioned by server identity.

## Goals

- Unify ETA calculation across **Process**, **Scan**, and **Verifier** on top of a pure math kernel (`src/domain/eta.ts`) and a coordinator + SQLite adapter (`src/server/`).
- Separate remaining work inventories by physical unit: audio duration seconds by channel profile (`mono`, `stereo`, `surround`) for CPU-bound stages, `sizeBytes` for I/O-bound stages (`remux_copy`, `finalize_io`), and entry counts for `Scan` probing and `Verifier`.
- Persist up to `1000` recent numeric throughput samples per `(hostKey, workType, profile)` in `plex-video-organizer.sqlite` (`STRICT` table `eta_samples`) via periodic batched writes and end-of-stage flushes.
- Isolate host metrics via `SERVER_ID` (`.env` / environment) with deterministic fallback to hardware fingerprint (`platform`, `arch`, `os.cpus()`, rounded `os.totalmem()`), with no cross-host fallback.
- Reuse `speed=` and expose `outTimeSec` from `ffmpegRunner.ts` to update an in-memory EMA and display an explicit cold-start state (`calibrating` -> `"Calibrating..."` when uncalibrated, or active-stage estimate when downstream stages are unseeded).

## Non-Goals

- Using historical samples from Windows development as a fallback for Docker NAS runs (or vice versa).
- Writing samples to SQLite on every `ffmpeg` progress tick.
- Recording throughput samples from cancelled, failed, stalled, or `skipScanItem`-skipped tasks.
- Altering internal per-file percentage calculation in `ffmpegRunner.ts`.

## Open Questions

None. All initial blending, warm-up, channel-mapping, and cold-start rules are resolved in the Technical Plan below.

## Critical User Journeys (CUJs)

### CUJ 1: `Process` Startup on NAS with Prior History (`SERVER_ID` Set)

- **Given:** The Docker NAS defines `SERVER_ID=nas-main` in `.env` and has prior `eta_samples` rows for `loudnorm_p1`, `remux_loudnorm`, and `finalize_io`. The user starts `Process` on 44 episodes.
- **When:** Queue step plans (`buildProcessQueuePlan`) are registered per item across worker slots and `ffmpeg` begins Pass 1/2.
- **Then:** Once queued, `computeQueueEta` projects makespan across all slots and steps using hierarchical rate resolution, transitioning from `'estimated'` to `'live_blended'` and surfacing local finish clock time (`ETA Xh Ym (HH:mm)`) alongside `GET /api/eta/simulation` for `EtaSimulationModal.vue`.

### CUJ 2: Cold-Start Run (`eta_samples` Empty)

- **Given:** A new server (or a `SERVER_ID` with no prior samples for `remux_loudnorm` / `finalize_io`) starts `Process` or `Scan`.
- **When:** The active stage has not yet passed warm-up (`outTimeSec < 5` and `elapsedSec < 2`), or active stage has live samples while downstream stages remain unseeded.
- **Then:** While the active stage/step lacks empirical or hierarchical fallback rates, the backend emits `etaState: 'calibrating'` (and `'Calibrating...'` when `etaSeconds === undefined`, or `~Xh Ym (HH:mm)` once the active step calibrates). With `computeQueueEta` and hierarchical fallback rates (`sibling_profile`, `related_work_type`, `cold_default`), processing queues immediately project full makespan across all slots and steps, transitioning to `'live_blended'` and persisting completed samples in batch.

### CUJ 3: Cancellation or Manual Skip (`skipScanItem`) Without Baseline Pollution

- **Given:** A scan or job is running with `EtaPredictor` active.
- **When:** The user cancels the job or skips an item via `skipScanItem`.
- **Then:** Remaining work units for the skipped/cancelled item are subtracted from the pending inventory (`skipTask`) so the remaining ETA stays accurate, while no throughput sample for the interrupted task is persisted to `eta_samples` (already-completed tasks are still flushed).

---

## Technical Plan (Architecture)

### 1. Three-Layer Architecture

```text
+-------------------------------------------------------------------+
|  Callers / Adapters (src/server/services/)                        |
|  - jobExecutionService.ts (Process: P1, Remux, Finalize I/O)     |
|  - scanMetadataService.ts + scanner.ts (Scan: Probe, Volumedetect)|
|  - verifierJobService.ts + libraryVerifierService.ts (Verifier)   |
|  - ffmpegRunner.ts (emits speed + outTimeSec from -progress)      |
+-------------------------------+-----------------------------------+
                                |
                                v
+-------------------------------------------------------------------+
|  EtaPredictor Coordinator (src/server/services/etaPredictor.ts)   |
|  - Uses resolveHostKey from config.ts (SERVER_ID -> hardware)     |
|  - Loads baselines from ScanCacheDb                               |
|  - Tracks in-flight progress deltas & EMA in memory               |
|  - Flushes completed samples in batch (periodic + stage/job end)  |
+----------------+---------------------------------+----------------+
                 |                                 |
                 v                                 v
+---------------------------------+   +-----------------------------+
|  Pure Math Kernel               |   |  ScanCacheDb                |
|  (src/domain/eta.ts)            |   |  (scanCacheDb.ts)           |
|  - WorkType / ChannelProfile    |   |  - STRICT eta_samples table |
|  - Inventory & Concurrency math |   |  - Additive migration #3    |
|  - Trimmed median + EMA blend   |   |  - Indexed prune (<= 1000)  |
|  - Monotonic rate & EtaState    |   |  - os.tmpdir() fallback     |
+---------------------------------+   +-----------------------------+
```

### 2. Pure Domain Kernel (`src/domain/eta.ts`) and Contracts (`src/domain/types.ts`)

- **Closed union types derived from `as const` tuples (`domain-type-first` — finite unions with Valibot schema parity)**:
  - `EtaWorkType`: `'scan_probe' | 'volumedetect' | 'loudnorm_p1' | 'remux_loudnorm' | 'remux_peak_gain' | 'remux_copy' | 'finalize_io' | 'verifier_scan_fs' | 'verifier_scan_probe'`.
    - `runFfmpegRemux` executes `-c:v copy` and optional audio normalization in a single `ffmpeg` process, so each queued item registers one of three mutually exclusive remux regimes (`remux_loudnorm`, `remux_peak_gain`, or `remux_copy`), preventing double-counting.
    - `finalize_io` unifies post-remux verification (`probeMedia`), file moving (`moveTempOutputFile`), and backup/cleanup (`backupAndCleanupAfterJob`) measured by `sizeBytes`.
  - `EtaChannelProfile`: `'mono' | 'stereo' | 'surround' | 'default'`.
    - `resolveChannelProfile(channels)`: `channels === 1 -> 'mono'`, `channels === 2 -> 'stereo'`, `channels !== undefined && channels > 2 -> 'surround'`, otherwise `'default'` (used for non-audio stages and unknown channel layouts).
  - `EtaWorkUnitKind`: `'audio_seconds' | 'bytes' | 'entries'`.
    - `'audio_seconds'`: `volumedetect`, `loudnorm_p1`, `remux_loudnorm`, `remux_peak_gain` (using `durationSeconds * includedTrackCount` for multi-track remux so `totalUnits`, `inFlightUnits = outTimeSec * includedTrackCount`, and `completeTask` share identical units).
    - `'bytes'`: `remux_copy`, `finalize_io`.
    - `'entries'`: `scan_probe`, `verifier_scan_fs`, `verifier_scan_probe`.
  - `EtaState`: `'calibrating' | 'estimated' | 'live_blended'`.
- **Mathematical contracts & invariants**:
  - **Monotonic clock**: All elapsed durations and warm-up checks use `performance.now()` (never wall-clock `Date.now()` / `Temporal.Now`).
  - **Baseline rate (`computeTrimmedMedian`)**: Given `N` persisted samples (`N <= 1000`) for `(hostKey, workType, profile)`: `undefined` if `N === 0`; plain median if `N < 10`; 10% trimmed median (dropping lowest `floor(N * 0.1)` and highest `floor(N * 0.1)` sorted values) if `N >= 10`.
  - **Live EMA & warm-up guard**: Ignore `ffmpeg speed=` ticks when `speed === undefined || !Number.isFinite(speed) || speed <= 0`, or before warm-up (`outTimeSec === undefined || (outTimeSec < 5 && elapsedSec < 2)`). Convert `speed=` via `convertFfmpegSpeedToRate(workType, speed, context)` (`context: { mediaDurationSec?: number; itemSizeBytes?: number; trackCount?: number }`):
    - `audio_seconds`: `rate = speed` for single-track processes (`volumedetect`, `loudnorm_p1`), and `rate = speed * (context.trackCount ?? 1)` for multi-track `remux_loudnorm` / `remux_peak_gain`.
    - `bytes` (`remux_copy`): `rate = speed * (context.itemSizeBytes / context.mediaDurationSec)` when both are `> 0` (otherwise computed on completion as `itemSizeBytes / elapsedSec`).
    - Apply EMA update (`alpha = 0.3`) clamped symmetrically to `[prev / 3, prev * 3]` against single-tick spikes.
  - **Blending (`w`)**: Keyed per `${workType}:${profile}` bucket (`observedStageUnits = completedUnits + sum(inFlightUnits)` for that bucket; `totalStageUnits` = post-`skipTask` total). When a historical baseline exists, `w = Math.min(0.7, 0.7 * clamp(observedStageUnits / totalStageUnits, 0, 1))` and `blendedRate = w * liveRate + (1 - w) * baselineRate` (`blendedRate = baselineRate` when `liveRate === undefined`). When no baseline exists, `blendedRate = liveRate`.
  - **Concurrency scaling (`effectiveRate`)**: Samples recorded from parallel worker pools already reflect active contention per worker slot. Both `PROCESS` queues (`initQueuePlan`) and stage-mode workflows (`Scan`, `Verifier`, via sliced worker buckets in `#buildStageQueueStates()` with `slices = 1` for serialized `finalize_io`) feed items across `workerCount` parallel slots in `computeQueueEta`, which schedules active/pending work via greedy min-load slot assignment and models intra-item `loudnorm_p1` multi-track parallelism with `ETA_MULTI_TRACK_CONTENTION_FACTOR`.
  - **In-flight progress accounting & idempotency**: `EtaPredictor` tracks `taskState: Map<TaskId, 'active' | 'completed' | 'skipped'>`, `taskStartMs`, `taskTotalUnits`, and `inFlightUnits` (clamped to `[0, taskTotalUnits]`). `remainingUnits(bucket) = Math.max(0, totalUnits - completedUnits - sum(inFlightUnits))`. Calling `completeTask(taskId)` or `skipTask(taskId)` is idempotent: `completeTask` moves `taskTotalUnits` to `completedUnits` and records `taskTotalUnits / ((now - startMs) / 1000)`; `skipTask` subtracts `taskTotalUnits` from `totalUnits` without recording a sample.
  - **State transitions (`EtaState`)**:
    - If `pendingFollowupStages` is non-empty (e.g., `Scan` before `volumedetect` is registered) -> `'calibrating'` with `etaSeconds = undefined`.
    - Queue plans (`computeQueueEta`) resolve missing `(workType, profile)` entries hierarchically (`live_blended` -> `baseline` -> `sibling_profile` -> `related_work_type` -> `cold_default`) so a single unseeded item never hides downstream stages, outputting `'calibrating'` only when cold-default work accounts for `>= 50%` of remaining seconds (`~Xh Ym (HH:mm)`), otherwise `'estimated'` or `'live_blended'` (`ETA Xh Ym (HH:mm)`).
- **SSE / UI contracts (`src/domain/types.ts`)**:
  - Add `readonly etaState?: EtaState` to `ActiveJobProgress`, `VerifierProgress`, and `SseProgressEvent`.
  - When `etaState === 'calibrating'` and `etaSeconds === undefined`, `organizerStore.ts` clears any previous `etaSeconds` and `formatEta(etaSeconds, etaState)` returns `'Calibrating...'`.

### 3. Persistence in `ScanCacheDb` (`src/server/services/scanCacheDb.ts`)

- Append additive migration `#3` to `MIGRATIONS` creating the `STRICT` `eta_samples` table:

```sql
CREATE TABLE IF NOT EXISTS eta_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_key TEXT NOT NULL,
  work_type TEXT NOT NULL,
  profile TEXT NOT NULL,
  throughput REAL NOT NULL CHECK (throughput > 0),
  work_units REAL NOT NULL CHECK (work_units > 0),
  duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_eta_samples_lookup
  ON eta_samples(host_key, work_type, profile, id DESC);
```

- **Retention, batching, and NAS mount safety**:
  - `eta_samples` is exempt from `probe_cache`'s 14-day TTL pruning and instead enforces two rules: (1) keep at most `1000` rows per `(host_key, work_type, profile)` using indexed pruning (`DELETE FROM eta_samples WHERE host_key = ? AND work_type = ? AND profile = ? AND id < (SELECT id FROM eta_samples WHERE host_key = ? AND work_type = ? AND profile = ? ORDER BY id DESC LIMIT 1 OFFSET 999)`), and (2) prune orphaned `host_key` rows older than 30 days (`created_at < now - 30d`).
  - Valid samples (`workUnits > 0 && elapsedMs >= 200 && Number.isFinite(rate) && rate > 0`) are buffered in memory and flushed in a single `WAL` transaction every `10` completed tasks, at stage/job end, and on cooperative cancellation (`unlock()`) for already-completed tasks. This produces zero per-tick SQLite I/O and reduces `SQLITE_BUSY` risk on NAS mounts. Note: `WAL` requires local POSIX locking on `CONFIG_DIR`; if `CONFIG_DIR` is on an unsupported network share (`SQLITE_IOERR`, `EACCES`, `EROFS`, `SQLITE_READONLY`), `openScanCacheDb()` falls back to `os.tmpdir()`.

### 4. Host Identity (`hostKey`) and Service Adapters

- **`resolveHostKey(serverId?: string): string` (`src/server/config.ts`)**:
  1. If `SERVER_ID` (trimmed) is non-empty, return `env:${trimmedServerId}`.
  2. Otherwise, compute `hw:${sha256Hex16}` over `${process.platform}|${os.arch()}|${cpus[0]?.model ?? 'unknown'}|${String(Math.max(1, cpus.length))}|${String(Math.round(os.totalmem() / 1024 ** 3))}` (rounding RAM to nearest GiB prevents minor kernel/cgroup shifts from invalidating history). Log resolved `hostKey`, `coldStart` flag, and loaded baseline counts at job start. (`resolveServerTag` in `config.ts` derives the filesystem-safe tag used for per-server temporary files.)
- **`ffmpegRunner.ts`**: Expose `readonly outTimeSec?: number` alongside existing `readonly speed?: number` on `FfmpegProgressUpdate`, and forward full `FfmpegProgressUpdate` in `runFfmpegRemux` and `analyzeAudioVolume` (matching `measureLoudnormPass1`).
- **`jobExecutionService.ts` (`Process`)**: Before launching the worker pool, register per-item queue step plans via `buildProcessQueuePlan(toProcess)` (`loudnorm_p1`, the active remux regime `remux_loudnorm` / `remux_peak_gain` / `remux_copy`, and `finalize_io`); feed `speed`/`outTimeSec` per task ID into `EtaPredictor`, measure `finalize_io` across `probeMedia` + `moveTempOutputFile` + `backupAndCleanupAfterJob`, and weight global percent by `weightedFraction`.
- **`scanMetadataService.ts` & `scanner.ts` (`Scan`)**: Widen `AudioAnalysisFn` and `analyzeItemAudio` in `scanner.ts` to accept/forward `FfmpegProgressUpdate` (`speed`, `outTimeSec`). Start `Scan` inventory in `scan_probe` with discovered file count, keep `etaState: 'calibrating'` while `scan_probe` collects initial media durations for non-cached items (preventing mid-scan upward ETA jumps), subtract `cacheHit` (`probe_cache` / `audio_cache`) and `skipScanItem` via `skipTask`, and register `volumedetect` inventory for uncached items.
- **`verifierJobService.ts` & `libraryVerifierService.ts` (`Verifier`)**: Use `EtaPredictor` across `scanLibrariesForCompliance` (including post-fix re-verification in `executeVerifierFix`), reconciling dynamic folder/entry discovery across `verifier_scan_fs` and `verifier_scan_probe` (`recalculateTags: true`), while `applyVerifierRenames` retains linear `computeEtaSeconds` for simple bottom-up rename progress.

---

## Alternatives Considered

### Alternative A: Keep Global Byte-Weighted Linear Extrapolation (`elapsed * (1 - f) / f`)

- **Pros:** Zero new SQLite tables and minimal code surface.
- **Cons:** Mixes CPU-bound stages (`Loudnorm Pass 1/2`) with I/O-bound stages (`Moving`), weights items by bytes instead of audio duration, and underestimates total runtime during the first half of a job whenever Pass 1 outpaces Pass 2 + Move.
- **Reason for Rejection:** Produces misleading projections over multi-hour runs (e.g., predicting ~20h at start and still reporting ~20h after 12 hours).

### Alternative B: In-Memory Live EMA Only for `Process` Without SQLite Persistence

- **Pros:** Small footprint (~40 lines using `ffmpeg speed=`) with no schema migrations or `hostKey` management.
- **Cons:** During the first minutes of `Process` (while only `Loudnorm Pass 1/2` is running), there is zero empirical measurement for `Pass 2/2` or `Moving` (`EXDEV`), forcing reliance on static stage weights. It also leaves `Scan` and `Verifier` with separate linear estimators.
- **Reason for Rejection:** All three workflows require a unified prediction module, and local historical persistence is needed to project accurately from the opening minutes.

### Alternative C: Store a Single Per-File Average Without Stage, Channel, or `hostKey` Partitioning

- **Pros:** Simpler schema (one rate per file or video minute).
- **Cons:** A 300 MB stereo file has negligible I/O cost and lower audio CPU load than a 20 GB 5.1/7.1 file with an `EXDEV` move, causing large extrapolation errors across mixed batches. Sharing `plex-video-organizer.sqlite` between Windows dev and Docker NAS would also contaminate NAS estimates.
- **Reason for Rejection:** Historical metrics must match the specific operation performed and remain isolated per server (`SERVER_ID` / hardware fingerprint).

---

## Non-Functional Requirements

- **SQLite contention & I/O:** `ffmpeg speed=` ticks update only the in-memory EMA; SQLite receives batched writes only every 10 completed tasks and at stage/job boundaries under `WAL` mode (`busy_timeout = 5000`), reducing write contention and `SQLITE_BUSY` risk on NAS mounts.
- **Read-only & network mount resilience:** Implementing `eta_samples` as a `ScanCacheDb` migration inherits automatic `os.tmpdir()` fallback on `EACCES`/`EROFS`/`SQLITE_READONLY`/`SQLITE_IOERR`.
- **Host isolation:** No `hostKey` ever reads or falls back to samples from another `hostKey` when sharing `plex-video-organizer.sqlite`.

---

## Detailed Implementation Plan

### Target Files to Create / Modify

#### 1. `src/domain/constants.ts` (Modify)

- **Type / Scope:** Domain Constants (`as const` tuples for `domain-type-first` unions and numeric thresholds)
- **Rationale:** Add union-deriving tuples `ETA_WORK_TYPES`, `ETA_CHANNEL_PROFILES`, `ETA_WORK_UNIT_KINDS`, `ETA_STATES`, `ETA_RATE_SOURCES`, `ETA_SIMULATED_ITEM_STATUSES`, `ETA_SIMULATION_MODES`, and `ETA_STEP_KINDS`, alongside numeric/rate constants `ETA_MAX_SAMPLES_PER_KEY = 1000`, `ETA_ORPHAN_HOST_TTL_MS = 30 * 24 * 60 * 60 * 1000`, `ETA_WARMUP_OUT_TIME_SEC = 5`, `ETA_WARMUP_ELAPSED_SEC = 2`, `ETA_MIN_SAMPLE_MS = 200`, `ETA_EMA_ALPHA = 0.3`, `ETA_LIVE_WEIGHT_MAX = 0.7`, `ETA_FLUSH_BATCH_SIZE = 10`, `ETA_PROFILE_CHANNEL_FACTORS`, `ETA_DEFAULT_COLD_RATES`, `ETA_PEAK_FROM_LOUDNORM_FACTOR`, `ETA_REMUX_LOUDNORM_FROM_P1_FACTOR`, `ETA_COPY_FROM_IO_FACTOR`, `ETA_MULTI_TRACK_CONTENTION_FACTOR`, and `ETA_FALLBACK_CALIBRATING_THRESHOLD`.

#### 2. `src/domain/types.ts` (Modify)

- **Type / Scope:** Domain Type Definitions & Valibot Schemas
- **Rationale:** Derive `EtaWorkType`, `EtaChannelProfile`, `EtaWorkUnitKind`, `EtaState`, `EtaRateSource`, `EtaSimulatedItemStatus`, `EtaSimulationMode`, and `EtaStepKind` from `constants.ts` tuples with Valibot schema parity, define branded IDs (`EtaStepId`, `EtaStageId`) and simulation contracts (`EtaRateDiagnostic`, `EtaSimulatedStep`, `EtaSimulatedSlotItem`, `EtaSimulatedSlot`, `EtaSimulationSnapshot`), and add `readonly etaState?: EtaState` to `ActiveJobProgress`, `VerifierProgress`, and `SseProgressEvent`.

#### 3. `src/domain/eta.ts` (Create)

- **Type / Scope:** Pure Domain Prediction Engine (zero I/O)
- **Rationale:** Implement `getWorkUnitKind(workType)`, `resolveChannelProfile(channels)`, `computeTrimmedMedian(samples)`, `updateEmaRate(prev, rate, alpha)`, `convertFfmpegSpeedToRate(workType, speed, context)`, `computeQueueEta(input)` (with internal 4-tier hierarchical rate resolution), `buildEtaStepId`, `buildEtaAttemptTaskId`, `buildEtaStageId`, and `buildEtaStageStepId`.

#### 4. `src/server/config.ts` (Modify)

- **Type / Scope:** Server Environment Config & Identity SSoT
- **Rationale:** Add `SERVER_ID: v.optional(v.string())` to env validation, trim whitespace (empty -> `undefined`), expose `readonly serverId?: string` on `AppConfig`, and export `resolveHostKey` + `resolveServerTag`.

#### 5. `src/server/services/scanCacheDb.ts` (Modify)

- **Type / Scope:** SQLite Unified Persistence (`node:sqlite`)
- **Rationale:** Append migration `#3` (`eta_samples` `STRICT` table + `CHECK` constraints + `idx_eta_samples_lookup`), extend `isUnwritableDbError` to include `SQLITE_IOERR` / `EIO`, and expose `getEtaSamples`, `getAllEtaSamplesForHost` (validated via `EtaWorkTypeSchema`/`EtaChannelProfileSchema`), and `recordEtaSamplesBatch` pruning only dirty `(host_key, work_type, profile)` tuples per transaction.

#### 6. `src/server/services/etaPredictor.ts` (Create)

- **Type / Scope:** Server ETA Coordinator
- **Rationale:** Export `EtaPredictor` using `resolveHostKey` from `config.ts` with `initQueuePlan`, `markStagePending`, `initStageInventory`, `reconcileStage`, `startTask`, `recordTaskProgress`, `completeTask`, `skipTask`, `resetItemForRetry`, `markItemCompleted`, `markItemSkipped`, `getEstimate`, `getSimulationSnapshot`, and `flush`. Uses monotonic `performance.now()` and flushes every 10 completed tasks + stage/job completion + cancellation.

#### 7. `src/server/services/media/ffmpegRunner.ts` (Modify)

- **Type / Scope:** FFmpeg Process Wrapper
- **Rationale:** Add `readonly outTimeSec?: number` to `FfmpegProgressUpdate` (which already carries `speed`), and forward full `FfmpegProgressUpdate` in `analyzeAudioVolume` and `runFfmpegRemux` (matching `measureLoudnormPass1`).

#### 8. `src/server/services/jobExecutionService.ts` (Modify)

- **Type / Scope:** Process Job Executor
- **Rationale:** Replace byte-weighted linear ETA and static stage weights with `EtaPredictor`; build per-item step plans (`loudnorm_p1`, remux, `finalize_io`), feed `speed`/`outTimeSec` per task ID, and flush completed samples on stage end and cancellation.

#### 9. `src/server/services/scanMetadataService.ts` & `src/server/services/scanner.ts` (Modify)

- **Type / Scope:** Scan & Audio Analysis Workflow
- **Rationale:** Widen `AudioAnalysisFn` and `analyzeItemAudio` in `scanner.ts` to forward `FfmpegProgressUpdate` (`speed`, `outTimeSec`). Wire `EtaPredictor` from `scanMetadataService.ts` into `scanInputDirectory` and `enrichItemsWithAudioAnalysis` to track `scan_probe` and `volumedetect`, keeping `'calibrating'` until `probe` finishes and discounting `cacheHit` / `skipScanItem` via `skipTask` without recording unrepresentative samples.

#### 10. `src/server/services/verifierJobService.ts` & `src/server/services/libraryVerifierService.ts` (Modify)

- **Type / Scope:** Verifier Scan & Fix Services
- **Rationale:** Use `EtaPredictor` in `scanLibrariesForCompliance` (and post-fix re-verification in `verifierJobService.ts`), reconciling dynamic folder/entry discovery across `verifier_scan_fs` and `verifier_scan_probe` (`recalculateTags`), while retaining linear `computeEtaSeconds` for `applyVerifierRenames`.

#### 11. `src/server/services/jobRunner.ts` (Modify)

- **Type / Scope:** Job Orchestrator
- **Rationale:** Instantiate a fresh `EtaPredictor` per run (`#activeEtaPredictor`), pass it into `executeScanWorkflow`, `executeMoveJob`, `executeVerifierScan`, and `executeVerifierFix`; wire `skipScanItem` to `EtaPredictor.skipTask`; flush completed samples on `unlock()`; and propagate `etaState` in `#updateProgress`, initial progress objects, and `#emitState`.

#### 12. `src/client/stores/organizerStore.ts`, `src/client/utils/formatters.ts`, `src/client/components/OrganizerWorkspace.vue`, `src/client/components/OrganizerStatusBar.vue`, `src/client/components/EtaSimulationModal.vue` & `src/client/components/VerifierStatusToolbar.vue` (Modify / Create)

- **Type / Scope:** Frontend Store, ETA Formatting & Progress UI
- **Rationale:** Update `connectSse()` in `organizerStore.ts` to copy `etaState: prog.etaState`, clear stale `etaSeconds` when `prog.etaSeconds === undefined`, and expose `fetchEtaSimulation()`; update `formatEta(etaSeconds?: number, etaState?: EtaState, nowMs?)` in `formatters.ts` to return `'Calibrating...'` when undefined and `ETA Xh Ym (HH:mm)` / `~Xh Ym (HH:mm)` with 24h finish clock time; remove `etaSeconds !== undefined` guards in `OrganizerWorkspace.vue` and `VerifierStatusToolbar.vue` so `formatEta` renders during calibration; and add `ETA Plan` trigger + `EtaSimulationModal.vue` backed by `GET /api/eta/simulation`.

#### 13. `tests/domain/eta.test.ts`, `tests/server/etaPredictor.test.ts`, `tests/server/scanCacheDb.test.ts`, `tests/server/ffmpegRunner.test.ts`, `tests/client/organizerStore.test.ts` & `tests/client/VerifierView.test.ts` (Create / Modify)

- **Type / Scope:** Automated Unit & Integration Tests (Vitest)
- **Rationale:** Verify pure ETA math (trimmed median, EMA blend, concurrency scaling, `speed=` conversions, `NaN`/`Infinity`/zero-unit rejection, `calibrating` transitions), `ScanCacheDb` migration #3 + `<= 1000` retention + 30-day orphan TTL + `hostKey` isolation, `outTimeSec`/`speed` forwarding in `ffmpegRunner.ts`, and `"Calibrating..."` rendering in client store/views.

#### 14. `src/domain/AGENTS.md`, `src/server/AGENTS.md`, `src/server/services/AGENTS.md`, `tests/AGENTS.md`, `tests/domain/AGENTS.md` & `tests/server/AGENTS.md` (Modify)

- **Type / Scope:** DOX Documentation Indices (repository documentation architecture)
- **Rationale:** Register `eta.ts`, `etaPredictor.ts`, `SERVER_ID`, and the new test suites in their parent and child `AGENTS.md` files to keep `validate_dox_integrity` passing.
