# Purpose

External subtitle search and download adapters (keyless and optional keyed APIs).

## Ownership

Backend Maintainers.

## Local Contracts

- All adapters share `applyMediaTypeAndEpisodeParams` in `providerTypes.ts` and enforce strict request timeouts via `AbortSignal.timeout`.
- `openSubtitlesRestProvider.ts` supports optional JWT login (`POST /api/v1/login`) with `OPENSUBTITLES_USERNAME` / `OPENSUBTITLES_PASSWORD` and `401` token refresh retry before `POST /api/v1/download`.

## Key Files

- [providerTypes.ts](providerTypes.ts): Shared search query interface and URL param helpers.
- [openSubtitlesStremioProvider.ts](openSubtitlesStremioProvider.ts): Keyless OpenSubtitles v3 Stremio addon adapter.
- [gestdownProvider.ts](gestdownProvider.ts): Keyless Gestdown TV subtitle adapter.
- [yifySubtitlesProvider.ts](yifySubtitlesProvider.ts): Keyless YIFY movie subtitle adapter.
- [podnapisiProvider.ts](podnapisiProvider.ts): Keyless Podnapisi XML subtitle adapter.
- [openSubtitlesRestProvider.ts](openSubtitlesRestProvider.ts): Official OpenSubtitles REST v1 API adapter.
- [subdlProvider.ts](subdlProvider.ts): SubDL API adapter.

## Work Guidance

- Keep all HTTP calls strictly read-only/idempotent with `AbortSignal.timeout` and `Headers` objects.

## Verification

- Run `npm run test:coverage` after modifying any provider adapter.
