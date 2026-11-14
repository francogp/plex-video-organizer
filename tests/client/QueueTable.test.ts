// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vite-plus/test';

import QueueTable from '../../src/client/components/QueueTable.vue';
import {
  formatBuenosAiresTimestamp,
  formatDuration,
  formatEta,
  formatKbps,
  formatPlexOutputSegments,
  formatProbeStreams,
  formatSizeDeltaMb,
  splitRelativePathSegments
} from '../../src/client/utils/formatters.ts';
import {
  asImdbId,
  asIso639_2Code,
  asItemId,
  asTvdbId,
  type ScannedItem
} from '../../src/domain/types.ts';

const SAMPLE_ITEM: ScannedItem = {
  id: asItemId('item-1'),
  sourcePath: '/input/1917.mkv',
  relativePath: '1917/1917.mkv',
  fileName: '1917.mkv',
  mediaKind: 'movie',
  category: 'movies',
  include: true,
  parsedTitle: '1917',
  parsedYear: 2019,
  tags: ['1080p'],
  probe: {
    formatName: 'matroska',
    durationSeconds: 7000,
    sizeBytes: 4_000_000_000,
    bitrateBps: 4_500_000,
    videoStreams: [{ index: 0, codecName: 'h264', width: 1920, height: 1080 }],
    audioStreams: [],
    subtitleStreams: []
  },
  externalSubtitles: [],
  candidates: [{ title: '1917', year: 2019, imdbId: asImdbId('tt8579674'), source: 'imdb' }],
  selectedMetadata: { title: '1917', year: 2019, imdbId: asImdbId('tt8579674'), source: 'imdb' },
  episodeOrder: 'aired',
  trackSelection: {
    audioTracks: [],
    subtitleMergeMode: 'keep-and-add',
    includedInternalSubtitles: [],
    externalSubtitleOrder: [],
    needsUserPrompt: true,
    promptReason: 'Ambiguous subtitle language'
  },
  warnings: []
};

