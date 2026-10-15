/**
 * Utilities for UTF-8 boundary-safe truncation of text.
 */

export const MAX_OTEL_TEXT_BYTES = 64 * 1024; // 64 KiB = 65,536 bytes

export interface TruncationResult {
  text: string;
  truncated: boolean;
  byteLength: number;
}

/**
 * Truncates a string so that its UTF-8 byte length does not exceed `maxBytes`,
 * guaranteeing that it never slices in the middle of a multi-byte UTF-8 sequence.
 */
export function truncateUtf8(
  str: string,
  maxBytes: number = MAX_OTEL_TEXT_BYTES,
): TruncationResult {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) {
    return {
      text: str,
      truncated: false,
      byteLength: buf.length,
    };
  }

  // Find the last valid character boundary at or before maxBytes
  let end = maxBytes;
  // While buf[end] is a continuation byte (0x80..0xBF), step backwards
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end--;
  }

  // If we found a byte > 0, inspect if it is a lead byte whose multi-byte sequence
  // exceeds maxBytes
  if (end > 0) {
    const lead = buf[end]!;
    let seqLen = 1;
    if ((lead & 0xe0) === 0xc0) seqLen = 2;
    else if ((lead & 0xf0) === 0xe0) seqLen = 3;
    else if ((lead & 0xf8) === 0xf0) seqLen = 4;

    if (end + seqLen > maxBytes) {
      // The sequence is cut off; do not include the partial lead byte
    } else {
      end += seqLen;
    }
  }

  const truncatedBuffer = buf.subarray(0, end);
  return {
    text: truncatedBuffer.toString("utf-8"),
    truncated: true,
    byteLength: truncatedBuffer.length,
  };
}
