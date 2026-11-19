# Purpose

Spanish subtitle discovery, scoring, ZIP extraction, sidecar download, and OS/browser player preview services.

## Ownership

Backend Maintainers.

## Local Contracts

- Keyless providers (`opensubtitles-stremio`, `gestdown`, `yify`, `podnapisi`) always execute first without requiring API keys; optional keyed providers (`opensubtitles-rest`, `subdl`) activate only when `.env` keys are configured.
- Downloaded subtitles are written strictly as external `.spa.srt` / `.spa.vtt` sidecar files next to the source video (or under `CONFIG_DIR/subtitles` when read-only) and never muxed into the source video automatically.
- `streamTranscodedPreview` serves a real-time 480p (`fast_bilinear`) H.264 + AAC fragmented MP4 stream via `ffmpeg` (`-g 24`, `-frag_duration 500000`, single pre-input `-ss`, `-skip_loop_filter all`, optional `?fast=1` -> `-skip_frame noref` + `-g 12`, and automatic child process cleanup on client abort) so both local (`npm run dev`) and headless NAS/Docker deployments share low-latency in-browser preview with audio and timeline seeking.
- `convertSrtToVtt` shifts WebVTT cue timestamps by `offsetSeconds` (`?offset=`) and drops cues earlier than the seek point so external subtitles stay synchronized with sought preview streams.

## Key Files

- [subtitleService.ts](subtitleService.ts): Orchestrates multi-provider search, scoring, and `.spa.srt` sidecar downloads.
- [subtitleScorer.ts](subtitleScorer.ts): Deterministic ranking favoring OpenSubtitles hash matches and Latin American Spanish variants.
- [videoHash.ts](videoHash.ts): 64-bit OpenSubtitles moviehash computation over the first and last 64 KiB chunks.
- [zipExtractor.ts](zipExtractor.ts): Native `node:zlib` ZIP archive extractor for `.srt`/`.vtt` files.
- [playerPreview.ts](playerPreview.ts): Real-time `ffmpeg` 480p H.264 + AAC fMP4 preview streamer (with optional `fastDecode` `-skip_frame noref`) and offset-aware SRT-to-WebVTT converter.

## Work Guidance

- Keep provider HTTP adapters isolated inside `providers/` and never auto-mux downloaded `.srt` files into video containers.

## Verification

- Run `npm run test:coverage` after modifying subtitle services.

## Child DOX Index

- [providers/AGENTS.md](providers/AGENTS.md): External subtitle provider adapters.
