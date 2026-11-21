import fs from 'node:fs/promises';
import path from 'node:path';

import { franc } from 'franc-min';

import { LANGUAGE_CODE_MAP, type LanguageAlias } from '../../../domain/constants.ts';
import { asIso639_2Code, type Iso639_2Code } from '../../../domain/types.ts';

const TEXT_SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt', '.ass', '.ssa', '.smi']);
const SUBTITLE_LANG_SAMPLE_BYTES = 32_768;
const MIN_DETECTABLE_CHARS = 40;
const ASS_DIALOGUE_PREFIX = 'dialogue:';
const ASS_DIALOGUE_TEXT_FIELD_INDEX = 9;
const BOM_UTF16_LE_FIRST = 0xff;
const BOM_UTF16_LE_SECOND = 0xfe;

function decodeSubtitleBuffer(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === BOM_UTF16_LE_FIRST && buf[1] === BOM_UTF16_LE_SECOND) {
    return buf.subarray(2).toString('utf16le');
  }
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

/** Strips cue indices, timestamps, ASS metadata, and formatting tags to isolate dialogue prose. */
function stripSubtitleFormatting(raw: string, ext: string): string {
  const isAss = ext === '.ass' || ext === '.ssa';
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (isAss) {
      if (!trimmed.toLowerCase().startsWith(ASS_DIALOGUE_PREFIX)) {
        continue;
      }
      const parts = trimmed.split(',');
      if (parts.length > ASS_DIALOGUE_TEXT_FIELD_INDEX) {
        kept.push(parts.slice(ASS_DIALOGUE_TEXT_FIELD_INDEX).join(','));
      }
      continue;
    }
    if (trimmed.startsWith('WEBVTT') || /^\d+$/.test(trimmed) || trimmed.includes('-->')) {
      continue;
    }
    kept.push(trimmed);
  }

  return kept
    .join(' ')
    .replaceAll(/\{\\[^}]*\}/g, ' ')
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll(/\\N/gi, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function normalizeDetectedIso639(code: string): Iso639_2Code | undefined {
  const lower = code.trim().toLowerCase();
  if (!lower || lower === 'und') {
    return undefined;
  }
  if (Object.hasOwn(LANGUAGE_CODE_MAP, lower)) {
    return asIso639_2Code(LANGUAGE_CODE_MAP[lower as LanguageAlias]);
  }
  return /^[a-z]{3}$/.test(lower) ? asIso639_2Code(lower) : undefined;
}

/**
 * Classifies the spoken language of a text subtitle file using statistical trigram analysis (`franc-min`).
 * Reads only the leading sample window so large NAS directories stay fast.
 */
export async function detectSubtitleTextLanguage(
  filePath: string
): Promise<Iso639_2Code | undefined> {
  const ext = path.extname(filePath).toLowerCase();
  if (!TEXT_SUBTITLE_EXTENSIONS.has(ext)) {
    return undefined;
  }
  try {
    const handle = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(SUBTITLE_LANG_SAMPLE_BYTES);
      const { bytesRead } = await handle.read(buf, 0, SUBTITLE_LANG_SAMPLE_BYTES, 0);
      if (bytesRead <= 0) {
        return undefined;
      }
      const rawText = decodeSubtitleBuffer(buf.subarray(0, bytesRead));
      const cleaned = stripSubtitleFormatting(rawText, ext);
      if (cleaned.length < MIN_DETECTABLE_CHARS) {
        return undefined;
      }
      return normalizeDetectedIso639(franc(cleaned));
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}
