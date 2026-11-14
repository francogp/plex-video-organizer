import fs from 'node:fs/promises';

const HASH_CHUNK_BYTES = 65_536;
const UINT64_MASK = 0xffff_ffff_ffff_ffffn;
const BYTES_PER_UINT64 = 8;
const HEX_PAD_LENGTH = 16;

export interface VideoHashInfo {
  readonly videoHash: string;
  readonly videoSize: number;
}

function sumBufferUint64LE(buf: Buffer): bigint {
  let sum = 0n;
  const alignedLength = buf.length - (buf.length % BYTES_PER_UINT64);
  for (let offset = 0; offset < alignedLength; offset += BYTES_PER_UINT64) {
    sum = (sum + buf.readBigUInt64LE(offset)) & UINT64_MASK;
  }
  return sum;
}

/** Computes the 64-bit OpenSubtitles hash (first 64KB + last 64KB + file size). */
export async function computeOpenSubtitlesHash(filePath: string): Promise<VideoHashInfo> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const fileSize = stat.size;
    if (fileSize < HASH_CHUNK_BYTES) {
      const buf = Buffer.alloc(fileSize);
      await handle.read(buf, 0, fileSize, 0);
      const hash = (BigInt(fileSize) + sumBufferUint64LE(buf)) & UINT64_MASK;
      return {
        videoHash: hash.toString(16).padStart(HEX_PAD_LENGTH, '0'),
        videoSize: fileSize
      };
    }

    const head = Buffer.alloc(HASH_CHUNK_BYTES);
    const tail = Buffer.alloc(HASH_CHUNK_BYTES);
    await handle.read(head, 0, HASH_CHUNK_BYTES, 0);
    await handle.read(tail, 0, HASH_CHUNK_BYTES, fileSize - HASH_CHUNK_BYTES);

    const hash =
      (BigInt(fileSize) + sumBufferUint64LE(head) + sumBufferUint64LE(tail)) & UINT64_MASK;
    return {
      videoHash: hash.toString(16).padStart(HEX_PAD_LENGTH, '0'),
      videoSize: fileSize
    };
  } finally {
    await handle.close();
  }
}
