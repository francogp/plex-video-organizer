# Purpose

Pinia reactive stores managing queue state, REST mutations, and SSE live updates.

## Ownership

Frontend Maintainers.

## Local Contracts

- All mutating requests must include the `X-Client-Id` header and current `revision`.
- Revision-mutating actions (`patchItem`, `patchItemsBulk`, `runPreflight`, `startJob`) must execute through a FIFO queue (`enqueueMutation`), and `requestRevisionMutation` must perform one transparent retry on `409 STALE_REVISION` by hydrating `data.state` without surfacing transient `errorMessage` banners.
- **Verifier Lockout Gate & Live ETA Simulation Action**: `organizerStore.ts` gates `canProcessQueue` on `isVerifierActive` (`verifierState.scanning || verifierState.fixing`) alongside `isBusy` (also aborting `409 STALE_REVISION` auto-retries whenever `activeJob !== null` or busy), and exposes `fetchEtaSimulation()` backed by `GET /api/eta/simulation`.

## Key Files

- [organizerStore.ts](organizerStore.ts): Global state, REST actions, and SSE listener.

## Work Guidance

- Keep store actions thin and synchronize state from authoritative server payloads.

## Verification

- Run `npm run test:coverage` to verify `organizerStore.test.ts`.
