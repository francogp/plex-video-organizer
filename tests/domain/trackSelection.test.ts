import { describe, expect, it } from 'vite-plus/test';

import { DEFAULT_AUDIO_PREFERRED_LANGUAGES } from '../../src/domain/constants.ts';
import { buildFilteredAudioTracks } from '../../src/domain/trackSelection.ts';
import { asIso639_2Code, type AudioStreamInfo } from '../../src/domain/types.ts';

function makeAudioStream(
  streamOrder: number,
  language: string,
  options: { readonly isDefault?: boolean; readonly title?: string } = {}
): AudioStreamInfo {
  return {
    index: streamOrder,
    streamOrder,
    codecName: 'eac3',
    language: asIso639_2Code(language),
    title: options.title,
    channels: 6,
    isDefault: options.isDefault ?? false
  };
}

describe('buildFilteredAudioTracks', () => {
  it('never filters single-track audio files even when language is outside preferences', () => {
    const tracks = buildFilteredAudioTracks([makeAudioStream(1, 'fra', { isDefault: false })]);
    expect(tracks).toEqual([
      {
        streamOrder: 1,
        include: true,
        language: asIso639_2Code('fra'),
        isDefault: true
      }
    ]);
  });

  it('filters non-preferred languages and prefers Latin American Spanish over Spain Spanish', () => {
    const streams = [
      makeAudioStream(1, 'eng', { isDefault: true, title: 'English' }),
      makeAudioStream(2, 'fre', { title: 'French (France)' }),
      makeAudioStream(3, 'ger', { title: 'German' }),
      makeAudioStream(4, 'ita', { title: 'Italian' }),
      makeAudioStream(5, 'rus', { title: 'Russian' }),
      makeAudioStream(6, 'spa', { title: 'Spanish (Spain)' }),
      makeAudioStream(7, 'spa', { title: 'Spanish (Latin America)' })
    ];

    const tracks = buildFilteredAudioTracks(streams, DEFAULT_AUDIO_PREFERRED_LANGUAGES);
    expect(
      tracks.map((t) => ({ order: t.streamOrder, include: t.include, def: t.isDefault }))
    ).toEqual([
      { order: 1, include: true, def: true },
      { order: 2, include: false, def: false },
      { order: 3, include: false, def: false },
      { order: 4, include: false, def: false },
      { order: 5, include: false, def: false },
      { order: 6, include: false, def: false },
      { order: 7, include: true, def: false }
    ]);
  });

  it('keeps Spain Spanish when no Latin American Spanish track exists', () => {
    const streams = [
      makeAudioStream(1, 'eng', { isDefault: true }),
      makeAudioStream(2, 'spa', { title: 'Spanish (Spain)' })
    ];

    const tracks = buildFilteredAudioTracks(streams, DEFAULT_AUDIO_PREFERRED_LANGUAGES);
    expect(tracks.map((t) => t.include)).toEqual([true, true]);
  });

  it('falls back to original default track when zero tracks match preferences', () => {
    const streams = [
      makeAudioStream(1, 'fre', { isDefault: false }),
      makeAudioStream(2, 'ger', { isDefault: true })
    ];

    const tracks = buildFilteredAudioTracks(streams, ['eng', 'spa']);
    expect(
      tracks.map((t) => ({ order: t.streamOrder, include: t.include, def: t.isDefault }))
    ).toEqual([
      { order: 1, include: false, def: false },
      { order: 2, include: true, def: true }
    ]);
  });

  it('assigns default by audio preference order when original default was filtered out', () => {
    const streams = [
      makeAudioStream(1, 'fre', { isDefault: true }),
      makeAudioStream(2, 'jpn', { isDefault: false }),
      makeAudioStream(3, 'chi', { isDefault: false }),
      makeAudioStream(4, 'spa', { isDefault: false })
    ];

    const tracks = buildFilteredAudioTracks(streams, ['eng', 'spa', 'zho', 'jpn', 'und']);
    expect(
      tracks.map((t) => ({ order: t.streamOrder, include: t.include, def: t.isDefault }))
    ).toEqual([
      { order: 1, include: false, def: false },
      { order: 2, include: true, def: false },
      { order: 3, include: true, def: false },
      { order: 4, include: true, def: true }
    ]);
  });
});
