// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { defineComponent, nextTick, ref } from 'vue';

import App from '../../src/client/App.vue';
import BaseModalShell from '../../src/client/components/BaseModalShell.vue';
import ConflictResolutionModal from '../../src/client/components/ConflictResolutionModal.vue';
import EtaSimulationModal from '../../src/client/components/EtaSimulationModal.vue';
import MetadataSearchModal from '../../src/client/components/MetadataSearchModal.vue';
import SubtitlePickerModal from '../../src/client/components/SubtitlePickerModal.vue';
import SubtitlePreviewModal from '../../src/client/components/SubtitlePreviewModal.vue';
import TrackInspectorModal from '../../src/client/components/TrackInspectorModal.vue';
import { useGsapMotion } from '../../src/client/composables/useGsapMotion.ts';
import {
  asIso639_2Code,
  asItemId,
  asTvdbId,
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

  it('TrackInspectorModal distinguishes multiple audio tracks with profile, layout, bitrate, sample rate, and dispositions', () => {
    const wrapper = mount(TrackInspectorModal, {
      props: {
        item: {
          id: asItemId('ti-diff-1'),
          sourcePath: '/in/Foundation.S03E08.mp4',
          relativePath: 'Foundation.S03E08.mp4',
          fileName: 'Foundation.S03E08.mp4',
          mediaKind: 'tv',
          category: 'tv-shows',
          include: true,
          parsedTitle: 'Foundation',
          tags: [],
          probe: {
            durationSeconds: 3000,
            videoStreams: [{ index: 0, codecName: 'hevc', width: 3840, height: 2160 }],
            audioStreams: [
              {
                index: 1,
                streamOrder: 0,
                codecName: 'eac3',
                profile: 'Dolby Digital Plus + Dolby Atmos',
                language: asIso639_2Code('eng'),
                channels: 6,
                channelLayout: '5.1(side)',
                bitrateBps: 768_000,
                sampleRateHz: 48_000,
                isDefault: true,
                isOriginal: true
              },
              {
                index: 2,
                streamOrder: 1,
                codecName: 'eac3',
                language: asIso639_2Code('eng'),
                channels: 6,
                channelLayout: '5.1(side)',
                bitrateBps: 384_000,
                sampleRateHz: 48_000,
                isDefault: false,
                isAudioDescription: true
              }
            ],
            subtitleStreams: []
          },
          externalSubtitles: [],
          trackSelection: {
            audioTracks: [
              { streamOrder: 0, language: asIso639_2Code('eng'), isDefault: true, include: true },
              { streamOrder: 1, language: asIso639_2Code('eng'), isDefault: false, include: true }
            ],
            subtitleMergeMode: 'keep-and-add',
            includedInternalSubtitles: [],
            externalSubtitleOrder: [],
            needsUserPrompt: false
          },
          candidates: [],
          warnings: []
        }
      }
    });

    const text = wrapper.text();
    expect(text).toContain('Dolby Digital Plus + Dolby Atmos');
    expect(text).toContain('5.1(side)');
    expect(text).toContain('768 kbps');
    expect(text).toContain('384 kbps');
    expect(text).toContain('48 kHz');
    expect(text).toContain('Original');
    expect(text).toContain('AD');
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
    await flushPromises();
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
    await flushPromises();
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
    await flushPromises();
    expect(searchFn).toHaveBeenCalled();
    expect(wrapper.text()).toContain('Andor');
    expect(wrapper.find('a.vo-provider-link--tvdb').attributes('href')).toContain('416744');
    expect(wrapper.find('.vo-result-item__title-row').text()).not.toContain('· tvdb');
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

  it('MetadataSearchModal allows clicking Select on any candidate when bulkCount > 1 instead of locking seed match as Selected', async () => {
    const cand2021 = {
      source: 'tvdb' as const,
      title: 'Foundation',
      year: 2021,
      tvdbId: asTvdbId('366972')
    };
    const cand2011 = {
      source: 'tvdb' as const,
      title: 'Foundation',
      year: 2011,
      tvdbId: asTvdbId('248041')
    };
    const wrapper = mount(MetadataSearchModal, {
      props: {
        item: {
          id: asItemId('seed-1'),
          sourcePath: '/input/Foundation.S01E01.mkv',
          relativePath: 'Foundation/Foundation.S01E01.mkv',
          fileName: 'Foundation.S01E01.mkv',
          mediaKind: 'tv',
          category: 'tv-shows',
          parsedTitle: 'Foundation',
          parsedYear: 2021,
          tags: ['4k'],
          warnings: [],
          include: true,
          episodeOrder: 'aired',
          candidates: [cand2021, cand2011],
          selectedMetadata: cand2021,
          externalSubtitles: [],
          probe: {
            formatName: 'matroska',
            durationSeconds: 3000,
            sizeBytes: 1_000_000,
            bitrateBps: 5_000_000,
            videoStreams: [],
            audioStreams: [],
            subtitleStreams: []
          },
          trackSelection: {
            audioTracks: [],
            subtitleMergeMode: 'keep-and-add',
            includedInternalSubtitles: [],
            externalSubtitleOrder: [],
            needsUserPrompt: false
          }
        },
        bulkCount: 30,
        searchFn: async () => []
      }
    });

    const buttons = wrapper.findAll('.vo-result-item button');
    expect(buttons).toHaveLength(2);
    const firstButton = buttons[0];
    expect(firstButton?.text()).toBe('Select');
    if (firstButton) {
      expect((firstButton.element as HTMLButtonElement).disabled).toBe(false);
      await firstButton.trigger('click');
    }
    expect(wrapper.emitted('apply')?.[0]?.[0]).toEqual(cand2021);
  });

  it('SubtitlePreviewModal renders video and track URLs and emits close', async () => {
    const firstItem: ScannedItem = {
      id: asItemId('preview-1'),
      sourcePath: '/data/input/Movie.mkv',
      relativePath: 'Movie.mkv',
      fileName: 'Movie.mkv',
      mediaKind: 'movie',
      category: 'movies',
      parsedTitle: 'Movie',
      include: true,
      tags: [],
      episodeOrder: 'aired',
      probe: {
        formatName: 'matroska',
        durationSeconds: 90,
        sizeBytes: 1_000_000,
        bitrateBps: 2_000_000,
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
    const activeItem = ref<ScannedItem>(firstItem);
    const Host = defineComponent({
      components: { SubtitlePreviewModal },
      setup() {
        const closeCount = ref(0);
        const onClose = (): void => {
          closeCount.value += 1;
        };
        return { activeItem, closeCount, onClose };
      },
      template: '<SubtitlePreviewModal :item="activeItem" @close="onClose" />'
    });
    const wrapper = mount(Host);

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
    await wrapper.find('video').trigger('waiting');
    expect(wrapper.find('video').attributes('src')).toBe('/api/queue/items/preview-1/stream?t=30');
    expect(wrapper.find('track').attributes('src')).toBe(
      '/api/queue/items/preview-1/subtitles/preview.vtt?offset=30'
    );
    expect(wrapper.find('.vo-preview-timeline__status').text()).toBe('Transcoding 480p + AAC...');

    const fastBtn = wrapper.find('button[aria-label="Toggle fast low-CPU preview mode"]');
    expect(fastBtn.exists()).toBe(true);
    expect(fastBtn.attributes('aria-pressed')).toBe('false');

    const videoEl = wrapper.find('video').element as HTMLVideoElement;
    Object.defineProperty(videoEl, 'currentTime', { value: 12, configurable: true });
    await wrapper.find('video').trigger('timeupdate');
    await fastBtn.trigger('click');
    await wrapper.find('video').trigger('waiting');

    expect(fastBtn.attributes('aria-pressed')).toBe('true');
    expect(wrapper.find('video').attributes('src')).toBe(
      '/api/queue/items/preview-1/stream?t=42&fast=1'
    );
    expect(wrapper.find('track').attributes('src')).toBe(
      '/api/queue/items/preview-1/subtitles/preview.vtt?offset=42'
    );
    expect(wrapper.find('.vo-preview-timeline__status').text()).toBe(
      'Transcoding 480p Fast (Low CPU) + AAC...'
    );

    activeItem.value = {
      ...firstItem,
      id: asItemId('preview-2'),
      fileName: 'Movie2.mkv'
    };
    await nextTick();
    expect(fastBtn.attributes('aria-pressed')).toBe('false');
    expect(wrapper.find('video').attributes('src')).toBe('/api/queue/items/preview-2/stream');

    await wrapper.find('button[aria-label="Close subtitle preview"]').trigger('click');
    expect(wrapper.vm.closeCount).toBe(1);
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

  it('BaseModalShell focuses dialog on open and emits close on Escape', async () => {
    const wrapper = mount(BaseModalShell, {
      attachTo: document.body,
      props: { open: true, title: 'Sample Modal' }
    });
    await nextTick();
    const dialog = wrapper.find('[role="dialog"]');
    expect(document.activeElement).toBe(dialog.element);
    await dialog.trigger('keydown.esc');
    expect(wrapper.emitted('close')).toHaveLength(1);
    wrapper.unmount();
  });

  it('TrackInspectorModal collapses internal subtitle streams behind Streams (N) toggle when not selected-only and no conflict', async () => {
    const wrapper = mount(TrackInspectorModal, {
      props: {
        item: {
          id: asItemId('id-sub-toggle'),
          filePath: '/data/input/Movie.mkv',
          fileName: 'Movie.mkv',
          relativeDir: '',
          mediaKind: 'movie',
          category: 'movies',
          sizeBytes: 1000,
          included: true,
          probe: {
            durationSeconds: 120,
            sizeBytes: 1000,
            formatName: 'matroska',
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
            subtitleStreams: [
              { index: 2, streamOrder: 0, codecName: 'subrip', language: asIso639_2Code('eng') },
              { index: 3, streamOrder: 1, codecName: 'subrip', language: asIso639_2Code('spa') }
            ]
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

    const toggle = wrapper.find('.vo-sub-toggle');
    expect(toggle.exists()).toBe(true);
    expect(toggle.text()).toContain('Streams (2)');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('.vo-sub-list').exists()).toBe(false);

    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(wrapper.find('.vo-sub-list').exists()).toBe(true);
  });

  it('EtaSimulationModal renders slots, steps, collapsible rates, and emits refresh', async () => {
    const wrapper = mount(EtaSimulationModal, {
      props: {
        open: true,
        loading: false,
        error: null,
        data: {
          generatedAtMs: new Date(2026, 10, 18, 22, 0, 0).getTime(),
          hostKey: 'env:NAS',
          mode: 'processing',
          workerCount: 2,
          etaSeconds: 3600,
          etaState: 'live_blended',
          weightedFraction: 0.75,
          fallbackShare: 0.1,
          rates: [
            {
              workType: 'loudnorm_p1',
              profile: 'surround',
              baselineRate: 0.88,
              liveRate: 0.75,
              effectiveRate: 1.5,
              source: 'live_blended',
              sampleCount: 40
            },
            {
              workType: 'finalize_io',
              profile: 'default',
              baselineRate: 40 * 1024 * 1024,
              effectiveRate: 40 * 1024 * 1024,
              source: 'baseline',
              sampleCount: 12
            }
          ],
          slots: [
            {
              slotIndex: 0,
              totalSeconds: 3600,
              items: [
                {
                  itemId: asItemId('item-1'),
                  fileName: 'Foundation.S03E05.mkv',
                  status: 'active',
                  totalSeconds: 4200,
                  remainingSeconds: 3600,
                  steps: [
                    {
                      workType: 'loudnorm_p1',
                      profile: 'surround',
                      totalUnits: 2000,
                      completedUnits: 1000,
                      remainingUnits: 1000,
                      totalSeconds: 2000,
                      remainingSeconds: 1000,
                      rateUsed: 1,
                      rateSource: 'live_blended'
                    },
                    {
                      workType: 'remux_loudnorm',
                      profile: 'surround',
                      totalUnits: 2000,
                      completedUnits: 0,
                      remainingUnits: 2000,
                      totalSeconds: 2000,
                      remainingSeconds: 2000,
                      rateUsed: 1,
                      rateSource: 'baseline'
                    },
                    {
                      workType: 'finalize_io',
                      profile: 'default',
                      totalUnits: 1_000_000,
                      completedUnits: 0,
                      remainingUnits: 1_000_000,
                      totalSeconds: 600,
                      remainingSeconds: 600,
                      rateUsed: 1666,
                      rateSource: 'baseline'
                    }
                  ]
                }
              ]
            },
            {
              slotIndex: 1,
              totalSeconds: 1800,
              items: [
                {
                  itemId: asItemId('item-2'),
                  fileName: 'The.Frame.mkv',
                  status: 'pending',
                  totalSeconds: 1800,
                  remainingSeconds: 1800,
                  steps: [
                    {
                      workType: 'remux_peak_gain',
                      profile: 'stereo',
                      totalUnits: 3600,
                      completedUnits: 0,
                      remainingUnits: 3600,
                      totalSeconds: 1500,
                      remainingSeconds: 1500,
                      rateUsed: 2.4,
                      rateSource: 'related_work_type'
                    }
                  ]
                }
              ]
            }
          ]
        }
      }
    });

    const text = wrapper.text();
    expect(text).toContain('1h 0m');
    expect(text).toContain('Finish at 23:00');
    expect(text).not.toContain('(23:00)');
    expect(text).toContain('75%');
    expect(text).toContain('Foundation.S03E05.mkv');
    expect(text).toContain('Pass 1 (50%): 16m 40s');
    expect(text).toContain('Peak: 25m 0s');
    expect(text).toContain('The.Frame.mkv');
    expect(wrapper.findAll('.vo-slot-row')).toHaveLength(2);
    expect(wrapper.findAll('.vo-eta-item-row')).toHaveLength(2);
    expect(wrapper.find('.vo-rate-row').exists()).toBe(false);

    await wrapper.find('.vo-rates-toggle').trigger('click');
    expect(wrapper.findAll('.vo-rate-row')).toHaveLength(2);

    await wrapper.find('.vo-eta-refresh').trigger('click');
    expect(wrapper.emitted('refresh')).toHaveLength(1);
  });

  it('EtaSimulationModal renders Calibrating... instead of No pending work when scanning or non-empty calibration has undefined ETA', () => {
    const scanningWrapper = mount(EtaSimulationModal, {
      props: {
        open: true,
        loading: false,
        error: null,
        data: {
          generatedAtMs: new Date(2026, 10, 18, 22, 0, 0).getTime(),
          hostKey: 'env:NAS',
          mode: 'scanning',
          workerCount: 2,
          etaSeconds: undefined,
          etaState: 'calibrating',
          weightedFraction: 0.25,
          fallbackShare: 0,
          rates: [],
          slots: [
            {
              slotIndex: 0,
              totalSeconds: 120,
              items: [
                {
                  itemId: asItemId('scan-stage-1'),
                  fileName: 'scan_probe (default)',
                  status: 'active',
                  totalSeconds: 120,
                  remainingSeconds: 120,
                  steps: [
                    {
                      workType: 'loudnorm_p1',
                      profile: 'default',
                      totalUnits: 50,
                      completedUnits: 50,
                      remainingUnits: 0,
                      totalSeconds: 50,
                      remainingSeconds: 0,
                      rateUsed: 1,
                      rateSource: 'baseline'
                    },
                    {
                      workType: 'scan_probe',
                      profile: 'default',
                      totalUnits: 10,
                      completedUnits: 2,
                      remainingUnits: 8,
                      totalSeconds: 120,
                      remainingSeconds: 120,
                      rateUsed: 1,
                      rateSource: 'baseline'
                    }
                  ]
                }
              ]
            }
          ]
        }
      }
    });
    expect(scanningWrapper.text()).toContain('Calibrating...');
    expect(scanningWrapper.text()).toContain('Pass 1 (100%)');
    expect(scanningWrapper.text()).toContain('Probe (20%): 2m 0s');
    expect(scanningWrapper.text()).not.toContain('No pending work');

    const emptyPreviewWrapper = mount(EtaSimulationModal, {
      props: {
        open: true,
        loading: false,
        error: null,
        data: {
          generatedAtMs: new Date(2026, 10, 18, 22, 0, 0).getTime(),
          hostKey: 'env:NAS',
          mode: 'preview',
          workerCount: 1,
          etaSeconds: undefined,
          etaState: 'calibrating',
          weightedFraction: 0,
          fallbackShare: 0,
          rates: [],
          slots: [{ slotIndex: 0, totalSeconds: 0, items: [] }]
        }
      }
    });
    expect(emptyPreviewWrapper.text()).toContain('No pending work');
  });

  it('useGsapMotion isolates shell timeline from row entrance and attaches delegated interactions', async () => {
    const { useGsapMotion } = await import('../../src/client/composables/useGsapMotion.ts');
    const root = document.createElement('div');
    const header = document.createElement('header');
    header.className = 'vo-header vo-panel';
    const panel = document.createElement('section');
    panel.className = 'vo-panel';
    const btn = document.createElement('button');
    btn.className = 'vo-btn';
    const input = document.createElement('input');
    input.className = 'vo-input';
    const row = document.createElement('div');
    row.className = 'vo-queue-row';
    root.append(header, panel, btn, input, row);
    document.body.append(root);

    const HostComp = {
      template: '<div />',
      setup() {
        const rootRef = { value: root };
        const motion = useGsapMotion(rootRef as never);
        motion.animateShellTimeline();
        motion.attachInteractiveMotion();
        motion.animateEntrance('.vo-queue-row');
        return {};
      }
    };
    const host = mount(HostComp);

    btn.dispatchEvent(new Event('pointerover', { bubbles: true }));
    btn.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    btn.dispatchEvent(new Event('pointerup', { bubbles: true }));
    btn.dispatchEvent(new Event('pointerout', { bubbles: true }));
    input.dispatchEvent(new Event('focusin', { bubbles: true }));
    input.dispatchEvent(new Event('focusout', { bubbles: true }));
    const select = document.createElement('select');
    select.className = 'vo-select';
    root.append(select);
    select.dispatchEvent(new Event('change', { bubbles: true }));

    const motionMod = await import('../../src/client/composables/useGsapMotion.ts');
    const modalBackdrop = document.createElement('div');
    const modalCard = document.createElement('div');
    modalCard.className = 'vo-operator-modal';
    const modalBody = document.createElement('div');
    modalBody.className = 'vo-operator-modal__body';
    const bodyChild = document.createElement('div');
    modalBody.append(bodyChild);
    modalCard.append(modalBody);
    modalBackdrop.append(modalCard);
    const ganttWrap = document.createElement('div');
    const ganttSeg = document.createElement('div');
    ganttSeg.className = 'vo-slot-seg';
    ganttWrap.append(ganttSeg);
    root.append(modalBackdrop, ganttWrap);

    const enterPanelEl = document.createElement('div');
    const enterToastEl = document.createElement('div');
    const enterTabEl = document.createElement('div');
    const leavePanelEl = document.createElement('div');
    const leaveToastEl = document.createElement('div');
    const leaveTabEl = document.createElement('div');
    root.append(enterPanelEl, enterToastEl, enterTabEl, leavePanelEl, leaveToastEl, leaveTabEl);
    let doneCount = 0;
    const onDone = (): void => {
      doneCount += 1;
    };
    motionMod.animateModalEnter(modalBackdrop, onDone);
    motionMod.animateModalLeave(modalBackdrop, onDone);
    motionMod.animatePanelEnter(enterPanelEl, onDone);
    motionMod.animatePanelLeave(leavePanelEl, onDone);
    motionMod.animateToastEnter(enterToastEl, onDone);
    motionMod.animateToastLeave(leaveToastEl, onDone);
    motionMod.animateTabViewEnter(enterTabEl, onDone, 1);
    motionMod.animateTabViewLeave(leaveTabEl, onDone, -1);
    motionMod.animateStaggerList(modalBody, 'div');
    motionMod.animateGanttSegments(ganttWrap);
    motionMod.playFlip(motionMod.captureFlipState(panel));
    motionMod.smoothScrollToElement(panel);

    const { default: gsap } = await import('gsap');
    await new Promise<void>((resolve) => {
      gsap.delayedCall(0.45, resolve);
    });

    expect(doneCount).toBe(8);
    expect(header.style.opacity).toBe('');
    expect(panel.style.opacity).toBe('');
    host.unmount();
    root.remove();
  });
});
