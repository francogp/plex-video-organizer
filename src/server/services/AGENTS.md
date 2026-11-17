# Purpose

Backend orchestration services for scanning, pre-flight validation, atomic file moving, and job execution.

## Ownership

Backend Maintainers.

## Local Contracts

- All file moves must preserve unselected source items and enforce TOCTOU destination guards.
- After job completion (`jobRunner.ts`), remove only `movedItems` from `this.#items`—never reset `this.#items = []`, so excluded (`include: false`) and conflict-ignored items remain in the queue.
- Only set `needsUserPrompt` (`Resolve Subs`) when an external subtitle has an ambiguous language/missing `.idx`, collides with another external subtitle, or shares `(language, isForced, isHearingImpaired)` with an existing embedded subtitle—adding a new language is never a conflict.
- `libraryVerifierService.ts` falls back to content-level directory moves on `EACCES`/`EPERM`/`EBUSY` without invoking `chown`/`chmod`, while keeping file-level `EACCES` errors loud with `PUID`/`PGID` guidance.
- Cooperative job cancellation (`Cancel Job`): `scanInputDirectory` and `enrichItemsWithAudioAnalysis` accept `shouldCancel` and `registerChild`, return only completed items, persist partial audio cache, and `jobRunner.ts` `unlock()` awaits `#activeRunPromise` and transitions to `READY` when processed items exist.
- Automatic animation library reclassification: `jobRunner.ts` (`resolveCategoryFromMetadata`) updates `category` between standard (`Movies`/`Series`) and animated (`Animated Movies`/`Animated Series`) both during `#executeScan` and when applying manual metadata selection/search patches (`#applyPatchToItem`).
- `libraryVerifierService.ts` classifies recursively empty folders as `Empty directory` whose remediation is direct deletion rather than migration or rename.
- `JobRunner` must update `activeJob` and emit SSE `progress` events through a single synchronized helper (`#updateProgress`) keeping `stageLabel` (step/count) separate from slot-indexed `activeTasks` (populated by concurrent audio analysis, multi-track Loudnorm Pass 1/2, and parallel `Verifier` folder scans), so concurrent workers never overwrite each other or cause UI progress flickering.
- Persistence under `CONFIG_DIR` is unified in `plex-video-organizer.sqlite` (`probe_cache`, `audio_cache`, `queue_state`, `metadata_cache`, with one-time auto-migration from legacy `queue.json`, `metadata-cache.json`, `probe-cache.json`, `audio-cache.json`, and `scan-cache.sqlite`) and resilient to read-only mounts: on `EACCES`/`EPERM`/`EROFS`/`SQLITE_READONLY`/`SQLITE_CANTOPEN`, `jobRunner.ts`, `metadataCache.ts`, and `scanCacheDb.ts` log a single diagnostic warning and fall back to a deterministic path in `os.tmpdir()` (also rehydrating from fallback on restart when `CONFIG_DIR` is unwritable) instead of aborting scans or spamming `STDERR`; Docker permission adjustments (`ffmpeg-provider` init container) target `CONFIG_DIR` exclusively and never mutate permissions under `/data/*`.
- Hidden dotfiles/directories (`.@__thumb`, `.DS_Store`, `._*`, while explicitly preserving `.plexignore` and `.plexmatch`), NAS system folders (`@eaDir`, `@Recycle`, `#recycle`), and temporary/partial download files (`.tmp`, `.part`, `.!qB`, etc.) are excluded uniformly via `src/domain/constants.ts` (`isHiddenOrTempEntryName` / `isActivePartialDownloadName`) across `scanner.ts`, `libraryVerifierService.ts` (including empty-directory detection), and `fileMover.ts` (never deleting folders containing active partial downloads).
- Per-item scan skipping (`JobRunner.skipScanItem` / `POST /api/scan/skip`) is strictly ephemeral per scan job (`#skippedScanItemIds` clears on `startScan()`, kills only that item's active `ffmpeg` child process, omits SQLite audio caching for skipped items, and excludes `cacheHit` / `skipped` items from `activeFraction` so resumed scan ETAs remain accurate).
- `EtaPredictor` (`etaPredictor.ts`) partitions `eta_samples` by `SERVER_ID` (`env:<id>`) or hardware fingerprint (`hw:<hash>`), avoids mutating `#activeWorkType` inside `startTask()` under parallel workers (advancing stages monotonically via `setActiveStage` and `#advanceActiveStageIfExhausted`), and keeps `ETA_EMA_ALPHA = 0.3` unscaled.
- Graceful job draining (`JobRunner.requestDrain` / `POST /api/jobs/drain`) stops dispatching new items in `runSlotWorkerPool` while completing in-flight tasks, finalizes moved items, and transitions back to `READY` when remaining items stay in the queue.
- `unifyTvSeriesMetadataByTvdbId` unifies multi-episode TV scans sharing the same `tvdbId` (preferring `tvdb`), and `searchMetadataCatalog` returns deduplicated multi-provider candidates prioritized by `mediaKind` (`tvdb` first for `tv`, `imdb` first for `movie`).

## Key Files

- [scanCacheDb.ts](scanCacheDb.ts): Native `node:sqlite` (`WAL`, `STRICT` tables, schema migrations) unified persistent store (`plex-video-organizer.sqlite`) for probe/audio caches, queue state, metadata cache, and per-host ETA samples (`eta_samples`) with short-lived sessions, retention pruning, and legacy JSON/`scan-cache.sqlite` auto-migration.
- [etaPredictor.ts](etaPredictor.ts): Stage-aware `EtaPredictor` coordinator and `resolveHostKey` (`SERVER_ID` or hardware fingerprint) tracking baselines, live EMA, concurrency scaling, and `'calibrating'` vs `'estimated'` states across Scan, Process, and Verifier.
- [scanMetadataService.ts](scanMetadataService.ts): Media scan, audio volume analysis orchestration, metadata enrichment, item patching, and Spanish subtitle auto-download workflow.
- [scanner.ts](scanner.ts): Plex-compliant recursive scanner, `.plexignore`/`.plexmatch` parser, and subtitle matcher.
- [preflight.ts](preflight.ts): Pre-flight destination collision and disk space checks.
- [libraryCollision.ts](libraryCollision.ts): Shared library root indexer, external-ID/normalized-title collision lookup, and `ConflictComparison` builder for `preflight.ts` and `libraryVerifierService.ts`.
- [fileMover.ts](fileMover.ts): `EXDEV`-safe file move and deferred end-of-job cleanup.
- [jobExecutionService.ts](jobExecutionService.ts): Parallel remuxing, Loudnorm pass 1/2, verification, atomic move, and deferred backup/cleanup executor for queued jobs.
- [jobRunner.ts](jobRunner.ts): In-memory LAN lock, queue state machine, and sequential job execution.
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
