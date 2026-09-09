// Editor metadata is a review signal, never proof that payment was altered.
// Compressed image pixels are not metadata and must never be searched as text.
const MAX_METADATA_BYTES = 64 * 1024;
const editorSignature =
  /adobe\s*photoshop|gimp|pixlr|snapseed|picsart|lightroom|inkscape/i;
const decoder = new TextDecoder("latin1");

function text(bytes: Uint8Array): string {
  return decoder.decode(bytes.subarray(0, MAX_METADATA_BYTES));
}

function u32(bytes: Uint8Array, offset: number, littleEndian = false): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(offset, littleEndian);
}

async function inflatedText(bytes: Uint8Array): Promise<string> {
  if (!bytes.length || bytes.length > MAX_METADATA_BYTES) return "";
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(
    new DecompressionStream("deflate"),
  );
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < MAX_METADATA_BYTES) {
      const next = await reader.read();
      if (next.done) break;
      const part = next.value.subarray(0, MAX_METADATA_BYTES - length);
      parts.push(part);
      length += part.length;
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return text(result);
  } catch {
    return "";
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function pngText(type: string, bytes: Uint8Array): Promise<string> {
  if (type === "eXIf" || type === "tEXt") return text(bytes);
  const keywordEnd = bytes.indexOf(0);
  if (keywordEnd < 0 || keywordEnd > 79) return "";
  const keyword = text(bytes.subarray(0, keywordEnd));
  if (type === "zTXt") {
    if (bytes[keywordEnd + 1] !== 0) return "";
    return keyword + "\n" + await inflatedText(bytes.subarray(keywordEnd + 2));
  }
  if (type !== "iTXt" || keywordEnd + 3 >= bytes.length) return "";
  const compressed = bytes[keywordEnd + 1];
  if (compressed > 1 || bytes[keywordEnd + 2] !== 0) return "";
  const languageEnd = bytes.indexOf(0, keywordEnd + 3);
  if (languageEnd < 0) return "";
  const translatedEnd = bytes.indexOf(0, languageEnd + 1);
  if (translatedEnd < 0) return "";
  const content = bytes.subarray(translatedEnd + 1);
  return keyword + "\n" +
    (compressed === 1 ? await inflatedText(content) : text(content));
}

async function pngHasEditor(bytes: Uint8Array): Promise<boolean> {
  let offset = 8;
  let examined = 0;
  while (offset + 12 <= bytes.length) {
    const length = u32(bytes, offset);
    if (length > bytes.length - offset - 12) return false;
    const type = text(bytes.subarray(offset + 4, offset + 8));
    if (["eXIf", "tEXt", "iTXt", "zTXt"].includes(type)) {
      if (length > MAX_METADATA_BYTES - examined) return false;
      const metadata = await pngText(
        type,
        bytes.subarray(offset + 8, offset + 8 + length),
      );
      if (
        editorSignature.test(metadata.slice(0, MAX_METADATA_BYTES - examined))
      ) return true;
      examined += Math.max(length, metadata.length);
      if (examined >= MAX_METADATA_BYTES) return false;
    }
    offset += length + 12;
    if (type === "IEND") break;
  }
  return false;
}

function jpegHasEditor(bytes: Uint8Array): boolean {
  let offset = 2;
  let examined = 0;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset++];
    // Start of scan begins compressed pixels. Never search the entropy data.
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) return false;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || length > bytes.length - offset) return false;
    // APP1 holds EXIF/XMP, APP13 holds IPTC/editor resources, COM is text.
    if (marker === 0xe1 || marker === 0xed || marker === 0xfe) {
      if (length - 2 > MAX_METADATA_BYTES - examined) return false;
      examined += length - 2;
      if (
        editorSignature.test(text(bytes.subarray(offset + 2, offset + length)))
      ) {
        return true;
      }
    }
    offset += length;
  }
  return false;
}

function webpHasEditor(bytes: Uint8Array): boolean {
  const end = u32(bytes, 4, true) + 8;
  if (end > bytes.length || end < 12) return false;
  let offset = 12;
  let examined = 0;
  while (offset + 8 <= end) {
    const type = text(bytes.subarray(offset, offset + 4));
    const length = u32(bytes, offset + 4, true);
    if (length > end - offset - 8) return false;
    if (type === "EXIF" || type === "XMP ") {
      if (length > MAX_METADATA_BYTES - examined) return false;
      examined += length;
      if (
        editorSignature.test(
          text(bytes.subarray(offset + 8, offset + 8 + length)),
        )
      ) {
        return true;
      }
    }
    offset += 8 + length + (length % 2);
  }
  return false;
}

export async function receiptHasEditorMetadata(
  bytes: Uint8Array,
): Promise<boolean> {
  if (
    bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 &&
    bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d &&
    bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return await pngHasEditor(bytes);
  if (
    bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return jpegHasEditor(bytes);
  }
  if (
    bytes.length >= 12 && text(bytes.subarray(0, 4)) === "RIFF" &&
    text(bytes.subarray(8, 12)) === "WEBP"
  ) return webpHasEditor(bytes);
  return false;
}
