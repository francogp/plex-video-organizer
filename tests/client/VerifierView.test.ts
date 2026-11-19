// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vite-plus/test';

import VerifierView from '../../src/client/components/VerifierView.vue';
import {
  asVerifierEntryId,
  type VerifierEntry,
  type VerifierEntryId,
  type VerifierState
} from '../../src/domain/types.ts';

const SAMPLE_ENTRY: VerifierEntry = {
  id: asVerifierEntryId('tv-shows:Fallout {tvdb-416744}'),
  category: 'tv-shows',
  mediaKind: 'tv',
  currentRootName: 'Fallout {tvdb-416744}',
  expectedRootName: 'Fallout (2024) {tvdb-416744}',
  issues: ['MISSING_YEAR', 'NON_STANDARD_SEASON_DIR'],
  steps: [
    {
      kind: 'season-dir',
      fromRelative: 'Fallout {tvdb-416744}/season 1',
      toRelative: 'Fallout {tvdb-416744}/Season 01'
    },
    {
      kind: 'root-dir',
      fromRelative: 'Fallout {tvdb-416744}',
      toRelative: 'Fallout (2024) {tvdb-416744}'
    }
  ],
  resolvedTitle: 'Fallout',
  resolvedYear: 2024
};

describe('VerifierView', () => {
  it('renders pre-scan prompt and status bar before first scan', () => {
    const state: VerifierState = {
      scanning: false,
      fixing: false,
      summary: null,
      entries: [],
      lastFixResult: null
    };
    const wrapper = mount(VerifierView, {
      props: { state, disabled: false }
    });
    expect(wrapper.text()).toContain('Click Scan Libraries to verify Plex naming compliance');
  });

  it('renders clean summary banner when all libraries are compliant', () => {
    const state: VerifierState = {
      scanning: false,
      fixing: false,
      summary: {
        librariesScanned: 5,
        totalRootsAnalyzed: 42,
        compliantRoots: 42,
        issueCount: 0,
        totalSeasonDirsAnalyzed: 110,
        totalFilesAnalyzed: 980,
        scannedAt: '2026-11-13T06:00:00Z'
      },
      entries: [],
      lastFixResult: null
    };
    const wrapper = mount(VerifierView, {
      props: { state, disabled: false }
    });
    expect(wrapper.text()).toContain('42 root folder(s)');
    expect(wrapper.text()).toContain('980 file(s)');
  });

  it('renders non-compliant entries, supports selection, and emits fix with selected IDs', async () => {
    const state: VerifierState = {
      scanning: false,
      fixing: false,
      summary: {
        librariesScanned: 5,
        totalRootsAnalyzed: 10,
        compliantRoots: 9,
        issueCount: 1,
        totalSeasonDirsAnalyzed: 12,
        totalFilesAnalyzed: 50,
        scannedAt: '2026-11-13T06:00:00Z'
      },
      entries: [SAMPLE_ENTRY],
      lastFixResult: null
    };
    const wrapper = mount(VerifierView, {
      props: { state, disabled: false }
    });
    expect(wrapper.text()).toContain('Fallout {tvdb-416744}');
    expect(wrapper.text()).toContain('Fallout (2024) {tvdb-416744}');

    const checkboxes = wrapper.findAll('input[type="checkbox"]');
    await checkboxes[1]?.setValue(true);

    const emitted = wrapper.emitted('update:selectedIds');
    expect(emitted?.at(-1)?.[0]).toEqual([SAMPLE_ENTRY.id]);
  });

  it('filters by library and search query and toggles select-all visible', async () => {
    const state: VerifierState = {
      scanning: false,
      fixing: false,
      summary: {
        librariesScanned: 5,
        totalRootsAnalyzed: 2,
        compliantRoots: 0,
        issueCount: 2,
        totalSeasonDirsAnalyzed: 1,
        totalFilesAnalyzed: 2,
        scannedAt: '2026-11-13T06:00:00Z'
      },
      entries: [
        SAMPLE_ENTRY,
        {
          id: asVerifierEntryId('movies:Dune {imdb-tt1160419}'),
          category: 'movies',
          mediaKind: 'movie',
          currentRootName: 'Dune {imdb-tt1160419}',
          expectedRootName: 'Dune (2021) {imdb-tt1160419}',
          issues: ['MISSING_YEAR'],
          steps: [],
          resolvedTitle: 'Dune',
          resolvedYear: 2021
        }
      ],
      lastFixResult: {
        renamedFiles: 0,
        renamedDirs: 0,
        errors: ['Sample error']
      }
    };
    const wrapper = mount(VerifierView, {
      props: { state, disabled: false }
    });
    expect(wrapper.text()).toContain('Sample error');

    await wrapper.find('select').setValue('movies');
    expect(wrapper.text()).toContain('Dune {imdb-tt1160419}');
    expect(wrapper.text()).not.toContain('Fallout {tvdb-416744}');

    await wrapper.find('select').setValue('all');
    await wrapper.find('input[type="search"]').setValue('fallout');
    expect(wrapper.text()).toContain('Fallout {tvdb-416744}');
    expect(wrapper.text()).not.toContain('Dune {imdb-tt1160419}');

    const headerCheckbox = wrapper.find('thead input[type="checkbox"]');
    await headerCheckbox.setValue(true);
    expect(wrapper.emitted('update:selectedIds')?.at(-1)?.[0]).toEqual([SAMPLE_ENTRY.id]);
    await headerCheckbox.setValue(false);
    expect(wrapper.emitted('update:selectedIds')?.at(-1)?.[0]).toEqual([]);
  });

  it('groups file renames by folder panel and directory renames into a folders panel', () => {
    const groupedEntry: VerifierEntry = {
      id: asVerifierEntryId('animated-series:Batman Beyond {tvdb-75417}'),
      category: 'animated-series',
      mediaKind: 'tv',
      currentRootName: 'Batman Beyond {tvdb-75417}',
      expectedRootName: 'Batman Beyond (1999) {tvdb-75417}',
      issues: ['MISSING_YEAR', 'NON_STANDARD_FILENAME'],
      steps: [
        {
          kind: 'file',
          fromRelative:
            'Batman Beyond {tvdb-75417}/Season 01/Batman Beyond - s01e11 - Tinta mágica.mkv',
          toRelative:
            'Batman Beyond {tvdb-75417}/Season 01/Batman Beyond (1999) - s01e11 - Disappearing Inque.mkv'
        },
        {
          kind: 'file',
          fromRelative:
            'Batman Beyond {tvdb-75417}/Season 01/Batman Beyond - s01e12 - Un toque de Curaré.mkv',
          toRelative:
            'Batman Beyond {tvdb-75417}/Season 01/Batman Beyond (1999) - s01e12 - A Touch of Curare.mkv'
        },
        {
          kind: 'root-dir',
          fromRelative: 'Batman Beyond {tvdb-75417}',
          toRelative: 'Batman Beyond (1999) {tvdb-75417}'
        }
      ],
      resolvedTitle: 'Batman Beyond',
      resolvedYear: 1999
    };

    const state: VerifierState = {
      scanning: false,
      fixing: false,
      summary: {
        librariesScanned: 5,
        totalRootsAnalyzed: 1,
        compliantRoots: 0,
        issueCount: 1,
        totalSeasonDirsAnalyzed: 1,
        totalFilesAnalyzed: 2,
        scannedAt: '2026-11-13T06:00:00Z'
      },
      entries: [groupedEntry],
      lastFixResult: null
    };

    const wrapper = mount(VerifierView, {
      props: { state, disabled: false }
    });

    const panels = wrapper.findAll('.vo-plan-panel');
    expect(panels).toHaveLength(2);
    expect(panels[0]?.find('summary').text()).toContain('Batman Beyond {tvdb-75417} / Season 01');
    expect(panels[0]?.find('summary').text()).toContain('2');
    expect(panels[0]?.findAll('.vo-plan-diff-row')).toHaveLength(2);
    expect(panels[1]?.find('summary').text()).toContain('folders');
    expect(panels[1]?.findAll('.vo-plan-dir-row')).toHaveLength(1);

    const expectedCell = wrapper.find('.vo-diff-card--expected');
    expect(expectedCell.text()).toContain('Batman Beyond (1999) {tvdb-75417}');
    expect(expectedCell.text()).toContain('1999');
    expect(expectedCell.text()).toContain('3 step(s)');
    // Must not duplicate resolvedTitle twice inside the expected card
    expect(expectedCell.text().match(/Batman Beyond/g)).toHaveLength(1);

    const tvdbLink = expectedCell.find('a.vo-provider-link--tvdb');
    expect(tvdbLink.exists()).toBe(true);
    expect(tvdbLink.attributes('href')).toBe('https://www.thetvdb.com/dereferrer/series/75417');
    expect(tvdbLink.attributes('target')).toBe('_blank');
    expect(tvdbLink.find('svg.vo-provider-link__icon').exists()).toBe(true);
  });

  it('extracts TVDB, IMDb, and TMDB external verification links', async () => {
    const { extractExternalIdLinks } = await import('../../src/client/utils/formatters.ts');
    expect(extractExternalIdLinks('Dune (2021) {imdb-tt1160419}', 'movie')).toEqual([
      {
        provider: 'imdb',
        id: 'tt1160419',
        label: 'IMDb',
        url: 'https://www.imdb.com/title/tt1160419/'
      }
    ]);
    expect(extractExternalIdLinks('Show (2020) {tmdb-999}', 'tv')).toEqual([
      {
        provider: 'tmdb',
        id: '999',
        label: 'TMDB',
        url: 'https://www.themoviedb.org/tv/999'
      }
    ]);
  });

  it('renders parallel activeTasks rows with ETA while scanning', () => {
    const state: VerifierState = {
      scanning: true,
      fixing: false,
      progress: {
        completed: 12,
        total: 100,
        percent: 12,
        stageLabel: 'movies',
        activeTasks: [
          { slot: 0, fileName: 'Elysium (2013) {imdb-tt1535108} [4k, HDR, 10bit]', percent: 60 },
          { slot: 1, fileName: 'Dune (2021) {imdb-tt1160419}' }
        ],
        etaSeconds: 45
      },
      summary: null,
      entries: [],
      lastFixResult: null
    };

    const wrapper = mount(VerifierView, {
      props: { state, disabled: false }
    });

    expect(wrapper.find('.vo-progress__meta').text()).toContain('Scanning · 12/100 (12%)');
    expect(wrapper.find('.vo-progress__meta').text()).toContain('ETA 45s');
    expect(wrapper.find('.vo-progress__meta').text()).toContain('movies');
    const rows = wrapper.findAll('.vo-progress__files .vo-progress__file');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.find('.vo-progress__file-name').text()).toBe(
      'Elysium (2013) {imdb-tt1535108} [4k, HDR, 10bit]'
    );
    expect(rows[0]?.find('.vo-progress__file-pct').text()).toBe('60%');
    expect(rows[1]?.find('.vo-progress__file-name').text()).toBe('Dune (2021) {imdb-tt1160419}');
    expect(rows[1]?.find('.vo-progress__file-pct').exists()).toBe(false);
    expect(wrapper.find('progress.vo-progress__bar').attributes('value')).toBe('12');

    const calibratingWrapper = mount(VerifierView, {
      props: {
        state: {
          ...state,
          progress: {
            ...state.progress!,
            etaSeconds: undefined,
            etaState: 'calibrating'
          }
        },
        disabled: false
      }
    });
    expect(calibratingWrapper.find('.vo-progress__meta').text()).toContain('Calibrating...');
  });

  it('renders Destination exists badge, allows selection, and emits resolve-conflict on DESTINATION_COLLISION entries', async () => {
    const state: VerifierState = {
      scanning: false,
      fixing: false,
      progress: null,
      summary: {
        librariesScanned: 1,
        totalRootsAnalyzed: 2,
        totalSeasonDirsAnalyzed: 0,
        totalFilesAnalyzed: 2,
        compliantRoots: 0,
        issueCount: 1,
        scannedAt: '2026-11-14T13:00:00Z'
      },
      entries: [
        {
          id: asVerifierEntryId('movies:Ant-Man (2015)'),
          category: 'movies',
          mediaKind: 'movie',
          currentRootName: 'Ant-Man (2015)',
          expectedRootName: 'Ant-Man (2015) {imdb-tt0478970}',
          issues: ['MISSING_PROVIDER_ID', 'DESTINATION_COLLISION'],
          collisionTarget: 'Ant-Man (2015) {imdb-tt0478970}',
          collisionComparison: {
            itemId: asVerifierEntryId('movies:Ant-Man (2015)'),
            sourceFileName: 'Ant-Man (2015)/Ant-Man.mkv',
            kind: 'existing-file',
            destinationPath: '/movies/Ant-Man (2015) {imdb-tt0478970}/Ant-Man.mkv',
            existingPath: '/movies/Ant-Man (2015)/Ant-Man.mkv',
            incoming: {
              formatName: 'matroska',
              durationSeconds: 7000,
              sizeBytes: 2_000_000_000,
              bitrateBps: 2_200_000,
              videoStreams: [{ index: 0, codecName: 'h264', width: 1920, height: 1080 }],
              audioStreams: [],
              subtitleStreams: []
            },
            existing: {
              formatName: 'matroska',
              durationSeconds: 7000,
              sizeBytes: 1_500_000_000,
              bitrateBps: 1_700_000,
              videoStreams: [{ index: 0, codecName: 'h264', width: 1280, height: 720 }],
              audioStreams: [],
              subtitleStreams: []
            }
          },
          resolvedTitle: 'Ant-Man',
          resolvedYear: 2015,
          steps: [
            {
              kind: 'root-dir',
              fromRelative: 'Ant-Man (2015)',
              toRelative: 'Ant-Man (2015) {imdb-tt0478970}'
            }
          ]
        }
      ],
      lastFixResult: null
    };

    const { defineComponent, h, nextTick, ref } = await import('vue');
    const stateRef = ref<VerifierState>(state);
    const Host = defineComponent({
      setup() {
        return () =>
          h(VerifierView, {
            state: stateRef.value,
            disabled: false,
            conflictResolutions: {},
            'onUpdate:selectedIds': (ids: readonly VerifierEntryId[]) => {
              selectedIdsEmitted.push(ids);
            },
            'onResolve-conflict': () => {
              resolveConflictEmitted += 1;
            }
          });
      }
    });
    const selectedIdsEmitted: (readonly VerifierEntryId[])[] = [];
    let resolveConflictEmitted = 0;
    const wrapper = mount(Host);

    expect(wrapper.text()).toContain('Destination exists');
    expect(wrapper.text()).toContain('Conflict: Ant-Man (2015) {imdb-tt0478970}');
    expect(wrapper.text()).toContain('Showing 1 of 1');
    const rowCheckbox = wrapper.find('input[aria-label="Select Ant-Man (2015)"]');
    expect((rowCheckbox.element as HTMLInputElement).disabled).toBe(false);
    await rowCheckbox.setValue(true);
    expect((rowCheckbox.element as HTMLInputElement).checked).toBe(true);

    // Updating state.entries while keeping the collision entry must preserve its selection
    stateRef.value = { ...state, entries: [...state.entries] };
    await nextTick();
    expect((rowCheckbox.element as HTMLInputElement).checked).toBe(true);
    expect(selectedIdsEmitted.at(-1)).toEqual([asVerifierEntryId('movies:Ant-Man (2015)')]);

    const resolveBtn = wrapper
      .findAll('button')
      .find((btn) => btn.text().includes('Resolve conflict'));
    expect(resolveBtn).toBeDefined();
    await resolveBtn!.trigger('click');
    expect(resolveConflictEmitted).toBe(1);

    const overwriteWrapper = mount(VerifierView, {
      props: {
        state,
        disabled: false,
        conflictResolutions: { [asVerifierEntryId('movies:Ant-Man (2015)')]: 'overwrite' }
      }
    });
    expect(overwriteWrapper.text()).toContain('Overwrite');

    const ignoreWrapper = mount(VerifierView, {
      props: {
        state,
        disabled: false,
        conflictResolutions: { [asVerifierEntryId('movies:Ant-Man (2015)')]: 'ignore' }
      }
    });
    expect(ignoreWrapper.text()).toContain('Ignore');

    for (const activeFlags of [
      { scanning: false, fixing: true },
      { scanning: true, fixing: false }
    ]) {
      const busyWrapper = mount(VerifierView, {
        props: {
          state: { ...state, ...activeFlags },
          disabled: false,
          conflictResolutions: {}
        }
      });
      const busyHeaderCheckbox = busyWrapper.find('thead input[type="checkbox"]');
      const busyRowCheckbox = busyWrapper.find('input[aria-label="Select Ant-Man (2015)"]');
      const busyConflictBtn = busyWrapper
        .findAll('button')
        .find((btn) => btn.text().includes('Resolve conflict'));
      expect((busyHeaderCheckbox.element as HTMLInputElement).disabled).toBe(true);
      expect((busyRowCheckbox.element as HTMLInputElement).disabled).toBe(true);
      expect((busyConflictBtn!.element as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
