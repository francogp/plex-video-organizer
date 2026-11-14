import { RESOLUTION_TAG_MAP, type ResolutionToken } from './constants.ts';
import type { AudioStreamInfo, MediaProbeSummary, PlexTagContext } from './types.ts';

const RESOLUTION_REGEX = /\b(480p|720p|1080p|1440p|2160p|4320p|2k|4k|8k)\b/i;
const EXTENDED_REGEX = /\bextended\b/i;
const DIRECTORS_CUT_REGEX = /\bdirector'?s?[\s._-]*cut\b/i;
const UNRATED_REGEX = /\bunrated\b/i;
const SPANISH_AUDIO_REGEX = /\b(latino|espa[nñ]ol|castellano|spanish[\s._-]*audio|dual)\b/i;
const DOLBY_VISION_REGEX = /\b(?:dv|dovi|dolby[\s._-]*vision)\b/i;
const HDR10_PLUS_REGEX = /\bhdr10\+/i;
const HDR_REGEX = /\bhdr(?:10)?\b/i;
const TEN_BIT_REGEX = /\b10\s*-?\s*bit\b/i;
const HEVC_REGEX = /\b(?:hevc|[xh][._-]?265)\b/i;
const H264_REGEX = /\b(?:avc|[xh][._-]?264)\b/i;
const AV1_REGEX = /\bav1\b/i;
const REMUX_REGEX = /\bremux\b/i;
const BLURAY_REGEX = /\b(?:blu-?ray|bdrip|brrip)\b/i;
const WEBDL_REGEX = /\bweb-?dl\b/i;
const WEBRIP_REGEX = /\bweb-?rip\b/i;
const HDTV_REGEX = /\bhdtv\b/i;

const WIDTH_4K_MIN = 3800;
const WIDTH_2K_MIN = 2500;
const HEIGHT_1080_MIN = 1000;
const HEIGHT_720_MIN = 700;
const TEN_BIT_DEPTH = 10;
const EIGHT_CHANNEL_COUNT = 8;
const SIX_CHANNEL_COUNT = 6;
const CHANNELS_STEREO = 2;
const CHANNELS_MONO = 1;

const VIDEO_CODEC_TAG_MAP: ReadonlyMap<string, string> = new Map([
  ['hevc', 'HEVC'],
  ['h265', 'HEVC'],
  ['h264', 'H.264'],
  ['avc', 'H.264'],
  ['av1', 'AV1'],
  ['vp9', 'VP9'],
  ['mpeg2video', 'MPEG2'],
  ['vc1', 'VC-1']
]);

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

function inferResolutionFromProbe(probe?: MediaProbeSummary): string | undefined {
  const video = probe?.videoStreams[0];
  if (!video) {
    return undefined;
  }
  if (video.width >= WIDTH_4K_MIN) {
    return '4k';
  }
  if (video.width >= WIDTH_2K_MIN) {
    return '2k';
  }
  if (video.height >= HEIGHT_1080_MIN) {
    return '1080p';
  }
  if (video.height >= HEIGHT_720_MIN) {
    return '720p';
  }
  return video.height > 0 ? '480p' : undefined;
}

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
  context?: PlexTagContext
): string {
  const overrideCodec =
    context?.audioNormalization?.codec ?? context?.trackSelection?.audioNormalization?.codec;
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

function extractVideoCodecTag(rawName: string, probe?: MediaProbeSummary): string | undefined {
  const codecName = probe?.videoStreams[0]?.codecName.toLowerCase();
  if (codecName) {
    const mapped = VIDEO_CODEC_TAG_MAP.get(codecName);
    if (mapped) {
      return mapped;
    }
  }
  if (HEVC_REGEX.test(rawName)) {
    return 'HEVC';
  }
  if (H264_REGEX.test(rawName)) {
    return 'H.264';
  }
  if (AV1_REGEX.test(rawName)) {
    return 'AV1';
  }
  return undefined;
}

function extractSourceTag(rawName: string): string | undefined {
  if (REMUX_REGEX.test(rawName)) {
    return 'Remux';
  }
  if (BLURAY_REGEX.test(rawName)) {
    return 'BluRay';
  }
  if (WEBDL_REGEX.test(rawName)) {
    return 'WEB-DL';
  }
  if (WEBRIP_REGEX.test(rawName)) {
    return 'WEBRip';
  }
  if (HDTV_REGEX.test(rawName)) {
    return 'HDTV';
  }
  return undefined;
}

function hasEffectiveSpanishAudio(
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

/** Extracts deterministic Plex bracket tags from filename, FFprobe metadata, and effective track settings. */
export function extractPlexTags(
  rawName: string,
  probe?: MediaProbeSummary,
  context?: PlexTagContext
): readonly string[] {
  const tags: string[] = [];

  const resMatch = RESOLUTION_REGEX.exec(rawName);
  const resToken = resMatch?.[1]?.toLowerCase();
  const resTag =
    resToken && Object.hasOwn(RESOLUTION_TAG_MAP, resToken)
      ? RESOLUTION_TAG_MAP[resToken as ResolutionToken]
      : inferResolutionFromProbe(probe);
  if (resTag) {
    tags.push(resTag);
  }

  const video = probe?.videoStreams[0];
  const isDv = Boolean(video?.hasDolbyVision) || DOLBY_VISION_REGEX.test(rawName);
  const isHdr10Plus = Boolean(video?.hasHdr10Plus) || HDR10_PLUS_REGEX.test(rawName);
  const isHdr =
    HDR_REGEX.test(rawName) ||
    video?.colorTransfer === 'smpte2084' ||
    video?.colorTransfer === 'arib-std-b67';
  if (isDv) {
    tags.push('DV');
  }
  if (isHdr10Plus) {
    tags.push('HDR10+');
  } else if (isHdr) {
    tags.push('HDR');
  }

  const videoCodecTag = extractVideoCodecTag(rawName, probe);
  if (videoCodecTag) {
    tags.push(videoCodecTag);
  }

  const primaryAudio = resolvePrimaryAudioStream(probe, context);
  if (primaryAudio) {
    const codecLabel = formatAudioCodecLabel(primaryAudio, rawName, context);
    const downmixStereo =
      context?.audioNormalization?.downmixStereo ??
      context?.trackSelection?.audioNormalization?.downmixStereo;
    const effectiveChannels = downmixStereo ? CHANNELS_STEREO : primaryAudio.channels;
    tags.push(`${codecLabel} ${formatAudioChannelLayout(effectiveChannels)}`);
  }

  const isTenBit = TEN_BIT_REGEX.test(rawName) || video?.bitDepth === TEN_BIT_DEPTH;
  if (isTenBit) {
    tags.push('10bit');
  }

  const sourceTag = extractSourceTag(rawName);
  if (sourceTag) {
    tags.push(sourceTag);
  }

  if (EXTENDED_REGEX.test(rawName)) {
    tags.push('Extended');
  }
  if (DIRECTORS_CUT_REGEX.test(rawName)) {
    tags.push('Directors Cut');
  }
  if (UNRATED_REGEX.test(rawName)) {
    tags.push('Unrated');
  }
  if (hasEffectiveSpanishAudio(rawName, probe, context)) {
    tags.push('Spanish Audio');
  }

  return tags;
}
