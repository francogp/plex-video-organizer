# Purpose

Vue 3 UI components and accessible modals for the organizer queue and track inspection.

## Ownership

Frontend Maintainers.

## Local Contracts

- Modals must resolve z-index CSS custom properties via `@francogp/auditor/modals`.
- Scoped styles must consume CSS custom properties from `src/client/styles/_tokens.scss`.
- Table headers (`<th>`) must use an opaque surface (`var(--vo-surface-elevated)`) with explicit cell borders, a single horizontal scrollbar on the table wrapper, and `min-width: 0; max-width: 100%;` on cells so content never overlaps adjacent columns.
- `table/VirtualDataTable.vue` owns shared conflict row highlighting (`tr.vo-row--has-conflict` and `tr.vo-row--has-conflict-resolved` using `--vo-danger` / `--vo-warning` tokens, never `--vo-warn`), while `QueueTable.vue` (via `.vo-cell-conflict`) and `VerifierView.vue` render `ConflictActionButton.vue` directly inside the row cell rather than an expanded `#row-after` panel.
- Use monochrome `<UiIcon>` SVG icons (or descriptive `<span aria-hidden="true">` indicators where appropriate) on action buttons, count badges on primary batch triggers, and keep the active progress banner structured into header metrics/cancel controls, one stable `.vo-progress__file` row per slot in `activeTasks` (with optional per-task percentage), and the bottom `<progress>` bar.
- Expose visible-row bulk selection exclusively via the `#vo-select-all-visible` header checkbox in `QueueTable.vue` (never duplicate a toolbar `Select Visible` button), and serve the standalone vector Chevron Stack icon from `public/favicon.svg` across `index.html` and the `src/client/App.vue` header.
- Modularize large table/view SFCs (`QueueTable.vue`, `VerifierView.vue`, `App.vue`) into dedicated header, toolbar, and cell sub-components, keeping shared cell layout and accessibility utilities (`.vo-audio-cell`, `.vo-audio-controls`, `.vo-sr-only`) in `src/client/styles/main.scss` rather than duplicating scoped CSS blocks.
- Match selected metadata candidates in `QueueMetadataCell.vue` by value (`provider`, `externalId`, `title`, `year`) rather than object reference (`===`) so selections survive API refreshes and page reloads.
- Parameterize `LanguageOrderBar.vue` with Vue 3 `generic="T extends string"`, support `lockedCodes` (e.g. `native`, `und`) that can be reordered but not removed, and propagate `props.disabled` to every chip action button (`Move earlier`, `Move later`, `Remove`) in addition to the searchable `+ Add` language picker.
- In `SubtitlePreviewModal.vue`, key `<track :key="vttSrc">` on seek to prevent stale cue accumulation in Chromium, explicitly release the `<video>` stream (`pause` + `removeAttribute('src')` + `load()`) on close/unmount/item change, and suppress benign `AbortError` rejections from `play()`.
- Render Spanish subtitle discovery in `SubtitlePickerModal.vue` sorted by `hashMatch` first and descending `score` rather than truncated inline lists inside `QueueTracksCell.vue`.
- Reuse `ProviderLinks.vue` (via `extractCandidateLinks` from `src/client/utils/formatters.ts`) inside both `QueueMetadataCell.vue` and `MetadataSearchModal.vue`, persist discovered candidates via `ItemPatch.candidates`, highlight the active selection (`✓ Selected` vs `Select`), and expose `Stop After Current` (`drain`) in `OrganizerStatusBar.vue` during `PROCESSING`.
- Use `BaseModalShell.vue` for all application modals (`grid-template-rows: auto minmax(0, 1fr) auto` with `min-block-size: 0; align-content: start; grid-auto-rows: max-content; overscroll-behavior: contain; scrollbar-gutter: stable` on `.vo-operator-modal__body`, auto-focus on open, and `@keydown.esc.stop`), and share `.vo-operator-list` / `.vo-operator-row` (`border-inline-start: 2px solid transparent`) / `.vo-operator-row--active` from `src/client/styles/main.scss` with fixed action columns (`6.25rem`/`7.25rem minmax(0, 1fr)`) so active rows never shift horizontally.
- Keep `.vo-vtable-shell` in `table/VirtualDataTable.vue` on `overflow: clip` (never `overflow: hidden`) so programmatic scroll-into-view or focus events cannot scroll the outer shell and expose blank vertical gaps below the horizontal scrollbar.
- Follow `modern-web-guidance` baseline patterns across client components: prefer `.toSorted()` over `[...arr].sort()` on arrays, keep the native `switch` attribute paired with `.vo-switch` fallback styling on binary queue switches, declare `<meta name="color-scheme" content="dark light">` in `index.html`, and isolate legacy `*::-webkit-scrollbar*` rules inside `@supports not (scrollbar-color: auto)` with `scrollbar-width: auto`.
- **Cross-Tab Mutual Exclusion & Optional Fast-Mode Preview**: `AppHeader.vue` (`controlsDisabled`), `OrganizerWorkspace.vue` (`tablesDisabled`), and `VerifierView.vue` (`controlsDisabled`) mirror backend `409 JOB_IN_PROGRESS` mutual exclusion by disabling Organizer mutations/triggers while Verifier scans or fixes and disabling Verifier controls while `isBusy` is true; `SubtitlePreviewModal.vue` exposes an optional `Fast Mode` (`?fast=1`) toggle that reloads from `absoluteCurrentSeconds` with synchronized WebVTT cues.

## Key Files

