import { receiptHasEditorMetadata } from "./receipt-image-metadata.ts";

const encode = (value: string) => new TextEncoder().encode(value);
function join(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function number(value: number, littleEndian = false): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, littleEndian);
  return result;
}
function pngChunk(type: string, content: Uint8Array): Uint8Array {
  // CRC belongs to image integrity validation; this scanner only reads fields.
  return join(number(content.length), encode(type), content, new Uint8Array(4));
}
function png(...chunks: Uint8Array[]): Uint8Array {
  return join(
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    ...chunks,
    pngChunk("IEND", new Uint8Array()),
  );
}
function jpegSegment(marker: number, content: Uint8Array): Uint8Array {
  const length = content.length + 2;
  return join(
    new Uint8Array([255, marker, length >> 8, length & 255]),
    content,
  );
}
function webpChunk(type: string, content: Uint8Array): Uint8Array {
  return join(
    encode(type),
    number(content.length, true),
    content,
    new Uint8Array(content.length % 2),
  );
}
function webp(...chunks: Uint8Array[]): Uint8Array {
  const data = join(encode("WEBP"), ...chunks);
  return join(encode("RIFF"), number(data.length, true), data);
}
async function deflate(value: string): Promise<Uint8Array> {
  const stream = new Blob([value]).stream().pipeThrough(
    new CompressionStream("deflate"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function expect(
  bytes: Uint8Array,
  expected: boolean,
  reason: string,
): Promise<void> {
  const actual = await receiptHasEditorMetadata(bytes);
  if (actual !== expected) {
    throw new Error(`${reason}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("PNG compressed pixels spelling gimP never count as editor metadata", async () => {
  // Reproduces the real GoTyme upload's accidental IDAT match at byte 9645.
  const pixels = join(
    new Uint8Array(8000),
    encode("gimP"),
    new Uint8Array(8000),
  );
  await expect(
    png(
      pngChunk("eXIf", encode("Apple iPhone screenshot")),
      pngChunk(
        "iTXt",
        encode("XML:com.adobe.xmp\0\0\0\0\0<xmp>Screenshot</xmp>"),
      ),
      pngChunk("IDAT", pixels),
    ),
    false,
    "a random pixel signature must not block a genuine receipt",
  );
});

Deno.test("PNG actual EXIF, text and XMP editor metadata remains flagged", async () => {
  for (
    const [type, content] of [
      ["eXIf", "IIExif Software Adobe Photoshop 25"],
      ["tEXt", "Software\0GIMP 3.0"],
      [
        "iTXt",
        "XML:com.adobe.xmp\0\0\0\0\0<xmp:CreatorTool>Snapseed</xmp:CreatorTool>",
      ],
    ]
  ) {
    await expect(png(pngChunk(type, encode(content))), true, type);
  }
  await expect(
    png(
      pngChunk("IDAT", new Uint8Array(70000)),
      pngChunk("tEXt", encode("Software\0Inkscape")),
    ),
    true,
    "metadata after pixel chunks is still inspected",
  );
});

Deno.test("PNG compressed text metadata is decoded before examining editor names", async () => {
  await expect(
    png(
      pngChunk("zTXt", join(encode("Software\0\0"), await deflate("GIMP 3.0"))),
    ),
    true,
    "zTXt software",
  );
  await expect(
    png(
      pngChunk(
        "iTXt",
        join(
          encode("XML:com.adobe.xmp\0\x01\0\0\0"),
          await deflate("<xmp:CreatorTool>Adobe Photoshop</xmp:CreatorTool>"),
        ),
      ),
    ),
    true,
    "compressed iTXt XMP",
  );
  await expect(
    png(
      pngChunk(
        "zTXt",
        join(encode("Software\0\0"), await deflate("Apple iPhone")),
      ),
    ),
    false,
    "normal compressed metadata",
  );
});

Deno.test("JPEG entropy is ignored while APP1, APP13 and COM metadata is retained", async () => {
  const start = new Uint8Array([255, 216]);
  const scan = jpegSegment(0xda, new Uint8Array([1, 1, 0, 0, 63, 0]));
  await expect(
    join(
      start,
      scan,
      encode("random gimP pixlr Photoshop data"),
      new Uint8Array([255, 217]),
    ),
    false,
    "JPEG compressed pixels",
  );
  for (const marker of [0xe1, 0xed, 0xfe]) {
    await expect(
      join(
        start,
        jpegSegment(marker, encode("Exif\0\0Software Adobe Photoshop")),
        scan,
      ),
      true,
      `JPEG metadata segment ${marker}`,
    );
  }
  await expect(
    join(
      start,
      jpegSegment(0xe2, encode("ICC_PROFILE GIMP standard color profile")),
      scan,
    ),
    false,
    "a color profile is not editing history",
  );
});

Deno.test("WebP pixel chunks are ignored while EXIF and XMP remain flagged", async () => {
  await expect(
    webp(webpChunk("VP8 ", encode("random gimP pixlr pixels"))),
    false,
    "WebP pixels",
  );
  for (const type of ["EXIF", "XMP "]) {
    await expect(
      webp(
        webpChunk("VP8L", encode("pixel data")),
        webpChunk(type, encode("Software Lightroom")),
      ),
      true,
      `WebP ${type}`,
    );
  }
});

Deno.test("Malformed chunks and compressed metadata cannot trigger a raw-byte fallback", async () => {
  await expect(
    png(join(number(9999), encode("iTXt"), encode("gimP"))),
    false,
    "truncated PNG chunk",
  );
  await expect(
    png(pngChunk("zTXt", encode("Software\0\0not a zlib stream gimP"))),
    false,
    "invalid compressed metadata",
  );
  await expect(
    new Uint8Array([255, 216, 255, 225, 255, 255, ...encode("gimP")]),
    false,
    "truncated JPEG segment",
  );
  await expect(
    join(encode("RIFF"), number(9999, true), encode("WEBPEXIFgimP")),
    false,
    "truncated WebP container",
  );
  await expect(encode("gimP Adobe Photoshop"), false, "unknown file type");
});

Deno.test("Compressed metadata inspection is bounded", async () => {
  await expect(
    png(
      pngChunk(
        "zTXt",
        join(encode("Comment\0\0"), await deflate("A".repeat(200000))),
      ),
    ),
    false,
    "large decompressed metadata is bounded",
  );
});
