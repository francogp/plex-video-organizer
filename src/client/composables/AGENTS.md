# Purpose

Vue 3 composables for scoped UI behavior and motion.

## Ownership

Frontend Maintainers.

## Local Contracts

- All GSAP timelines/contexts must respect `prefers-reduced-motion` and revert on `onUnmounted`.
- Isolate GSAP `shellCtx` from `rowsCtx` in `useGsapMotion.ts` so row entrance updates never revert shell timelines; exclude `.vo-header` from `.vo-panel:not(.vo-header)` stagger and use `gsap.fromTo` (`opacity: 0 -> 1` with `clearProps: 'transform,opacity'`) so headers never remain stuck invisible on re-renders.
- Centralize all `<Transition :css="false">` enter/leave hooks (`animateModalEnter`/`Leave`, `animatePanelEnter`/`Leave`, `animateToastEnter`/`Leave`, `animateTabViewEnter`/`Leave`), `Flip` layout transitions (`captureFlipState`/`playFlip`), `ScrollToPlugin` (`smoothScrollToElement`), list/Gantt staggers, and delegated GPU micro-interactions (`attachInteractiveMotion`) inside `useGsapMotion.ts`, respecting `prefers-reduced-motion: reduce` (note: Windows `SPI_GETCLIENTAREAANIMATION = False`, e.g. after TeamViewer/RDP sessions, forces Chromium `prefers-reduced-motion: reduce` to `true`).

## Key Files

- [useGsapMotion.ts](useGsapMotion.ts): Scoped GSAP entrance animation composable.
- [useOrganizerWorkflow.ts](useOrganizerWorkflow.ts): Modal state, bulk actions, subtitle picker, and verifier conflict workflow composable for `App.vue`.

## Work Guidance

- Always declare explicit return types on exported composables.

## Verification

- Run `npm run test:coverage` and `npm run auditor:oxlint` after changes.