- [AppHeader.vue](AppHeader.vue): Top navigation header, workspace tab switcher, mounts drawer, and title/audio language order bars for `App.vue`.
- [BaseModalShell.vue](BaseModalShell.vue): Shared Operator Rail modal shell (backdrop, Escape/outside-click close, compact header, scrollable body, and footer slot) used by all 6 modals.
- [ErrorToast.vue](ErrorToast.vue): Persistent top-right error notification toast (manual dismiss only) with scroll-to-logs trigger for `OrganizerWorkspace.vue`.
- [EtaSimulationModal.vue](EtaSimulationModal.vue): Live Operator Rail ETA simulation modal (KPIs, proportional slot Gantt, queue item/step breakdown, and collapsible calibrator rates with on-demand refresh) triggered from `OrganizerStatusBar.vue`.
- [LanguageOrderBar.vue](LanguageOrderBar.vue): Reusable ordered language-preference chip bar shared by title and audio language preferences.
- [MountBadge.vue](MountBadge.vue): Shared disk-presence badge (`💾`) with mount category tooltip for `QueueMetadataCell.vue` and `MetadataSearchModal.vue`.
- [QueueTable.vue](QueueTable.vue): Dense media queue table.
- [QueueToolbar.vue](QueueToolbar.vue): Filter toolbar, bulk action bar, and output conflict summary banner for `QueueTable.vue`.
- [QueueSourceCell.vue](QueueSourceCell.vue): Source/output path chain, edition input, and inline conflict alert cell for `QueueTable.vue`.
- [QueueMetadataCell.vue](QueueMetadataCell.vue): Metadata match panel, candidate selector, and search button cell for `QueueTable.vue`.
- [QueueAudioCell.vue](QueueAudioCell.vue): Audio volumedetect comparison panel and normalization/codec controls cell for `QueueTable.vue`.
- [QueueTracksCell.vue](QueueTracksCell.vue): Track summary, track inspector trigger, Spanish subtitle modal trigger, and preview trigger cell for `QueueTable.vue`.
- [QueueConflictAlert.vue](QueueConflictAlert.vue): Per-row destination conflict badge and action trigger for `QueueTable.vue`.
- [QueueTracksPanel.vue](QueueTracksPanel.vue): Audio/subtitle count overview and subtitle status panel for `QueueTable.vue`.
- [ParallelTasksList.vue](ParallelTasksList.vue): Shared multi-row parallel slot progress list for `OrganizerStatusBar.vue` and `VerifierView.vue`.
- [ProviderLinks.vue](ProviderLinks.vue): Shared clickable external provider badge links (`IMDb`, `TVDB`, `TMDB`) for `QueueTable.vue` and `VerifierView.vue`.
- [OrganizerStatusBar.vue](OrganizerStatusBar.vue): Organizer active job progress, error, and idle status bar for `App.vue`.
- [OrganizerWorkspace.vue](OrganizerWorkspace.vue): Tabbed workspace container (`OrganizerStatusBar`, `QueueTable`, `VerifierView`, `ServerLogsPanel`, `OrganizerModals`) for `App.vue`.
- [OrganizerModals.vue](OrganizerModals.vue): Grouped modal host (`MetadataSearchModal`, `TrackInspectorModal`, `SubtitlePreviewModal`, `SubtitlePickerModal`, `ConflictResolutionModal`, `EtaSimulationModal`) for `App.vue`.
- [ServerLogsPanel.vue](ServerLogsPanel.vue): Server log viewer panel with clear action for `App.vue`.
- [MetadataSearchModal.vue](MetadataSearchModal.vue): Interactive provider search and manual IMDb/TVDB ID override modal.
- [MetadataResultsList.vue](MetadataResultsList.vue): Candidate results list with provider links and mount badges for `MetadataSearchModal.vue`.
- [TrackInspectorModal.vue](TrackInspectorModal.vue): Audio/subtitle track inspector and series batch apply.
- [SubtitlePickerModal.vue](SubtitlePickerModal.vue): Searchable Spanish subtitle candidate picker modal sorted by best match.
- [SubtitlePreviewModal.vue](SubtitlePreviewModal.vue): In-browser HTML5 video + WebVTT subtitle sync preview modal.
- [ConflictResolutionModal.vue](ConflictResolutionModal.vue): Blocking pre-flight conflict comparator.
- [ConflictActionButton.vue](ConflictActionButton.vue): Shared conflict action button (`Resolve conflict` / `Overwrite` / `Ignore`) for `QueueTable.vue` and `VerifierView.vue`.
- [VerifierView.vue](VerifierView.vue): Plex library naming compliance verifier and bottom-up rename view.
- [VerifierStatusToolbar.vue](VerifierStatusToolbar.vue): Library audit progress bar, summary stats, and filter toolbar for `VerifierView.vue`.
- [VerifierRenamePlanCell.vue](VerifierRenamePlanCell.vue): Grouped bottom-up file and directory rename plan cell for `VerifierView.vue`.
- [UiIcon.vue](UiIcon.vue): Shared monochrome inline SVG icon component (`UiIconName`) inheriting `currentColor` for crisp button contrast.

## Work Guidance

- Keep UI components declarative and emit typed events to `App.vue`.

## Verification

- Run `npm run test:coverage` and `npm run auditor:stylelint` after changes.

## Child DOX Index

- [table/AGENTS.md](table/AGENTS.md): Modular virtualized table engine (`VirtualDataTable.vue`, `FenwickHeightTree`, Web Worker query/sort, and column drag/resize persistence).
