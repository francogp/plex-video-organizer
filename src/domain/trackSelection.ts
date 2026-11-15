import {
  DEFAULT_AUDIO_PREFERRED_LANGUAGES,
  LANGUAGE_CODE_MAP,
  type LanguageAlias
} from './constants.ts';
import { extractPlexTags } from './plexTagExtractor.ts';
import {
  asIso639_2Code,
  type AudioLanguageCode,
  type AudioStreamInfo,
  type Iso639_2Code,
  type ScannedItem,
  type TrackSelection
} from './types.ts';

function normalizeAudioLanguageCode(raw: string): Iso639_2Code {
  const clean = raw.trim().toLowerCase();
  if (Object.hasOwn(LANGUAGE_CODE_MAP, clean)) {
    return asIso639_2Code(LANGUAGE_CODE_MAP[clean as LanguageAlias]);
  }
  return asIso639_2Code(/^[a-z]{3}$/.test(clean) ? clean : 'und');
}

const SPANISH_VARIANTS = ['latam', 'spain', 'neutral'] as const;
type SpanishVariant = (typeof SPANISH_VARIANTS)[number];

const LATAM_SPANISH_PATTERN = /\b(latin\s*america|latinoamerica|latam|latino|es-419|es-mx|es-la)\b/;
const SPAIN_SPANISH_PATTERN = /\b(spain|espana|castellano|es-es)\b/;

function classifySpanishVariant(title?: string): SpanishVariant {
  if (!title) {
    return 'neutral';
  }
  const normalized = title
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (LATAM_SPANISH_PATTERN.test(normalized)) {
    return 'latam';
  }
  if (SPAIN_SPANISH_PATTERN.test(normalized)) {
    return 'spain';
  }
  return 'neutral';
}

/**
 * Ensures at least one audio track remains included and exactly one included track is marked default.
 */
export function ensureValidAudioTrackSelection<
  T extends { readonly include: boolean; readonly isDefault: boolean }
>(tracks: readonly T[]): T[] {
  if (tracks.length === 0) {
    return [];
  }

  let targetIdx = tracks.findIndex((track) => track.include && track.isDefault);
  if (targetIdx < 0) {
    targetIdx = tracks.findIndex((track) => track.include);
  }
  const forceIncludeFirst = targetIdx < 0;
  if (forceIncludeFirst) {
    targetIdx = 0;
  }

  return tracks.map((track, idx) => ({
    ...track,
    include: forceIncludeFirst && idx === 0 ? true : track.include,
    isDefault: idx === targetIdx
  }));
}

/**
 * Builds initial audio track selections using audio language preferences.
 * Single-track files are never filtered; multi-track files prefer Latin American Spanish over Spain Spanish.
 */
export function buildFilteredAudioTracks(
  audioStreams: readonly AudioStreamInfo[],
  audioPreferredLanguages: readonly AudioLanguageCode[] = DEFAULT_AUDIO_PREFERRED_LANGUAGES
): TrackSelection['audioTracks'][number][] {
  if (audioStreams.length === 0) {
    return [];
  }

  if (audioStreams.length === 1) {
    const only = audioStreams[0]!;
    return ensureValidAudioTrackSelection([
      {
        streamOrder: only.streamOrder,
        include: true,
        language: only.language,
        isDefault: true
      }
    ]);
  }

  const effectiveOrder =
    audioPreferredLanguages.length > 0
      ? audioPreferredLanguages
      : DEFAULT_AUDIO_PREFERRED_LANGUAGES;
  const preferredRank = new Map<string, number>();
  for (const [idx, code] of effectiveOrder.entries()) {
    const normalized = normalizeAudioLanguageCode(code);
    if (!preferredRank.has(normalized)) {
      preferredRank.set(normalized, idx);
    }
  }

  const normalizedLangs = audioStreams.map((stream) => normalizeAudioLanguageCode(stream.language));
  const spanishVariants = audioStreams.map((stream, idx) =>
    normalizedLangs[idx] === 'spa' ? classifySpanishVariant(stream.title) : 'neutral'
  );
  const hasLatAmSpa = spanishVariants.includes('latam');
  const hasSpainSpa = spanishVariants.includes('spain');

  const includedFlags = audioStreams.map((_, idx) => {
    const lang = normalizedLangs[idx]!;
    if (!preferredRank.has(lang)) {
      return false;
    }
    if (lang === 'spa' && hasLatAmSpa && hasSpainSpa && spanishVariants[idx] === 'spain') {
      return false;
    }
    return true;
  });

  if (!includedFlags.some(Boolean)) {
    const originalDefaultIdx = audioStreams.findIndex((stream) => stream.isDefault);
    const fallbackIdx = Math.max(0, originalDefaultIdx);
    includedFlags[fallbackIdx] = true;
  }

  const keptOriginalDefaultIdx = audioStreams.findIndex(
    (stream, idx) => includedFlags[idx] && stream.isDefault
  );
  let chosenDefaultIdx = keptOriginalDefaultIdx;
  if (chosenDefaultIdx < 0) {
    let bestRank = Number.POSITIVE_INFINITY;
    for (const [idx, isIncluded] of includedFlags.entries()) {
      if (!isIncluded) {
        continue;
      }
      const rank = preferredRank.get(normalizedLangs[idx]!) ?? Number.POSITIVE_INFINITY;
      if (rank < bestRank) {
        bestRank = rank;
        chosenDefaultIdx = idx;
      }
    }
    if (chosenDefaultIdx < 0) {
      chosenDefaultIdx = includedFlags.findIndex(Boolean);
    }
  }

  return ensureValidAudioTrackSelection(
    audioStreams.map((stream, idx) => ({
      streamOrder: stream.streamOrder,
      include: Boolean(includedFlags[idx]),
      language: stream.language,
      isDefault: idx === chosenDefaultIdx
    }))
  );
}

/** Reapplies audio language filtering and refreshes Plex audio tags on an uncustomized queue item. */
export function reapplyAudioFilterToItem(
  item: ScannedItem,
  stemWithoutExt: string,
  audioPreferredLanguages: readonly AudioLanguageCode[]
): ScannedItem {
  if (item.trackSelection.audioFilterCustomized) {
    return item;
  }
  const nextTrackSelection: TrackSelection = {
    ...item.trackSelection,
    audioTracks: buildFilteredAudioTracks(item.probe.audioStreams, audioPreferredLanguages)
  };
  return {
    ...item,
    trackSelection: nextTrackSelection,
    tags: extractPlexTags(stemWithoutExt, item.probe, { trackSelection: nextTrackSelection })
  };
}