describe('QueueTable', () => {
  it('renders queue items and emits category and track inspector events', async () => {
    const wrapper = mount(QueueTable, {
      props: { items: [SAMPLE_ITEM], disabled: false }
    });

    expect(wrapper.text()).toContain('1917');
    expect(wrapper.text()).toContain('Resolve Subs');

    const select = wrapper.find('select#cat-item-1');
    await select.setValue('animated-movies');
    expect(wrapper.emitted('change-category')?.[0]?.[1]).toBe('animated-movies');

    const resizer = wrapper.find('.vo-col-resizer');
    await resizer.trigger('keydown.left');
    await resizer.trigger('keydown.right');

    const kindSelect = wrapper.find('select#kind-item-1');
    await kindSelect.setValue('tv');
    expect(wrapper.emitted('change-media-kind')?.[0]?.[1]).toBe('tv');

    const editionInput = wrapper.find('input#ed-item-1');
    await editionInput.setValue('Extended');
    expect(wrapper.emitted('change-edition')?.[0]?.[1]).toBe('Extended');

    const rowButtons = wrapper.findAll('tbody button');
    await rowButtons[0]!.trigger('click');
    expect(wrapper.emitted('search-metadata')?.[0]?.[0]).toEqual(SAMPLE_ITEM);

    await rowButtons[1]!.trigger('click');
    expect(wrapper.emitted('inspect-tracks')?.[0]?.[0]).toEqual(SAMPLE_ITEM);
  });

  it('shows added subtitle summary card without conflict when adding a new subtitle language', () => {
    const newSubItem: ScannedItem = {
      ...SAMPLE_ITEM,
      id: asItemId('item-new-sub'),
      probe: {
        ...SAMPLE_ITEM.probe,
        subtitleStreams: [
          {
            index: 2,
            streamOrder: 0,
            codecName: 'subrip',
            language: asIso639_2Code('eng'),
            isForced: false,
            isHearingImpaired: false
          }
        ]
      },
      externalSubtitles: [
        {
          path: '/input/1917 (2019).es.srt',
          relativePath: '1917 (2019).es.srt',
          extension: '.srt',
          language: asIso639_2Code('spa'),
          isForced: false,
          isHearingImpaired: false,
          isLanguageAmbiguous: false
        }
      ],
      trackSelection: {
        audioTracks: [],
        subtitleMergeMode: 'keep-and-add',
        includedInternalSubtitles: [0],
        externalSubtitleOrder: ['/input/1917 (2019).es.srt'],
        needsUserPrompt: false
      }
    };

    const wrapper = mount(QueueTable, {
      props: { items: [newSubItem], disabled: false }
    });

    expect(wrapper.text()).toContain('+1 new');
    expect(wrapper.text()).toContain('Add:');
    expect(wrapper.text()).toContain('spa');
    expect(wrapper.text()).toContain('Keep:');
    expect(wrapper.text()).toContain('eng');
    expect(wrapper.text()).toContain('Tracks');
    expect(wrapper.text()).not.toContain('Resolve Subs');
  });

  it('filters by query/type/library, sorts columns with aria-sort, and formats Buenos Aires time', async () => {
    const secondItem: ScannedItem = {
      ...SAMPLE_ITEM,
      id: asItemId('item-2'),
      fileName: 'Andor.S01E01.mkv',
      relativePath: 'Andor/Andor.S01E01.mkv',
      parsedTitle: 'Andor',
      mediaKind: 'tv',
      category: 'tv-shows',
      include: false,
      probe: { ...SAMPLE_ITEM.probe, sizeBytes: 1_000_000_000 }
    };

    const wrapper = mount(QueueTable, {
      props: { items: [SAMPLE_ITEM, secondItem], disabled: false }
    });

    expect(wrapper.findAll('tbody tr.vo-queue-row')).toHaveLength(2);

    await wrapper.find('.vo-table-search').setValue('Andor');
    expect(wrapper.findAll('tbody tr.vo-queue-row')).toHaveLength(1);
    expect(wrapper.text()).toContain('Showing 1 of 2');

    await wrapper.find('.vo-table-search').setValue('');
    const sortButtons = wrapper.findAll('thead .vo-sort-btn');
    await sortButtons[1]!.trigger('click'); // Source File ascending -> Andor before 1917? 1917 < Andor
    const titleHeader = wrapper.findAll('thead th')[2]!;
    expect(titleHeader.attributes('aria-sort')).toBe('ascending');

    await sortButtons[1]!.trigger('click');
    expect(titleHeader.attributes('aria-sort')).toBe('descending');
    expect(wrapper.findAll('tbody .vo-file-title')[0]!.text()).toBe('Andor');

    const baTime = formatBuenosAiresTimestamp('2026-11-13T00:34:15.000Z');
    expect(baTime).toContain('21:34:15');
    expect(formatEta(undefined)).toBe('');
    expect(formatEta(45)).toBe('ETA 45s');
    expect(formatEta(3665)).toBe('ETA 1h 1m');
    expect(splitRelativePathSegments('')).toEqual({ folders: [], fileName: '' });
    expect(formatSizeDeltaMb(0, 1_048_576)).toContain('-');
    expect(formatKbps(1_500_000)).toBe('1500 kbps');
    expect(formatDuration(125)).toBe('2m 05s');
    expect(
      formatProbeStreams({
        ...SAMPLE_ITEM.probe,
        videoStreams: [],
        audioStreams: [],
        subtitleStreams: []
      })
    ).toBe('no video · audio: none · subs(0): none');
    expect(
      formatProbeStreams({
        ...SAMPLE_ITEM.probe,
        audioStreams: [
          {
            index: 1,
            streamOrder: 0,
            codecName: 'aac',
            language: asIso639_2Code('eng'),
            channels: 2,
            isDefault: true
          }
        ],
        subtitleStreams: [
          {
            index: 2,
            streamOrder: 0,
            codecName: 'subrip',
            language: asIso639_2Code('spa'),
            isForced: false,
            isHearingImpaired: false
          }
        ]
      })
    ).toBe('1920x1080 · audio: eng · subs(1): spa');

    const formatPlexOutputPreview = (
      item: Parameters<typeof formatPlexOutputSegments>[0]
    ): string | null => {
      const seg = formatPlexOutputSegments(item);
      return seg ? [...seg.folders, seg.fileName].join('/') : null;
    };

    expect(formatPlexOutputPreview(SAMPLE_ITEM)).toContain('1917 (2019) {imdb-tt8579674}');
    expect(
      formatPlexOutputPreview({
        ...secondItem,
        edition: 'Uncut',
        selectedMetadata: {
          title: 'Andor',
          year: 2022,
          tvdbId: asTvdbId('387373'),
          source: 'tvdb'
        },
        episode: { seasonNumber: 1, episodeStart: 2, episodeTitle: 'That Would Be Me' }
      })
    ).toContain(
      'Andor (2022) {tvdb-387373} {edition-Uncut}/Season 01/Andor (2022) - s01e02 - That Would Be Me.mkv'
    );
    expect(
      formatPlexOutputPreview({
        ...SAMPLE_ITEM,
        splitPart: 'pt1',
        selectedMetadata: { title: 'Dune', tmdbId: '438631' as never, source: 'manual' }
      })
    ).toContain('{tmdb-438631}');
    expect(
      formatPlexOutputPreview({
        ...secondItem,
        selectedMetadata: { title: 'Andor', tmdbId: '387373' as never, source: 'tvdb' },
        episode: { seasonNumber: 0, episodeStart: 1 }
      })
    ).toContain('Season 00/Andor - s00e01.mkv');
    expect(formatPlexOutputPreview({ ...secondItem, selectedMetadata: undefined })).toBeNull();
    expect(
      formatPlexOutputPreview({
        ...secondItem,
        selectedMetadata: {
          title: 'There Is Also a Hole in the Student Organization',
          year: 2026,
          tvdbId: asTvdbId('463051'),
          source: 'tvdb'
        },
        episode: {
          seasonNumber: 1,
          episodeStart: 1,
          episodeTitle:
            'Even High School Boys Have Their Holes... Ume Takes Responsibility And Extra Words To Force Budget Trimming'
        }
      })?.length
    ).toBeLessThanOrEqual(180);
    expect(splitRelativePathSegments('Show.s01e01.mkv')).toEqual({
      folders: [],
      fileName: 'Show.s01e01.mkv'
    });
    expect(splitRelativePathSegments('Subdir/Movie.mkv')).toEqual({
      folders: ['Subdir'],
      fileName: 'Movie.mkv'
    });
    expect(splitRelativePathSegments('Standalone.mkv')).toEqual({
      folders: [],
      fileName: 'Standalone.mkv'
    });
  });

  it('supports folder selection and bulk assignment bar actions', async () => {
    const ep1: ScannedItem = {
      ...SAMPLE_ITEM,
      id: asItemId('ep-1'),
      fileName: 'Show.S01E01.mkv',
      relativePath: 'ShowDir/Season 01/Show.S01E01.mkv',
      parsedTitle: 'Show',
      mediaKind: 'tv',
      category: 'tv-shows'
    };
    const ep2: ScannedItem = {
      ...ep1,
      id: asItemId('ep-2'),
      fileName: 'Show.S01E02.mkv',
      relativePath: 'ShowDir/Season 01/Show.S01E02.mkv'
    };

    const wrapper = mount(QueueTable, {
      props: { items: [SAMPLE_ITEM, ep1, ep2], disabled: false }
    });

    const toolbarText = wrapper.find('.vo-table-toolbar').text();
    expect(toolbarText).not.toContain('Select Visible');
    expect(toolbarText).not.toContain('Deselect Visible');

    const headerSelectAll = wrapper.find('#vo-select-all-visible');
    await headerSelectAll.setValue(true);
    expect(wrapper.find('.vo-bulk-bar').text()).toContain('3 selected');
    await headerSelectAll.setValue(false);
    expect(wrapper.find('.vo-bulk-bar').exists()).toBe(false);

    const folderSelect = wrapper.find('select#vo-select-folder');
    await folderSelect.setValue('ShowDir');

    expect(wrapper.find('.vo-bulk-bar').text()).toContain('2 selected');

    await wrapper.find('select[aria-label="Bulk set type"]').setValue('tv');
    expect(wrapper.emitted('bulk-media-kind')?.[0]).toEqual([['ep-1', 'ep-2'], 'tv']);

    await wrapper.find('select[aria-label="Bulk set library"]').setValue('animated-series');
    expect(wrapper.emitted('bulk-category')?.[0]).toEqual([['ep-1', 'ep-2'], 'animated-series']);

    await wrapper.find('select[aria-label="Bulk set audio normalization"]').setValue('peak');
    expect(wrapper.emitted('bulk-audio-normalization')?.[0]).toEqual([['ep-1', 'ep-2'], 'peak']);

    const bulkButtons = wrapper.findAll('.vo-bulk-bar button');
    await bulkButtons[0]!.trigger('click');
    expect(wrapper.emitted('search-metadata-bulk')?.[0]?.[0]).toHaveLength(2);

    await bulkButtons[1]!.trigger('click');
    expect(wrapper.find('.vo-bulk-bar').exists()).toBe(false);
  });

  it('renders inline conflict comparison and resolution controls inside the table row', async () => {
    const wrapper = mount(QueueTable, {
      props: {
        items: [SAMPLE_ITEM],
        disabled: false,
        conflicts: [
          {
            itemId: SAMPLE_ITEM.id,
            sourceFileName: SAMPLE_ITEM.fileName,
            kind: 'existing-file',
            destinationPath: '/output/movies/1917 (2019)/1917 (2019).mkv',
            existingPath: '/output/movies/1917 (2019)/1917 (2019).mkv',
            incoming: SAMPLE_ITEM.probe,
            existing: {
              ...SAMPLE_ITEM.probe,
              sizeBytes: 2_000_000_000,
              bitrateBps: 2_250_000
            }
          }
        ],
        conflictResolutions: {}
      }
    });

    expect(wrapper.text()).toContain('File already exists in output');
    expect(wrapper.text()).toContain('Existing in Output');
    expect(wrapper.text()).toContain('2250 kbps');
    expect(wrapper.text()).toContain('4500 kbps');

    await wrapper.find('select#cdec-item-1').setValue('overwrite');
    expect(wrapper.emitted('resolve-conflict')?.[0]).toEqual(['item-1', 'overwrite']);

    const bannerBtns = wrapper.findAll('.vo-conflict-banner-actions button');
    await bannerBtns[0]!.trigger('click');
    expect(wrapper.emitted('resolve-all-conflicts')?.[0]).toEqual(['overwrite']);

    // Intra-batch conflict without an existing file
    const intraWrapper = mount(QueueTable, {
      props: {
        items: [SAMPLE_ITEM],
        disabled: false,
        conflicts: [
          {
            itemId: SAMPLE_ITEM.id,
            kind: 'intra-batch',
            destinationPath: '/output/movies/1917 (2019)/1917 (2019).mkv',
            incoming: SAMPLE_ITEM.probe
          }
        ],
        conflictResolutions: { [SAMPLE_ITEM.id]: 'ignore' }
      }
    });
    expect(intraWrapper.text()).toContain('Duplicate output destination');
  });

  it('renders audio analysis suggestion and emits audio normalization updates', async () => {
    const analyzedItem: ScannedItem = {
      ...SAMPLE_ITEM,
      probe: {
        ...SAMPLE_ITEM.probe,
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
        audioAnalysis: [
          {
            streamOrder: 0,
            meanVolumeDb: -18.5,
            maxVolumeDb: -5.0,
            suggestion: 'peak-gain',
            recommendedGainDb: 4.0
          }
        ]
      },
      trackSelection: {
        ...SAMPLE_ITEM.trackSelection,
        audioTracks: [
          { streamOrder: 0, include: true, language: asIso639_2Code('eng'), isDefault: true }
        ]
      }
    };

    const wrapper = mount(QueueTable, {
      props: { items: [analyzedItem], disabled: false }
    });

    expect(wrapper.text()).toContain('EAC3 5.1');
    expect(wrapper.text()).toContain('Copy:Avg -18.5 · Peak -5.0 dB');
    expect(wrapper.text()).toContain('Peak +4.0:Avg -14.5 · Peak -1.0 dB');
    expect(wrapper.text()).toContain('Loudnorm:Avg ~-16.0 · Peak -1.5 dB');
    expect((wrapper.find('select#aud-mode-item-1').element as HTMLSelectElement).value).toBe(
      'copy'
    );

    await wrapper.find('select#aud-mode-item-1').setValue('peak');
    expect(wrapper.emitted('change-audio-normalization')?.[0]).toEqual([
      analyzedItem,
      { mode: 'peak', codec: 'auto', downmixStereo: false }
    ]);

    const loudnormItem: ScannedItem = {
      ...analyzedItem,
      probe: {
        ...analyzedItem.probe,
        audioAnalysis: [
          {
            streamOrder: 0,
            meanVolumeDb: -25.0,
            maxVolumeDb: -4.0,
            suggestion: 'loudnorm',
            recommendedGainDb: 3.0
          }
        ]
      },
      trackSelection: {
        ...analyzedItem.trackSelection,
        audioNormalization: { mode: 'loudnorm', codec: 'auto', downmixStereo: false }
      }
    };
    const loudWrapper = mount(QueueTable, {
      props: { items: [loudnormItem], disabled: false }
    });
    expect(loudWrapper.text()).toContain('Copy:Avg -25.0 · Peak -4.0 dB');
    expect(loudWrapper.text()).toContain('Peak +3.0:Avg -22.0 · Peak -1.0 dB');
    expect(loudWrapper.text()).toContain('Loudnorm:Avg ~-16.0 · Peak -1.5 dB');
    await loudWrapper.find('select#aud-codec-item-1').setValue('flac');
    expect(loudWrapper.emitted('change-audio-normalization')?.[0]).toEqual([
      loudnormItem,
      { mode: 'loudnorm', codec: 'flac', downmixStereo: false }
    ]);
    await loudWrapper.find('.vo-audio-downmix input').setValue(true);
    expect(loudWrapper.emitted('change-audio-normalization')?.[1]).toEqual([
      loudnormItem,
      { mode: 'loudnorm', codec: 'auto', downmixStereo: true }
    ]);

    const okItem: ScannedItem = {
      ...analyzedItem,
      probe: {
        ...analyzedItem.probe,
        audioStreams: [
          {
            index: 1,
            streamOrder: 0,
            codecName: 'opus',
            language: asIso639_2Code('jpn'),
            channels: 8,
            isDefault: true
          }
        ],
        audioAnalysis: [
          {
            streamOrder: 0,
            meanVolumeDb: -15.0,
            maxVolumeDb: -0.5,
            suggestion: 'ok',
            recommendedGainDb: 0
          }
        ]
      }
    };
    const okWrapper = mount(QueueTable, {
      props: { items: [okItem], disabled: false }
    });
    expect(okWrapper.text()).toContain('OPUS 7.1');
    expect(okWrapper.text()).toContain('Copy:Avg -15.0 · Peak -0.5 dB');
    expect(okWrapper.text()).toContain('Peak:No headroom (peak ~0 dB)');

    const monoAndSilentWrapper = mount(QueueTable, {
      props: {
        items: [
          {
            ...okItem,
            id: asItemId('mono-1'),
            probe: {
              ...okItem.probe,
              audioStreams: [
                {
                  index: 1,
                  streamOrder: 0,
                  codecName: 'mp3',
                  language: asIso639_2Code('eng'),
                  channels: 1,
                  isDefault: true
                }
              ],
              audioAnalysis: []
            }
          },
          {
            ...okItem,
            id: asItemId('silent-1'),
            include: false,
            probe: { ...okItem.probe, audioStreams: [], audioAnalysis: [] },
            trackSelection: { ...okItem.trackSelection, audioTracks: [] }
          }
        ],
        disabled: false
      }
    });
    expect(monoAndSilentWrapper.text()).toContain('MP3 1ch');
    expect(monoAndSilentWrapper.text()).toContain('No audio');

    await monoAndSilentWrapper.find('#sel-mono-1').setValue(true);
    await monoAndSilentWrapper
      .find('select[aria-label="Bulk set audio normalization"]')
      .setValue('loudnorm');
    expect(monoAndSilentWrapper.emitted('bulk-audio-normalization')?.[0]).toEqual([
      [asItemId('mono-1')],
      'loudnorm'
    ]);

    const { formatBuenosAiresTimestamp, formatSizeDeltaMb, formatSizeMb } =
      await import('../../src/client/utils/formatters.ts');
    expect(formatBuenosAiresTimestamp('invalid-date')).toBe('invalid-date');
    expect(formatBuenosAiresTimestamp('')).toBe('');
    expect(formatSizeMb(1_234_567_890)).toBe('1.177,4 MB');
    expect(formatSizeDeltaMb(2_097_152, 1_048_576)).toBe('+1,0 MB');
    expect(formatSizeDeltaMb(1_048_576, 2_097_152)).toBe('-1,0 MB');

    // Bulk include checkbox acts on selected rows when selection is non-empty
    await monoAndSilentWrapper.find('#vo-include-all').setValue(false);
    expect(monoAndSilentWrapper.emitted('bulk-include')?.[0]).toEqual([
      [asItemId('mono-1')],
      false
    ]);

    // Clearing selection makes #vo-include-all act on all visible rows (silent-1 has include=false)
    await monoAndSilentWrapper.find('#sel-mono-1').setValue(false);
    await monoAndSilentWrapper.find('#vo-include-all').setValue(true);
    expect(monoAndSilentWrapper.emitted('bulk-include')?.[1]).toEqual([
      [asItemId('silent-1')],
      true
    ]);
  });

  it('shows No spa subtitle warning in Tracks column only when neither external nor embedded spa subtitles exist', () => {
    const noSpaItem: ScannedItem = {
      ...SAMPLE_ITEM,
      id: asItemId('no-spa-1'),
      externalSubtitles: [],
      probe: {
        ...SAMPLE_ITEM.probe,
        subtitleStreams: [
          {
            index: 2,
            streamOrder: 0,
            codecName: 'subrip',
            language: asIso639_2Code('eng'),
            isForced: false,
            isHearingImpaired: false
          }
        ]
      },
      trackSelection: {
        ...SAMPLE_ITEM.trackSelection,
        includedInternalSubtitles: [0],
        externalSubtitleOrder: [],
        needsUserPrompt: false,
        promptReason: undefined
      }
    };

    const withExternalSpaItem: ScannedItem = {
      ...noSpaItem,
      id: asItemId('ext-spa-1'),
      externalSubtitles: [
        {
          path: '/input/Movie.spa.srt',
          relativePath: 'Movie.spa.srt',
          extension: '.srt',
          language: asIso639_2Code('spa'),
          isForced: false,
          isHearingImpaired: false,
          isLanguageAmbiguous: false
        }
      ],
      trackSelection: {
        ...noSpaItem.trackSelection,
        externalSubtitleOrder: ['/input/Movie.spa.srt']
      }
    };

    const withEmbeddedSpaItem: ScannedItem = {
      ...noSpaItem,
      id: asItemId('int-spa-1'),
      probe: {
        ...noSpaItem.probe,
        subtitleStreams: [
          {
            index: 2,
            streamOrder: 0,
            codecName: 'subrip',
            language: asIso639_2Code('spa'),
            isForced: false,
            isHearingImpaired: false
          }
        ]
      }
    };

    const noSpaWrapper = mount(QueueTable, {
      props: { items: [noSpaItem], disabled: false }
    });
    expect(noSpaWrapper.text()).toContain('No spa');
    expect(noSpaWrapper.text()).toContain('No Spanish subtitles (file or embedded)');
    expect(noSpaWrapper.find('.vo-audio-panel--warning').exists()).toBe(true);

    const extSpaWrapper = mount(QueueTable, {
      props: { items: [withExternalSpaItem], disabled: false }
    });
    expect(extSpaWrapper.text()).not.toContain('No Spanish subtitles (file or embedded)');
    expect(extSpaWrapper.find('.vo-audio-panel--ok').exists()).toBe(true);

    const intSpaWrapper = mount(QueueTable, {
      props: { items: [withEmbeddedSpaItem], disabled: false }
    });
    expect(intSpaWrapper.text()).not.toContain('No Spanish subtitles (file or embedded)');
    expect(intSpaWrapper.find('.vo-audio-panel--warning').exists()).toBe(false);
  });

  it('emits subtitle search, download, close, and preview events declaratively', async () => {
    const candidate = {
      id: 'c1',
      provider: 'opensubtitles-stremio' as const,
      language: asIso639_2Code('spa'),
      variant: 'latam' as const,
      releaseName: 'Movie.Latino.WEB-DL.srt',
      downloadUrl: 'https://subs.example/1.srt',
      hashMatch: true,
      score: 1080
    };

    const item: ScannedItem = {
      ...SAMPLE_ITEM,
      id: asItemId('sub-picker-1'),
      externalSubtitles: [
        {
          path: '/data/input/Movie.2026.spa.srt',
          relativePath: 'Movie.2026.spa.srt',
          extension: '.srt',
          language: asIso639_2Code('spa'),
          isForced: false,
          isHearingImpaired: false,
          isLanguageAmbiguous: false
        }
      ],
      trackSelection: {
        ...SAMPLE_ITEM.trackSelection,
        externalSubtitleOrder: ['/data/input/Movie.2026.spa.srt']
      }
    };

    const wrapper = mount(QueueTable, {
      props: {
        items: [item],
        disabled: false,
        subtitlePicker: {
          itemId: item.id,
          loading: false,
          downloadingId: null,
          error: null,
          candidates: [candidate]
        }
      }
    });

    const closePickerBtn = wrapper.find('button[aria-label="Close subtitle picker"]');
    expect(closePickerBtn.exists()).toBe(true);
    await closePickerBtn.trigger('click');
    expect(wrapper.emitted('close-subtitle-picker')).toHaveLength(1);

    const candBtn = wrapper.findAll('button').find((b) => b.text().includes('Hash'));
    expect(candBtn).toBeDefined();
    await candBtn!.trigger('click');
    expect(wrapper.emitted('download-subtitle')?.[0]).toEqual([item, candidate]);

    const testBtn = wrapper.findAll('button').find((b) => b.text().includes('Test'));
    expect(testBtn).toBeDefined();
    await testBtn!.trigger('click');
    expect(wrapper.emitted('preview-subtitle')?.[0]?.[0]).toEqual(item);

    const closedWrapper = mount(QueueTable, {
      props: {
        items: [item],
        disabled: false,
        subtitlePicker: null
      }
    });
    const subBtn = closedWrapper.findAll('button').find((b) => b.text().includes('Sub spa'));
    expect(subBtn).toBeDefined();
    await subBtn!.trigger('click');
    expect(closedWrapper.emitted('search-subtitles')?.[0]?.[0]).toEqual(item);
  });

  it('renders clickable provider links in Metadata Match using shared ProviderLinks', () => {
    const wrapper = mount(QueueTable, {
      props: {
        items: [SAMPLE_ITEM],
        disabled: false
      }
    });
    const providerLink = wrapper.find('.vo-provider-link--imdb');
    expect(providerLink.exists()).toBe(true);
    expect(providerLink.attributes('href')).toBe('https://www.imdb.com/title/tt8579674/');
    expect(providerLink.attributes('target')).toBe('_blank');
  });
});
