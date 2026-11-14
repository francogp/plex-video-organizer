# Purpose

Spanish subtitle discovery, scoring, ZIP extraction, sidecar download, and OS/browser player preview services.

## Ownership

Backend Maintainers.

## Local Contracts

- Keyless providers (`opensubtitles-stremio`, `gestdown`, `yify`, `podnapisi`) always execute first without requiring API keys; optional keyed providers (`opensubtitles-rest`, `subdl`) activate only when `.env` keys are configured.
- Downloaded subtitles are written strictly as external `.spa.srt` / `.spa.vtt` sidecar files next to the source video (or under `CONFIG_DIR/subtitles` when read-only) and never muxed into the source video automatically.
- `openInOsPlayer` launches the host OS default video player only in non-headless environments; headless/Docker servers return `{ launched: false, reason: 'headless' }` so the UI opens the in-browser `<video>` + `<track>` WebVTT preview modal.

## Key Files

- [subtitleService.ts](subtitleService.ts): Orchestrates multi-provider search, scoring, and `.spa.srt` sidecar downloads.
- [subtitleScorer.ts](subtitleScorer.ts): Deterministic ranking favoring OpenSubtitles hash matches and Latin American Spanish variants.
- [videoHash.ts](videoHash.ts): 64-bit OpenSubtitles moviehash computation over the first and last 64 KiB chunks.
- [zipExtractor.ts](zipExtractor.ts): Native `node:zlib` ZIP archive extractor for `.srt`/`.vtt` files.
- [playerPreview.ts](playerPreview.ts): OS default player launcher and SRT-to-WebVTT converter.

## Work Guidance

- Keep provider HTTP adapters isolated inside `providers/` and never auto-mux downloaded `.srt` files into video containers.

## Verification

- Run `npm run test:coverage` after modifying subtitle services.

## Child DOX Index

- [providers/AGENTS.md](providers/AGENTS.md): External subtitle provider adapters.
