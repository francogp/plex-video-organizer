# Purpose

Pure domain layer defining canonical types, constants, and Plex naming/path formatters with zero I/O dependencies.

## Ownership

Domain Layer Maintainers.

## Local Contracts

- All union types must derive from `as const` tuples in [constants.ts](constants.ts) with `valibot` schema parity and branded IDs in [types.ts](types.ts).
- All relative imports must use `.ts` extensions for Node.js 26+ native TypeScript execution.
- All generated output paths must pass `resolveContainedOutputPath` containment checks.
- Leading bracketed title tokens (e.g., `[REC]`) belong to the title and must never be stripped as metadata tags; only tokens appearing after the title begins (`index > 0`) are parsed as year, provider IDs, or bracket tags, and trailing video extensions on root directory names must be stripped before title extraction.
- `extractSplitPart` must only match split-part suffixes (`cd`, `disc`, `disk`, `dvd`, `pt`, or delimiter-separated `part`) at the end of a stem, never title words such as `Part 1` / `Part 2` preceding `(YYYY)`.
- `sanitizePlexSegment` (`constants.ts`) normalizes curly apostrophes to ASCII `'` and strips curly double quotes (`CURLY_DOUBLE_QUOTE_REGEX`) for deterministic Plex naming and Verifier round-trips; `JOB_RETRY_ATTEMPTS` maintains `as const` + `JobRetryAttemptSchema` Valibot parity.

## Key Files

- [constants.ts](constants.ts): Typed constants, extension sets, language maps, and Plex thresholds.
- [concurrency.ts](concurrency.ts): Pure slot-indexed concurrent worker pool helper.
- [eta.ts](eta.ts): Pure unified queue-simulation ETA math kernel (`computeQueueEta`), hierarchical rate resolution, branded `EtaStepId`/`EtaStageId` builders, channel profile mapping, trimmed median, and EMA blending.
- [types.ts](types.ts): Branded IDs, Valibot schemas, and domain DTO interfaces.
- [plexFormatter.ts](plexFormatter.ts): Deterministic Plex sanitization, `formatTitleWithYear`, split-part, edition, and movie/TV path formatting.
- [plexAudioTagExtractor.ts](plexAudioTagExtractor.ts): Primary audio codec/channel tag and Spanish audio detection helpers.
- [plexTagExtractor.ts](plexTagExtractor.ts): Deterministic Plex movie bracket tag extraction from filename, FFprobe, and track selection.
- [trackSelection.ts](trackSelection.ts): Pure audio track selection helpers (`ensureValidAudioTrackSelection`, `buildFilteredAudioTracks`, `reapplyAudioFilterToItem`).
- [libraryVerifier.ts](libraryVerifier.ts): Pure Plex library compliance verifier and bottom-up rename step planner.

## Work Guidance

- Keep this directory strictly pure (no `node:fs`, `node:http`, or browser DOM imports).

## Verification

- Run `npm run test:coverage` and `npm run auditor:oxlint` after changes.
