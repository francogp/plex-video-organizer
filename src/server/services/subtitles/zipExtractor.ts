import { inflateRawSync } from 'node:zlib';

const ZIP_LOCAL_FILE_HEADER_SIG = 0x04034b50;
const ZIP_CENTRAL_DIR_SIG = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIR_SIG = 0x06054b50;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;

const CENTRAL_MIN_HEADER_LEN = 46;
const LOCAL_HEADER_FIXED_LEN = 30;
const EOCD_MIN_LEN = 22;
const EOCD_MAX_SEARCH_LEN = 65_557;
const CENTRAL_METHOD_OFFSET = 10;
const CENTRAL_COMP_SIZE_OFFSET = 20;
const CENTRAL_NAME_LEN_OFFSET = 28;
const CENTRAL_EXTRA_LEN_OFFSET = 30;
const CENTRAL_COMMENT_LEN_OFFSET = 32;
const CENTRAL_LOCAL_HEADER_OFFSET = 42;
const LOCAL_NAME_LEN_OFFSET = 26;
const LOCAL_EXTRA_LEN_OFFSET = 28;
const EOCD_TOTAL_ENTRIES_OFFSET = 10;
const EOCD_CD_OFFSET = 16;

function findEndOfCentralDirectory(buf: Buffer): number {
  const minOffset = Math.max(0, buf.length - EOCD_MAX_SEARCH_LEN);
  for (let offset = buf.length - EOCD_MIN_LEN; offset >= minOffset; offset--) {
    if (buf.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIR_SIG) {
      return offset;
    }
  }
  return -1;
}

function decompressEntry(
  buf: Buffer,
  localHeaderOffset: number,
  method: number,
  compressedSize: number
): Buffer | null {
  if (localHeaderOffset + LOCAL_HEADER_FIXED_LEN > buf.length) {
    return null;
  }
  if (buf.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER_SIG) {
    return null;
  }
  const nameLen = buf.readUInt16LE(localHeaderOffset + LOCAL_NAME_LEN_OFFSET);
  const extraLen = buf.readUInt16LE(localHeaderOffset + LOCAL_EXTRA_LEN_OFFSET);
  const dataStart = localHeaderOffset + LOCAL_HEADER_FIXED_LEN + nameLen + extraLen;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > buf.length) {
    return null;
  }
  const payload = buf.subarray(dataStart, dataEnd);
  if (method === ZIP_METHOD_STORE) {
    return payload;
  }
  if (method === ZIP_METHOD_DEFLATE) {
    return inflateRawSync(payload);
  }
  return null;
}

/** Extracts the first `.srt` (or `.vtt` fallback) file from a ZIP archive buffer using `node:zlib`. */
export function extractSubtitleFromZip(zipBuffer: Buffer): {
  readonly fileName: string;
  readonly content: Buffer;
} | null {
  const eocdOffset = findEndOfCentralDirectory(zipBuffer);
  if (eocdOffset < 0) {
    return null;
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + EOCD_TOTAL_ENTRIES_OFFSET);
  let cursor = zipBuffer.readUInt32LE(eocdOffset + EOCD_CD_OFFSET);
  let vttFallback: { readonly fileName: string; readonly content: Buffer } | null = null;

  for (let i = 0; i < totalEntries && cursor + CENTRAL_MIN_HEADER_LEN <= zipBuffer.length; i++) {
    if (zipBuffer.readUInt32LE(cursor) !== ZIP_CENTRAL_DIR_SIG) {
      break;
    }
    const method = zipBuffer.readUInt16LE(cursor + CENTRAL_METHOD_OFFSET);
    const compressedSize = zipBuffer.readUInt32LE(cursor + CENTRAL_COMP_SIZE_OFFSET);
    const nameLen = zipBuffer.readUInt16LE(cursor + CENTRAL_NAME_LEN_OFFSET);
    const extraLen = zipBuffer.readUInt16LE(cursor + CENTRAL_EXTRA_LEN_OFFSET);
    const commentLen = zipBuffer.readUInt16LE(cursor + CENTRAL_COMMENT_LEN_OFFSET);
    const localHeaderOffset = zipBuffer.readUInt32LE(cursor + CENTRAL_LOCAL_HEADER_OFFSET);

    const nameStart = cursor + CENTRAL_MIN_HEADER_LEN;
    const entryName = zipBuffer.subarray(nameStart, nameStart + nameLen).toString('utf8');
    cursor = nameStart + nameLen + extraLen + commentLen;

    const lower = entryName.toLowerCase();
    if (lower.endsWith('.srt')) {
      const content = decompressEntry(zipBuffer, localHeaderOffset, method, compressedSize);
      if (content) {
        return { fileName: entryName, content };
      }
    } else if (!vttFallback && lower.endsWith('.vtt')) {
      const content = decompressEntry(zipBuffer, localHeaderOffset, method, compressedSize);
      if (content) {
        vttFallback = { fileName: entryName, content };
      }
    }
  }

  return vttFallback;
}
