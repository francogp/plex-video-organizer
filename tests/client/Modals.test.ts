// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { defineComponent, ref } from 'vue';

import App from '../../src/client/App.vue';
import ConflictResolutionModal from '../../src/client/components/ConflictResolutionModal.vue';
import MetadataSearchModal from '../../src/client/components/MetadataSearchModal.vue';
import SubtitlePickerModal from '../../src/client/components/SubtitlePickerModal.vue';
import SubtitlePreviewModal from '../../src/client/components/SubtitlePreviewModal.vue';
import TrackInspectorModal from '../../src/client/components/TrackInspectorModal.vue';
import { useGsapMotion } from '../../src/client/composables/useGsapMotion.ts';
import {
  asIso639_2Code,
  asItemId,
  type ConflictComparison,
  type ScannedItem
} from '../../src/domain/types.ts';

describe('Client Modals & App', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ConflictResolutionModal displays comparison and emits decisions', async () => {
    const baseProbe = {
      durationSeconds: 100,
      videoStreams: [],
      audioStreams: [],
      subtitleStreams: []
    };
    const conflicts: ConflictComparison[] = [
      {
        itemId: asItemId('c-1'),
        kind: 'existing-file',
        destinationPath: '/movies/Dune (2021)/Dune (2021).mkv',
        incoming: {
          ...baseProbe,
          sizeBytes: 5_000_000,
          formatName: 'matroska',
          bitrateBps: 4_000_000
        },
        existing: { ...baseProbe, sizeBytes: 2_000_000, formatName: 'mp4', bitrateBps: 1_500_000 }
      },
      {
        itemId: asItemId('c-2'),
        kind: 'intra-batch',
        destinationPath: '/movies/Dup (2021)/Dup (2021).mkv',
        incoming: {
          ...baseProbe,
          sizeBytes: 1_000_000,
          formatName: 'matroska',
          bitrateBps: 1_000_000
        }
      }
    ];

    const wrapper = mount(ConflictResolutionModal, {
      props: {
        open: true,
        conflicts,
        diskSpace: [
          {
            category: 'movies',
            targetRoot: '/movies',
            availableBytes: 50_000_000,
            requiredBytes: 5_000_000,
            sufficient: true
          }
        ]
      }
    });

    expect(wrapper.find('.vo-modal-header h2').text()).toContain('Pre-Flight Conflicts');
    expect(wrapper.find('.vo-modal-header .vo-badge').text()).toBe('2');
    expect(wrapper.text()).toContain('Intra-batch collision');

    const confirmBtn = wrapper.find('.vo-btn--primary');
    expect((confirmBtn.element as HTMLButtonElement).disabled).toBe(true);

    const overwriteButtons = wrapper.findAll('button[data-decision="overwrite"]');
    const ignoreButtons = wrapper.findAll('button[data-decision="ignore"]');
    await overwriteButtons[0]!.trigger('click');
    await ignoreButtons[1]!.trigger('click');
    await confirmBtn.trigger('click');

    const emitted = wrapper.emitted('confirm');
    expect(emitted).toBeTruthy();
    expect(emitted?.[0]?.[0]).toEqual({ 'c-1': 'overwrite', 'c-2': 'ignore' });
  });

  it('TrackInspectorModal edits audio/subtitle selection and emits save', async () => {
    const item: ScannedItem = {
      id: asItemId('t-1'),
      sourcePath: '/in/Show.S01E01.mkv',
      relativePath: 'Show.S01E01.mkv',
      fileName: 'Show.S01E01.mkv',
      mediaKind: 'tv',
      category: 'tv-shows',
      parsedTitle: 'Show',
      episodeOrder: 'aired',
      include: true,
      tags: [],
      probe: {
        formatName: 'matroska',
        durationSeconds: 1200,
        sizeBytes: 1_000_000,
        bitrateBps: 1_000_000,
        videoStreams: [{ index: 0, codecName: 'h264', width: 1920, height: 1080 }],
        audioStreams: [
          {
            index: 1,
            streamOrder: 0,
            codecName: 'aac',
            language: asIso639_2Code('und'),
            channels: 2,
            isDefault: false
          }
        ],
        subtitleStreams: []
      },
      externalSubtitles: [
        {
          path: '/in/Show.S01E01.es.srt',
          relativePath: 'Show.S01E01.es.srt',
          extension: '.srt',
          language: asIso639_2Code('spa'),
          isForced: false,
          isHearingImpaired: false,
          isLanguageAmbiguous: false
        }
      ],
      trackSelection: {
        audioTracks: [
          { streamOrder: 0, language: asIso639_2Code('und'), isDefault: false, include: true }
        ],
        subtitleMergeMode: 'keep-and-add',
        includedInternalSubtitles: [],
        externalSubtitleOrder: [],
        needsUserPrompt: true
      },
      candidates: [],
      warnings: []
    };

    const wrapper = mount(TrackInspectorModal, {
      props: { item }
    });

    expect(wrapper.text()).toContain('Track Inspector');
    expect(wrapper.text()).toContain('Show.S01E01.mkv');
    const selects = wrapper.findAll('select');
    await selects[0]!.setValue('spa');
    await selects[1]!.setValue('replace');
    const radio = wrapper.find('input[type="radio"]');
    await radio.setValue(true);

    const saveBtn = wrapper.find('.vo-btn--primary');
    await saveBtn.trigger('click');

    const emitted = wrapper.emitted('save');
    expect(emitted).toBeTruthy();
    expect(emitted?.[0]?.[0]).toMatchObject({
      needsUserPrompt: false,
      subtitleMergeMode: 'replace'
    });
  });

  it('App mounts, fetches state, and toggles theme', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          phase: 'IDLE',
          revision: 1,
          lockOwnerClientId: null,
          mountPaths: {
            configDir: '/config',
            inputDir: '/data/input',
            backupDir: '/data/backup',
            movies: '/data/output/movies',
            documentaries: '/data/output/documentaries',
            'animated-movies': '/data/output/animated-movies',
            'tv-shows': '/data/output/tv-shows',
            'animated-series': '/data/output/animated-series'
          },
          items: [],
          activeJob: null
        }),
        { status: 200 }
      )
    );

    const wrapper = mount(App);
    await new Promise((r) => setTimeout(r, 20));
    expect(wrapper.text()).toContain('Plex Video Organizer');
    const brandIcon = wrapper.find('img.vo-brand-icon');
    expect(brandIcon.exists()).toBe(true);
    expect(brandIcon.attributes('src')).toBe('/favicon.svg');
    expect(brandIcon.attributes('alt')).toBe('');
    expect(brandIcon.attributes('width')).toBe('28');
    expect(brandIcon.attributes('height')).toBe('28');
    wrapper.unmount();

    const NullMotion = defineComponent({
      setup() {
        const nullMotion = useGsapMotion(ref(null));
        nullMotion.animateEntrance('.missing');
        return () => null;
      }
    });
    mount(NullMotion).unmount();
  });

  it('App renders one stable row per parallel active task during SCANNING', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          phase: 'SCANNING',
          revision: 2,
          lockOwnerClientId: 'c1:t1',
          mountPaths: {
            configDir: '/config',
            inputDir: '/data/input',
            backupDir: '/data/backup',
            movies: '/data/output/movies',
            documentaries: '/data/output/documentaries',
            'animated-movies': '/data/output/animated-movies',
            'tv-shows': '/data/output/tv-shows',
            'animated-series': '/data/output/animated-series'
          },
          items: [],
          activeJob: {
            jobId: 'scan',
            totalItems: 10,
            completedItems: 6,
            currentPercent: 51,
            stage: 'scanning',
            stageLabel: 'Analyzing audio (6/10)',
            etaSeconds: 900,
            activeTasks: [
              { slot: 0, itemId: 'item-1', fileName: 'Supergirl.2026.2160p.mp4', percent: 82 },
              { slot: 1, itemId: 'item-2', fileName: 'Dune.2021.1080p.mkv', percent: 34 },
              { slot: 2, itemId: 'item-3', fileName: 'Arrival.2016.1080p.mkv', percent: 15 }
            ]
          }
        }),
        { status: 200 }
      )
    );

    const wrapper = mount(App);
    await new Promise((r) => setTimeout(r, 20));
    const metaText = wrapper.find('.vo-progress__meta').text();
    expect(metaText).toContain('Analyzing audio (6/10)');
    expect(metaText).not.toContain('Supergirl.2026.2160p.mp4');

    const rows = wrapper.findAll('.vo-progress__files .vo-progress__file');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.find('.vo-progress__file-name').text()).toBe('Supergirl.2026.2160p.mp4');
    expect(rows[0]?.find('.vo-progress__file-pct').text()).toBe('82%');
    expect(rows[1]?.find('.vo-progress__file-name').text()).toBe('Dune.2021.1080p.mkv');
    expect(rows[1]?.find('.vo-progress__file-pct').text()).toBe('34%');
    expect(rows[2]?.find('.vo-progress__file-name').text()).toBe('Arrival.2016.1080p.mkv');
    expect(rows[2]?.find('.vo-progress__file-pct').text()).toBe('15%');
    wrapper.unmount();
  });

  it('MetadataSearchModal searches providers and applies candidate', async () => {
    const searchFn = vi.fn().mockResolvedValue([
      {
        title: 'Andor',
        year: 2022,
        tvdbId: '416744',
        source: 'tvdb'
      }
    ]);

    const wrapper = mount(MetadataSearchModal, {
      props: {
        item: {
          id: asItemId('m-1'),
          sourcePath: '/in/Andor.S01E01.mkv',
          relativePath: 'Andor.S01E01.mkv',
          fileName: 'Andor.S01E01.mkv',
          mediaKind: 'tv',
          category: 'tv-shows',
          include: true,
          parsedTitle: 'Andor',
          tags: [],
          episodeOrder: 'aired',
          probe: {
            formatName: 'matroska',
            durationSeconds: 1800,
            sizeBytes: 1_000_000,
            bitrateBps: 1_000_000,
            videoStreams: [],
            audioStreams: [],
            subtitleStreams: []
          },
          externalSubtitles: [],
          candidates: [],
          trackSelection: {
            audioTracks: [],
            subtitleMergeMode: 'keep-and-add',
            includedInternalSubtitles: [],
            externalSubtitleOrder: [],
            needsUserPrompt: false
          },
          warnings: []
        },
        searchFn
      }
    });

    await wrapper.find('.vo-btn--primary').trigger('click');
    await new Promise((r) => setTimeout(r, 10));
    expect(searchFn).toHaveBeenCalled();
    expect(wrapper.text()).toContain('Andor');
    expect(wrapper.find('a.vo-provider-link--tvdb').attributes('href')).toContain('416744');
    const resultBtn = wrapper.find('.vo-result-item button');
    expect(resultBtn.text()).toBe('Select');
    await resultBtn.trigger('click');
    expect(wrapper.emitted('apply')?.[0]?.[2]).toHaveLength(1);
  });

  it('MetadataSearchModal renders bulk selection context when bulkCount > 1', () => {
    const wrapper = mount(MetadataSearchModal, {
      props: {
        item: {
          id: asItemId('m-1'),
          sourcePath: '/in/Andor.S01E01.mkv',
          relativePath: 'Andor.S01E01.mkv',
          fileName: 'Andor.S01E01.mkv',
          mediaKind: 'tv',
          category: 'tv-shows',
          include: true,
          parsedTitle: 'Andor',
          tags: [],
          episodeOrder: 'aired',
          probe: {
            formatName: 'matroska',
            durationSeconds: 1800,
            sizeBytes: 1_000_000,
            bitrateBps: 1_000_000,
            videoStreams: [],
            audioStreams: [],
            subtitleStreams: []
          },
          externalSubtitles: [],
          candidates: [],
          trackSelection: {
            audioTracks: [],
            subtitleMergeMode: 'keep-and-add',
            includedInternalSubtitles: [],
            externalSubtitleOrder: [],
            needsUserPrompt: false
          },
          warnings: []
        },
        bulkCount: 3,
        searchFn: vi.fn().mockResolvedValue([])
      }
    });

    expect(wrapper.text()).toContain('3 selected');
    expect(wrapper.text()).toContain('Applying match to 3 selected items');
  });

  it('SubtitlePreviewModal renders video and track URLs and emits close', async () => {
    const wrapper = mount(SubtitlePreviewModal, {
      props: {
        item: {
          id: asItemId('preview-1'),
          sourcePath: '/data/input/Movie.mkv',
          relativePath: 'Movie.mkv',
          fileName: 'Movie.mkv',
          mediaKind: 'movie',
          category: 'movies',
          parsedTitle: 'Movie',
          include: true,
          tags: [],
          probe: { durationSeconds: 90, videoStreams: [], audioStreams: [], subtitleStreams: [] },
          externalSubtitles: [],
          candidates: [],
          trackSelection: {
            audioTracks: [],
            subtitleMergeMode: 'keep-and-add',
            includedInternalSubtitles: [],
            externalSubtitleOrder: [],
            needsUserPrompt: false
          },
          warnings: []
        }
      }
    });

    expect(wrapper.find('video').attributes('controls')).toBeUndefined();
    expect(wrapper.find('video').attributes('src')).toBe('/api/queue/items/preview-1/stream');
    expect(wrapper.find('track').attributes('src')).toBe(
      '/api/queue/items/preview-1/subtitles/preview.vtt'
    );
    expect(wrapper.find('#vo-preview-seek').attributes('max')).toBe('90');
    await wrapper.find('button[aria-label="Toggle subtitles"]').trigger('click');
    expect(wrapper.find('button[aria-label="Toggle subtitles"]').text()).toContain('CC Off');
    await wrapper.find('button[aria-label="Toggle mute"]').trigger('click');
    expect(wrapper.find('button[aria-label="Toggle mute"]').text()).toContain('Muted');
    const jumpForwardBtn = wrapper.findAll('button').find((btn) => btn.text().includes('+30s'));
    expect(jumpForwardBtn).toBeDefined();
    await jumpForwardBtn!.trigger('click');
    expect(wrapper.find('video').attributes('src')).toBe('/api/queue/items/preview-1/stream?t=30');
    expect(wrapper.find('track').attributes('src')).toBe(
      '/api/queue/items/preview-1/subtitles/preview.vtt?offset=30'
    );
    await wrapper.find('button[aria-label="Close subtitle preview"]').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('SubtitlePickerModal renders >5 candidates, filters by release, and emits download and close', async () => {
    const item: ScannedItem = {
      id: asItemId('sub-pick-1'),
      sourcePath: '/data/input/Mr.Robot.S01E05.mkv',
      relativePath: 'Mr.Robot.S01E05.mkv',
      fileName: 'Mr.Robot.S01E05.mkv',
      mediaKind: 'tv',
      category: 'tv-shows',
      parsedTitle: 'Mr. Robot',
      include: true,
      tags: [],
      episodeOrder: 'aired',
      probe: {
        formatName: 'matroska',
        durationSeconds: 2700,
        sizeBytes: 1000,
        bitrateBps: 1000,
        videoStreams: [],
        audioStreams: [],
        subtitleStreams: []
      },
      externalSubtitles: [],
      candidates: [],
      trackSelection: {
        audioTracks: [],
        subtitleMergeMode: 'keep-and-add',
        includedInternalSubtitles: [],
        externalSubtitleOrder: [],
        needsUserPrompt: false
      },
      warnings: []
    };

    const candidates = Array.from({ length: 8 }, (_, idx) => ({
      id: `sub-${String(idx)}`,
      provider: 'opensubtitles-rest' as const,
      language: asIso639_2Code('spa'),
      variant: idx === 7 ? ('latam' as const) : ('neutral' as const),
      releaseName:
        idx === 7 ? 'Mr.Robot.S01E05.1080p.AMZ' : `Mr.Robot.S01E05.Release.${String(idx)}`,
      downloadUrl: `https://example.com/${String(idx)}.srt`,
      hashMatch: idx === 7,
      downloadCount: 100 - idx,
      score: idx === 7 ? 1380 : 200 + idx
    }));

    const wrapper = mount(SubtitlePickerModal, {
      props: {
        item,
        picker: {
          itemId: item.id,
          loading: false,
          downloadingId: null,
          error: null,
          candidates
        }
      }
    });

    expect(wrapper.findAll('.vo-subtitle-picker__row')).toHaveLength(8);
    expect(wrapper.findAll('.vo-subtitle-picker__release')[0]?.text()).toBe(
      'Mr.Robot.S01E05.1080p.AMZ'
    );
    expect(wrapper.text()).toContain('8 / 8');

    await wrapper.find('#vo-subtitle-filter').setValue('AMZ');
    expect(wrapper.findAll('.vo-subtitle-picker__row')).toHaveLength(1);
    expect(wrapper.text()).toContain('Mr.Robot.S01E05.1080p.AMZ');

    await wrapper.find('.vo-subtitle-picker__dl').trigger('click');
    expect(wrapper.emitted('download')?.[0]).toEqual([item, candidates[7]]);

    await wrapper.find('button[aria-label="Close subtitle picker"]').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('TrackInspectorModal toggles Skip on audio tracks, styles skipped card, reassigns default, and prevents skipping last audio', async () => {
    const wrapper = mount(TrackInspectorModal, {
      props: {
        item: {
          id: asItemId('trk-skip-1'),
          sourcePath: '/in/Dual.mkv',
          relativePath: 'Dual.mkv',
          fileName: 'Dual.mkv',
          mediaKind: 'movie',
          category: 'movies',
          parsedTitle: 'Dual',
          include: true,
          tags: [],
          probe: {
            formatName: 'matroska',
            durationSeconds: 1800,
            sizeBytes: 1_000_000,
            bitrateBps: 1_000_000,
            videoStreams: [],
            audioStreams: [
              {
                index: 1,
                streamOrder: 0,
                codecName: 'eac3',
                language: asIso639_2Code('zho'),
                channels: 6,
                isDefault: true
              },
              {
                index: 2,
                streamOrder: 1,
                codecName: 'eac3',
                language: asIso639_2Code('spa'),
                channels: 6,
                isDefault: false
              }
            ],
            subtitleStreams: []
          },
          externalSubtitles: [],
          candidates: [],
          trackSelection: {
            audioTracks: [
              { streamOrder: 0, include: true, language: asIso639_2Code('zho'), isDefault: true },
              { streamOrder: 1, include: true, language: asIso639_2Code('spa'), isDefault: false }
            ],
            subtitleMergeMode: 'keep-and-add',
            includedInternalSubtitles: [],
            externalSubtitleOrder: [],
            needsUserPrompt: false
          },
          warnings: []
        }
      }
    });

    const skipBtns = wrapper.findAll('.vo-track-actions button');
    expect(skipBtns).toHaveLength(2);
    await skipBtns[0]!.trigger('click');

    const cards = wrapper.findAll('.vo-track-card');
    expect(cards[0]!.classes()).toContain('vo-track-card--skipped');
    expect(cards[0]!.text()).toContain('Skipped');
    expect(cards[1]!.classes()).not.toContain('vo-track-card--skipped');
    // Remaining track cannot be skipped
    expect(skipBtns[1]!.attributes('disabled')).toBeDefined();

    await wrapper.find('.vo-modal-footer .vo-btn--primary').trigger('click');
    const saved = wrapper.emitted('save')?.[0]?.[0] as {
      audioTracks: readonly { streamOrder: number; include: boolean; isDefault: boolean }[];
      audioFilterCustomized?: boolean;
    };
    expect(saved.audioTracks[0]?.include).toBe(false);
    expect(saved.audioTracks[0]?.isDefault).toBe(false);
    expect(saved.audioTracks[1]?.include).toBe(true);
    expect(saved.audioTracks[1]?.isDefault).toBe(true);
    expect(saved.audioFilterCustomized).toBe(true);
  });

  it('TrackInspectorModal supports bulk mode badge and hides apply-to-series checkbox', () => {
    const wrapper = mount(TrackInspectorModal, {
      props: {
        bulkCount: 3,
        item: {
          id: asItemId('t-bulk-1'),
          sourcePath: '/in/Show.S01E01.mkv',
          relativePath: 'Show.S01E01.mkv',
          fileName: 'Show.S01E01.mkv',
          mediaKind: 'tv',
          category: 'tv-shows',
          include: true,
          parsedTitle: 'Show',
          tags: [],
          episodeOrder: 'aired',
          probe: {
            formatName: 'matroska',
            durationSeconds: 1800,
            sizeBytes: 1_000_000,
            bitrateBps: 1_000_000,
            videoStreams: [],
            audioStreams: [
              {
                index: 1,
                streamOrder: 0,
                codecName: 'eac3',
                language: asIso639_2Code('eng'),
                channels: 6,
                isDefault: true
              }
            ],
            subtitleStreams: []
          },
          externalSubtitles: [],
          candidates: [],
          trackSelection: {
            audioTracks: [
              { streamOrder: 0, include: true, language: asIso639_2Code('eng'), isDefault: true }
            ],
            subtitleMergeMode: 'keep-and-add',
            includedInternalSubtitles: [],
            externalSubtitleOrder: [],
            needsUserPrompt: false
          },
          warnings: []
        }
      }
    });

    expect(wrapper.text()).toContain('Applying to 3 selected items');
    expect(wrapper.find('#apply-series').exists()).toBe(false);
  });
});
