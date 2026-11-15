import type { AudioStreamInfo, MediaProbeSummary, PlexTagContext } from './types.ts';

const SPANISH_AUDIO_REGEX = /\b(latino|espa[nñ]ol|castellano|spanish[\s._-]*audio|dual)\b/i;

const EIGHT_CHANNEL_COUNT = 8;
const SIX_CHANNEL_COUNT = 6;
const CHANNELS_STEREO = 2;
const CHANNELS_MONO = 1;

const AUDIO_CODEC_TAG_MAP: ReadonlyMap<string, string> = new Map([
  ['eac3', 'DDP'],
  ['ac3', 'AC3'],
  ['aac', 'AAC'],
  ['flac', 'FLAC'],
  ['opus', 'Opus'],
  ['truehd', 'TrueHD'],
  ['dts', 'DTS'],
  ['mp3', 'MP3'],
  ['vorbis', 'Vorbis']
]);

function formatAudioChannelLayout(channels: number): string {
  if (channels >= EIGHT_CHANNEL_COUNT) {
    return '7.1';
  }
  if (channels >= SIX_CHANNEL_COUNT) {
    return '5.1';
  }
  if (channels === CHANNELS_STEREO) {
    return '2.0';
  }
  if (channels === CHANNELS_MONO) {
    return '1.0';
  }
  return channels > 0 ? `${String(channels)}.0` : '2.0';
}

function resolvePrimaryAudioStream(
  probe?: MediaProbeSummary,
  context?: PlexTagContext
): AudioStreamInfo | undefined {
  const streams = probe?.audioStreams ?? [];
  if (streams.length === 0) {
    return undefined;
  }
  const selectedTracks = context?.trackSelection?.audioTracks.filter((track) => track.include);
  if (selectedTracks && selectedTracks.length > 0) {
    const preferred = selectedTracks.find((track) => track.isDefault) ?? selectedTracks[0];
    if (preferred) {
      const matched = streams.find((stream) => stream.streamOrder === preferred.streamOrder);
      if (matched) {
        return matched;
      }
    }
  }
  return streams.find((stream) => stream.isDefault) ?? streams[0];
}

function formatAudioCodecLabel(
  stream: AudioStreamInfo,
  rawName: string,
  overrideCodec?: string
): string {
  if (overrideCodec && overrideCodec !== 'auto') {
    return AUDIO_CODEC_TAG_MAP.get(overrideCodec) ?? overrideCodec.toUpperCase();
  }
  const baseCodec = stream.codecName.toLowerCase();
  const profileLower = `${stream.profile ?? ''} ${stream.title ?? ''}`.toLowerCase();
  const hasAtmos = profileLower.includes('atmos') || /\batmos\b/i.test(rawName);
  if (baseCodec === 'truehd') {
    return hasAtmos ? 'TrueHD Atmos' : 'TrueHD';
  }
  if (baseCodec === 'eac3') {
    return hasAtmos ? 'DDP Atmos' : 'DDP';
  }
  if (baseCodec === 'dts') {
    if (profileLower.includes('dts-hd ma') || profileLower.includes('ma')) {
      return 'DTS-HD MA';
    }
    if (profileLower.includes('hra')) {
      return 'DTS-HD HRA';
    }
    if (profileLower.includes('dts:x') || /\bdts[\s.:_-]*x\b/i.test(rawName)) {
      return 'DTS:X';
    }
    return 'DTS';
  }
  return AUDIO_CODEC_TAG_MAP.get(baseCodec) ?? stream.codecName.toUpperCase();
}

/** Extracts the formatted primary audio codec and channel layout tag (e.g. `DDP Atmos 5.1`). */
export function extractPrimaryAudioTag(
  rawName: string,
  probe?: MediaProbeSummary,
  context?: PlexTagContext
): string | undefined {
  const primaryAudio = resolvePrimaryAudioStream(probe, context);
  if (!primaryAudio) {
    return undefined;
  }
  const effectiveNorm = context?.audioNormalization ?? context?.trackSelection?.audioNormalization;
  const codecLabel = formatAudioCodecLabel(primaryAudio, rawName, effectiveNorm?.codec);
  const effectiveChannels = effectiveNorm?.downmixStereo ? CHANNELS_STEREO : primaryAudio.channels;
  return `${codecLabel} ${formatAudioChannelLayout(effectiveChannels)}`;
}

/** Returns true when Spanish audio is indicated by filename tokens or effective included audio tracks. */
export function hasEffectiveSpanishAudio(
  rawName: string,
  probe?: MediaProbeSummary,
  context?: PlexTagContext
): boolean {
  if (SPANISH_AUDIO_REGEX.test(rawName)) {
    return true;
  }
  const selectedTracks = context?.trackSelection?.audioTracks;
  if (selectedTracks && selectedTracks.length > 0) {
    return selectedTracks.some((track) => track.include && track.language === 'spa');
  }
  return (probe?.audioStreams ?? []).some((stream) => stream.language === 'spa');
}
