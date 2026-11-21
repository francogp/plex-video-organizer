# Purpose

Backend orchestration services for scanning, pre-flight validation, atomic file moving, and job execution.

## Ownership

Backend Maintainers.

## Local Contracts

- All file moves must preserve unselected source items and enforce TOCTOU destination guards.
- After job completion (`jobRunner.ts`), remove only `movedItems` from `this.#items`—never reset `this.#items = []`, so excluded (`include: false`) and conflict-ignored items remain in the queue.
- Only set `needsUserPrompt` (`Resolve Subs`) when an external subtitle has an ambiguous language/missing `.idx`, collides with another external subtitle, or shares `(language, isForced, isHearingImpaired)` with an existing embedded subtitle—adding a new language is never a conflict.
- External text subtitles (`.srt`, `.vtt`, `.ass`, `.ssa`, `.smi`) without an explicit ISO code in the filename are classified statistically via `detectSubtitleTextLanguage` (`franc-min`, `>= 40` cleaned text chars) in `scanner.ts` before falling back to `'und'`, preventing false `needsUserPrompt` conflicts and duplicate Spanish subtitle downloads.
- `libraryVerifierService.ts` falls back to content-level directory moves on `EACCES`/`EPERM`/`EBUSY` without invoking `chown`/`chmod`, while keeping file-level `EACCES` errors loud with `PUID`/`PGID` guidance.
- Cooperative job cancellation (`Cancel Job`): `scanInputDirectory` and `enrichItemsWithAudioAnalysis` accept `shouldCancel` and `registerChild`, return only completed items, persist partial audio cache, and `jobRunner.ts` `unlock()` awaits `#activeRunPromise` and transitions to `READY` when processed items exist.
- Automatic animation library reclassification: `jobRunner.ts` (`resolveCategoryFromMetadata`) updates `category` between standard (`Movies`/`Series`) and animated (`Animated Movies`/`Animated Series`) both during `#executeScan` and when applying manual metadata selection/search patches (`#applyPatchToItem`).
- `libraryVerifierService.ts` classifies recursively empty folders as `Empty directory` whose remediation is direct deletion rather than migration or rename.
- `JobRunner` must update `activeJob` and emit SSE `progress` events through a single synchronized helper (`#updateProgress`) keeping `stageLabel` (step/count) separate from slot-indexed `activeTasks` (populated by concurrent audio analysis, multi-track Loudnorm Pass 1/2, and parallel `Verifier` folder scans), so concurrent workers never overwrite each other or cause UI progress flickering.
- Persistence under `CONFIG_DIR` is unified in `plex-video-organizer.sqlite` (`probe_cache`, `audio_cache`, `queue_state`, `metadata_cache`, with one-time auto-migration from legacy `queue.json`, `metadata-cache.json`, `probe-cache.json`, `audio-cache.json`, and `scan-cache.sqlite`) and resilient to read-only mounts: on `EACCES`/`EPERM`/`EROFS`/`SQLITE_READONLY`/`SQLITE_CANTOPEN`, `jobRunner.ts`, `metadataCache.ts`, and `scanCacheDb.ts` log a single diagnostic warning and fall back to a deterministic path in `os.tmpdir()` (also rehydrating from fallback on restart when `CONFIG_DIR` is unwritable) instead of aborting scans or spamming `STDERR`; the backend never mutates permissions under `/data/*`.
- Hidden dotfiles/directories (`.@__thumb`, `.DS_Store`, `._*`, while explicitly preserving `.plexignore` and `.plexmatch`), NAS system folders (`@eaDir`, `@Recycle`, `#recycle`), and temporary/partial download files (`.tmp`, `.part`, `.!qB`, etc.) are excluded uniformly via `src/domain/constants.ts` (`isHiddenOrTempEntryName` / `isActivePartialDownloadName`) across `scanner.ts`, `libraryVerifierService.ts` (including empty-directory detection), and `fileMover.ts` (never deleting folders containing active partial downloads).
- Per-item scan skipping (`JobRunner.skipScanItem` / `POST /api/scan/skip`) is strictly ephemeral per scan job (`#skippedScanItemIds` clears on `startScan()`, kills only that item's active `ffmpeg` child process, omits SQLite audio caching for skipped items, and excludes `cacheHit` / `skipped` items from `activeFraction` so resumed scan ETAs remain accurate).
- `EtaPredictor` (`etaPredictor.ts`) partitions `eta_samples` by `SERVER_ID` (`env:<id>`) or hardware fingerprint (`hw:<hash>`), preloads `#hostBaselines` via `getAllEtaSamplesForHost`, keeps stage-mode progression (`#activeWorkType`, `setActiveStage`, `#advanceActiveStageIfExhausted`, `#buildStageQueueStates`) alongside unified queue simulation (`initQueuePlan`, `computeQueueEta`, `finalize_io`, deterministic retry/skip rollback via `resetItemForRetry` and `markItemSkipped`, and `getSimulationSnapshot` for `GET /api/eta/simulation`), and keeps `ETA_EMA_ALPHA = 0.3` unscaled.
- **Queue/Verifier Symmetric Mutual Exclusion & TOCTOU Guards**: `JobRunner` (`jobRunner.ts`) enforces symmetric `409 JOB_IN_PROGRESS` mutual exclusion between Organizer runs (`SCANNING`/`PROCESSING`) and Verifier runs (`scanning`/`fixing`) via `#assertNoActiveJob`, `#assertVerifierIdle`, and `#assertIdleRevision`, and re-validates idle state after `await` boundaries via `#requireIdleItemIndex` across all mutating endpoints.
- **Per-Server Temporary File Isolation**: `fileMover.ts` scopes organizing temporary filenames (`buildOrganizingTempFileName`) and orphan temp cleanup (`cleanupOrphanTempFiles`) by `serverTag` (`resolveServerTag` from `SERVER_ID` or hardware hash) so concurrent NAS and development servers sharing storage never collide with or delete each other's in-flight temp files.
- Graceful job draining (`JobRunner.requestDrain` / `POST /api/jobs/drain`) stops dispatching new items in `runSlotWorkerPool` while completing in-flight tasks, finalizes moved items, and transitions back to `READY` when remaining items stay in the queue.
- `unifyTvSeriesMetadataByTvdbId` unifies multi-episode TV scans sharing the same `tvdbId` (preferring `tvdb`), and `searchMetadataCatalog` returns deduplicated multi-provider candidates prioritized by `mediaKind` (`tvdb` first for `tv`, `imdb` first for `movie`).
- Per-item sequential finalization during `executeMoveJob` (`jobExecutionService.ts`): as soon as each item finishes moving to output (`completedItem`), `enqueueItemFinalization` serially runs `backupAndCleanupAfterJob([completedItem], ...)` and `onFinalizeMovedItems([completedItem])` (removing it from `#items`, persisting SQLite queue state, and emitting SSE state immediately) so cancelling (`unlock` or `requestDrain`) never leaves completed items in the queue or orphaned sources in `INPUT_DIR`.
- Rescan audio option preservation (`jobRunner.ts` `#preserveAudioNormalizationOnRescan`): re-scanning `INPUT_DIR` preserves prior `trackSelection.audioNormalization` settings and recalculates `[tags]` for unchanged files matching `sourcePath` and `probe.sizeBytes`.
- Server log persistence & startup mount annotation (`scanCacheDb.ts` `server_logs` table, `jobRunner.ts`): server logs up to `MAX_SERVER_LOG_ENTRIES` are persisted via `#withLogDb` (`appendLog`, `loadRecentLogs`, `clearLogs`), rehydrated on `JobRunner.init()`, and persisted queue items are re-annotated against live output mounts (`annotateQueueItemsWithMounts`).
- Item retry & failure reporting (`jobExecutionService.ts`): failed queue items record structured `JobItemError` entries with `JobRetryAttempt` (`1 | 2`) while cleaning temporary remux artifacts.
- **Throttled Verifier SSE State Emissions**: `JobRunner.#withVerifierSession` throttles `#emitState()` calls inside `onProgress` to at most once every `150 ms` (using `performance.now()`, always flushing `stageLabel` changes and completion) so rapid folder scans do not flood SSE clients with full state payloads.

## Key Files

- [scanCacheDb.ts](scanCacheDb.ts): Native `node:sqlite` (`WAL`, `STRICT` tables, schema migrations) unified persistent store (`plex-video-organizer.sqlite`) for probe/audio caches, queue state, metadata cache, and per-host ETA samples (`eta_samples`) with short-lived sessions, retention pruning, and legacy JSON/`scan-cache.sqlite` auto-migration.
- [etaPredictor.ts](etaPredictor.ts): Queue-step and stage-aware `EtaPredictor` coordinator (`computeQueueEta`, hierarchical rate resolution, `getSimulationSnapshot` for `/api/eta/simulation`) tracking baselines, live EMA, parallel slot scheduling, and calibration states across Scan, Process, and Verifier.
- [scanMetadataService.ts](scanMetadataService.ts): Media scan, audio volume analysis orchestration, metadata enrichment, item patching, and Spanish subtitle auto-download workflow.
- [scanner.ts](scanner.ts): Plex-compliant recursive scanner, `.plexignore`/`.plexmatch` parser, and subtitle matcher.
- [preflight.ts](preflight.ts): Pre-flight destination collision and disk space checks.
- [libraryCollision.ts](libraryCollision.ts): Shared library root indexer, external-ID/normalized-title collision lookup, and `ConflictComparison` builder for `preflight.ts` and `libraryVerifierService.ts`.
- [fileMover.ts](fileMover.ts): `EXDEV`-safe file move, per-server `serverTag` temporary naming (`buildOrganizingTempFileName`), scoped `cleanupOrphanTempFiles`, and deferred end-of-job cleanup.
- [jobExecutionService.ts](jobExecutionService.ts): Parallel remuxing, Loudnorm pass 1/2, verification, atomic move, `finalize_io` ETA instrumentation, shared processable-item filtering (`selectProcessableQueueItems`), idle ETA projection (`buildIdleEtaSimulationSnapshot`), and deferred backup/cleanup executor for queued jobs.
- [jobRunner.ts](jobRunner.ts): In-memory LAN lock, `409 JOB_IN_PROGRESS` active-run mutual exclusion (with post-`await` TOCTOU guards), queue state machine, ETA simulation snapshots, and sequential job execution.
- [libraryVerifierService.ts](libraryVerifierService.ts): Parallel Plex library compliance scanner and bottom-up rename executor.
- [verifierJobService.ts](verifierJobService.ts): Verifier scan/fix job orchestration wrapper for `JobRunner`.

## Work Guidance

- Keep media probing/remuxing in [media/AGENTS.md](media/AGENTS.md) and external API lookups in [metadata/AGENTS.md](metadata/AGENTS.md).

## Verification

- Run `npm run test:coverage` after modifying any service.

## Child DOX Index

- [media/AGENTS.md](media/AGENTS.md): `ffprobe` / `ffmpeg` spawn wrappers and subtitle normalization.
- [metadata/AGENTS.md](metadata/AGENTS.md): IMDb, OMDb, TVDB v4, and TVmaze API clients.
- [subtitles/AGENTS.md](subtitles/AGENTS.md): Multi-provider Spanish subtitle discovery, sidecar download, and player preview.
