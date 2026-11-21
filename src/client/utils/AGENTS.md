# Purpose

Browser storage helpers for client session IDs and theme persistence.

## Ownership

Frontend Maintainers.

## Local Contracts

- Wrap all `localStorage` and `sessionStorage` calls in `try/catch` for restricted browser contexts.

## Key Files

- [formatters.ts](formatters.ts): Shared UI byte/size, Buenos Aires timestamp, ETA (`formatEta`), clickable candidate links (`extractCandidateLinks`, `formatMetadataIds`), and Plex filename preview helpers.
- [organizerApi.ts](organizerApi.ts): Typed HTTP JSON client, SSE event source factory, and track-selection merge helper for `organizerStore.ts`.
- [storage.ts](storage.ts): Safe `localStorage`/`sessionStorage` helpers for client IDs, theme, table layout, language orders, and server logs auto-scroll (`vo_logs_auto_scroll_v1`).

## Work Guidance

- Never expose raw storage keys outside [storage.ts](storage.ts).

## Verification

- Run `npm run test:coverage` after changes.
