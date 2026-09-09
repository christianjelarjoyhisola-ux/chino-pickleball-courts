export type ReceiptImageContentType =
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export type GoogleVisionOcrResult = {
  text: string;
  layoutText?: string;
  recipientRegion?: ReceiptImageRegion;
  confidence: number;
  confidenceSource: "native" | "heuristic" | "none";
};

export type ReceiptImageDimensions = {
  width: number;
  height: number;
};

export type ReceiptImageRegion = ReceiptImageDimensions & {
  x: number;
  y: number;
};

const GOOGLE_VISION_ANNOTATE_URL =
  "https://vision.googleapis.com/v1/images:annotate";

function errorMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (record.error) return errorMessage(record.error);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "Unknown Google Vision error";
  }
}

export function detectReceiptImageContentType(
  bytes: Uint8Array,
): ReceiptImageContentType | null {
  if (
    bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 &&
    bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d &&
    bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 &&
    bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 &&
    bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) + bytes[offset + 3];
}

export function receiptImageDimensions(
  bytes: Uint8Array,
  contentType = detectReceiptImageContentType(bytes),
): ReceiptImageDimensions | null {
  if (contentType === "image/png") {
    if (
      bytes.length < 24 || String.fromCharCode(...bytes.subarray(12, 16)) !==
        "IHDR"
    ) return null;
    return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }

  if (contentType === "image/webp") {
    if (bytes.length < 30) return null;
    const kind = String.fromCharCode(...bytes.subarray(12, 16));
    if (kind === "VP8X") {
      return {
        width: u24le(bytes, 24) + 1,
        height: u24le(bytes, 27) + 1,
      };
    }
    if (
      kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    ) {
      return {
        width: u16le(bytes, 26) & 0x3fff,
        height: u16le(bytes, 28) & 0x3fff,
      };
    }
    if (kind === "VP8L" && bytes[20] === 0x2f) {
      return {
        width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
        height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) +
          ((bytes[24] & 0x0f) << 10),
      };
    }
    return null;
  }

  if (contentType === "image/jpeg") {
    const startOfFrame = new Set([
      0xc0,
      0xc1,
      0xc2,
      0xc3,
      0xc5,
      0xc6,
      0xc7,
      0xc9,
      0xca,
      0xcb,
      0xcd,
      0xce,
      0xcf,
    ]);
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
      if (offset + 1 >= bytes.length) return null;
      const segmentLength = u16be(bytes, offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) {
        return null;
      }
      if (startOfFrame.has(marker) && segmentLength >= 7) {
        return {
          width: u16be(bytes, offset + 5),
          height: u16be(bytes, offset + 3),
        };
      }
      offset += segmentLength;
    }
  }
  return null;
}

export function receiptImageSafeToDecode(
  bytes: Uint8Array,
  contentType = detectReceiptImageContentType(bytes),
  maxPixels = 16 * 1024 * 1024,
  maxDimension = 8192,
): boolean {
  const dimensions = receiptImageDimensions(bytes, contentType);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1) {
    return false;
  }
  if (dimensions.width > maxDimension || dimensions.height > maxDimension) {
    return false;
  }
  return dimensions.width <= Math.floor(maxPixels / dimensions.height);
}

export function googleVisionConfidence(
  annotation: Record<string, unknown> | null,
  text: string,
): number {
  return googleVisionConfidenceDetails(annotation, text).confidence;
}

export function googleVisionConfidenceDetails(
  annotation: Record<string, unknown> | null,
  text: string,
): {
  confidence: number;
  source: GoogleVisionOcrResult["confidenceSource"];
} {
  if (!annotation) {
    return text.length > 40
      ? { confidence: 0.9, source: "heuristic" }
      : text.length > 0
      ? { confidence: 0.5, source: "heuristic" }
      : { confidence: 0, source: "none" };
  }

  const pages = Array.isArray(annotation.pages)
    ? annotation.pages as Array<Record<string, unknown>>
    : [];
  if (
    pages.length && typeof pages[0].confidence === "number" &&
    pages[0].confidence > 0
  ) {
    return { confidence: pages[0].confidence, source: "native" };
  }

  let total = 0;
  let count = 0;
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const item = node as Record<string, unknown>;
    if (typeof item.confidence === "number" && item.confidence > 0) {
      total += item.confidence;
      count++;
    }
    for (const key of ["blocks", "paragraphs", "words", "symbols"]) {
      const children = item[key];
      if (Array.isArray(children)) children.forEach(visit);
    }
  };
  pages.forEach(visit);
  if (count > 0) {
    return { confidence: total / count, source: "native" };
  }
  return text.length > 40
    ? { confidence: 0.9, source: "heuristic" }
    : text.length > 0
    ? { confidence: 0.5, source: "heuristic" }
    : { confidence: 0, source: "none" };
}

type LayoutWord = {
  text: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  order: number;
};

type LayoutRow = {
  top: number;
  bottom: number;
  words: LayoutWord[];
  text?: string;
};

type LayoutResult = { text: string; pageRows: LayoutRow[][] };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function layoutWord(
  value: unknown,
  page: Record<string, unknown>,
  order: number,
): LayoutWord | null {
  const word = record(value);
  if (!word || !Array.isArray(word.symbols) || !word.symbols.length) {
    return null;
  }
  const symbols = word.symbols.map(record);
  if (
    symbols.some((symbol) => typeof symbol?.text !== "string" || !symbol.text)
  ) {
    return null;
  }
  const text = symbols.map((symbol) => symbol!.text as string).join("");
  if (!text.trim() || /[\r\n\f]/.test(text)) return null;
  const box = record(word.boundingBox);
  if (!box) return null;
  const normalized = !Array.isArray(box.vertices);
  const vertices = normalized ? box.normalizedVertices : box.vertices;
  if (!Array.isArray(vertices) || vertices.length !== 4) return null;
  const width = page.width;
  const height = page.height;
  if (
    normalized && (
      typeof width !== "number" || !Number.isFinite(width) || width <= 0 ||
      typeof height !== "number" || !Number.isFinite(height) || height <= 0
    )
  ) return null;
  const points: Array<{ x: number; y: number }> = [];
  for (const vertex of vertices) {
    const point = record(vertex);
    if (!point) return null;
    // Protobuf JSON omits zero-valued coordinates; a missing vertex is different.
    const x = point.x === undefined ? 0 : point.x;
    const y = point.y === undefined ? 0 : point.y;
    if (
      typeof x !== "number" || typeof y !== "number" ||
      !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 ||
      (normalized && (x > 1 || y > 1))
    ) return null;
    points.push({
      x: x * (normalized ? width as number : 1),
      y: y * (normalized ? height as number : 1),
    });
  }
  const [a, b, c, d] = points;
  // Vision's vertex order is top-left, top-right, bottom-right, bottom-left in
  // natural reading orientation. Avoid inventing row order for rotated text.
  if (b.x <= a.x || c.x <= d.x || d.y <= a.y || c.y <= b.y) return null;
  const top = Math.min(...points.map((point) => point.y));
  const bottom = Math.max(...points.map((point) => point.y));
  const wordHeight = bottom - top;
  if (
    Math.abs(a.y - b.y) > wordHeight * 0.25 ||
    Math.abs(c.y - d.y) > wordHeight * 0.25
  ) return null;
  if (
    (typeof width === "number" && points.some((point) => point.x > width)) ||
    (typeof height === "number" && points.some((point) => point.y > height))
  ) {
    return null;
  }
  return {
    text,
    left: Math.min(...points.map((point) => point.x)),
    right: Math.max(...points.map((point) => point.x)),
    top,
    bottom,
    order,
  };
}

/**
 * Alternate reading order for upright receipts whose labels and values were
 * emitted as separate columns. No characters or words are inferred or removed.
 * Uses the documented Page -> Block -> Paragraph -> Word -> Symbol hierarchy:
 * https://docs.cloud.google.com/vision/docs/reference/rest/v1/AnnotateImageResponse#Word
 */
function googleVisionLayout(
  annotation: Record<string, unknown> | null,
  originalText: string,
): LayoutResult | undefined {
  if (
    !annotation || !originalText.trim() || !Array.isArray(annotation.pages) ||
    !annotation.pages.length
  ) return undefined;
  const pageRows: LayoutRow[][] = [];
  const observedWords: LayoutWord[] = [];
  for (const rawPage of annotation.pages) {
    const page = record(rawPage);
    if (!page || !Array.isArray(page.blocks)) return undefined;
    const words: LayoutWord[] = [];
    for (const rawBlock of page.blocks) {
      const block = record(rawBlock);
      if (!block) return undefined;
      // Non-text blocks may legitimately have no paragraphs.
      if (block.paragraphs === undefined && block.blockType !== "TEXT") {
        continue;
      }
      if (!Array.isArray(block.paragraphs)) return undefined;
      for (const rawParagraph of block.paragraphs) {
        const paragraph = record(rawParagraph);
        if (!paragraph || !Array.isArray(paragraph.words)) return undefined;
        for (const rawWord of paragraph.words) {
          const word = layoutWord(rawWord, page, words.length);
          if (!word) return undefined;
          words.push(word);
          observedWords.push(word);
        }
      }
    }
    const rows: LayoutRow[] = [];
    words.sort((a, b) =>
      (a.top + a.bottom) - (b.top + b.bottom) ||
      a.left - b.left || a.order - b.order
    );
    for (const word of words) {
      const matches = rows.filter((row) => {
        const overlap = Math.min(row.bottom, word.bottom) -
          Math.max(row.top, word.top);
        const minHeight = Math.min(
          row.bottom - row.top,
          word.bottom - word.top,
        );
        return overlap >= minHeight * 0.5 &&
          Math.abs((row.top + row.bottom) - (word.top + word.bottom)) / 2 <=
            minHeight * 0.45;
      });
      if (matches.length > 1) return undefined;
      const row = matches[0];
      if (row) {
        row.top = Math.max(row.top, word.top);
        row.bottom = Math.min(row.bottom, word.bottom);
        row.words.push(word);
      } else {
        rows.push({ top: word.top, bottom: word.bottom, words: [word] });
      }
    }
    rows.sort((a, b) => a.top - b.top);
    pageRows.push(rows);
  }
  // Partial hierarchy data must not hide evidence present in the original OCR.
  const characters = (text: string) =>
    [...text.replace(/\s/g, "")].sort().join("");
  if (
    !observedWords.length ||
    characters(observedWords.map((word) => word.text).join("")) !==
      characters(originalText)
  ) {
    return undefined;
  }
  // Vision can split a single native token into several Word nodes, especially
  // masked names and punctuation. Preserve only joins directly demonstrated by
  // the original text; never decide spacing using expected receipt values.
  const joinsPrevious = new Set<LayoutWord>();
  const nativeCharacters = originalText.replace(/\s/g, "");
  if (
    observedWords.map((word) => word.text).join("").replace(/\s/g, "") ===
      nativeCharacters
  ) {
    const spaceBoundaries = new Set<number>();
    let offset = 0;
    for (const character of originalText) {
      if (/\s/.test(character)) spaceBoundaries.add(offset);
      else offset += character.length;
    }
    offset = 0;
    observedWords.forEach((word, index) => {
      if (index > 0 && !spaceBoundaries.has(offset)) joinsPrevious.add(word);
      offset += word.text.replace(/\s/g, "").length;
    });
  }
  const text = pageRows.map((rows) =>
    rows.map((row) => {
      row.words.sort((a, b) => a.left - b.left || a.order - b.order);
      row.text = row.words.map((word, index) => {
        const previous = row.words[index - 1];
        const separator = !previous ||
            (joinsPrevious.has(word) && previous.order + 1 === word.order)
          ? ""
          : " ";
        return separator + word.text;
      }).join("");
      return row.text;
    }).join("\n")
  ).join("\n\f\n");
  return { text, pageRows };
}

export function googleVisionLayoutText(
  annotation: Record<string, unknown> | null,
  originalText: string,
): string | undefined {
  return googleVisionLayout(annotation, originalText)?.text;
}

function recipientRegionFromLayout(
  annotation: Record<string, unknown> | null,
  layout: LayoutResult | undefined,
): ReceiptImageRegion | undefined {
  if (
    !layout || layout.pageRows.length !== 1 || !Array.isArray(annotation?.pages)
  ) return undefined;
  const page = record(annotation.pages[0]);
  const width = page?.width;
  const height = page?.height;
  if (
    typeof width !== "number" || !Number.isInteger(width) || width <= 0 ||
    typeof height !== "number" || !Number.isInteger(height) || height <= 0
  ) return undefined;
  const rows = layout.pageRows[0];
  const toRows = rows.filter((row) => /^to(?:\s|:|$)/i.test(row.text || ""));
  const fromRows = rows.filter((row) =>
    /^from(?:\s|:|$)/i.test(row.text || "")
  );
  if (toRows.length !== 1 || fromRows.length !== 1) return undefined;
  const to = toRows[0];
  const from = fromRows[0];
  const fromTop = Math.min(...from.words.map((word) => word.top));
  const toBottom = Math.max(...to.words.map((word) => word.bottom));
  if (
    fromTop <= toBottom || Math.abs(to.words[0].left - from.words[0].left) >
      Math.max(to.bottom - to.top, from.bottom - from.top) * 2
  ) return undefined;
  const regionRows = rows.slice(rows.indexOf(to), rows.indexOf(from));
  if (
    regionRows.length < 3 ||
    !regionRows.some((row) => /\bg\s*cash\b/i.test(row.text || ""))
  ) return undefined;
  const accountRows = regionRows.filter((row) => {
    const compact = (row.text || "").replace(/\s/g, "");
    const match = compact.match(
      /^(?:(?:account|acct)(?:number|no\.?)?:?)?[*•●·xX]{2,}([A-Z0-9]{4,})$/i,
    );
    return Boolean(match && /\d/.test(match[1]));
  });
  if (accountRows.length !== 1) return undefined;
  const namePresent = regionRows.some((row) => {
    if (accountRows.includes(row) || /\bg\s*cash\b/i.test(row.text || "")) {
      return false;
    }
    const name = (row.text || "").replace(/^to(?:\s|:)+/i, "").trim();
    return /[A-Z]/i.test(name) && /[*•●·]/.test(name);
  });
  if (!namePresent) return undefined;
  const words = regionRows.flatMap((row) => row.words);
  const left = Math.min(...words.map((word) => word.left));
  const right = Math.max(...words.map((word) => word.right));
  const top = Math.min(...words.map((word) => word.top));
  const bottom = Math.max(...words.map((word) => word.bottom));
  if (bottom >= fromTop) return undefined;
  const padding = Math.max(
    2,
    Math.ceil(Math.max(to.bottom - to.top, from.bottom - from.top) * 0.5),
  );
  const previous = rows[rows.indexOf(to) - 1];
  const previousBottom = previous
    ? Math.max(...previous.words.map((word) => word.bottom))
    : 0;
  if (previous && previousBottom >= top) return undefined;
  const x = Math.max(0, Math.floor(left - padding));
  const y = Math.max(
    0,
    Math.floor(Math.max(top - padding, (previousBottom + top) / 2)),
  );
  const endX = Math.min(width, Math.ceil(right + padding));
  const endY = Math.min(
    height,
    Math.ceil(Math.min(bottom + padding, (bottom + fromTop) / 2)),
  );
  return endX > x && endY > y
    ? { x, y, width: endX - x, height: endY - y }
    : undefined;
}

export function googleVisionRecipientRegion(
  annotation: Record<string, unknown> | null,
  originalText: string,
): ReceiptImageRegion | undefined {
  return recipientRegionFromLayout(
    annotation,
    googleVisionLayout(annotation, originalText),
  );
}

export type GoogleVisionOcrOptions = {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  featureType?: "DOCUMENT_TEXT_DETECTION" | "TEXT_DETECTION";
};

export async function googleVisionOcr(
  apiKey: string,
  base64: string,
  options: GoogleVisionOcrOptions = {},
): Promise<GoogleVisionOcrResult> {
  const key = apiKey.trim();
  if (!key) throw new Error("Google Vision API key is missing");

  const comma = base64.indexOf(",");
  const content = base64.startsWith("data:") && comma !== -1
    ? base64.slice(comma + 1)
    : base64;
  if (!content) throw new Error("Google Vision image content is empty");
  const featureType = options.featureType || "DOCUMENT_TEXT_DETECTION";

  const controller = new AbortController();
  let rejectTimeout: (error: Error) => void = () => {};
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(
    () => {
      controller.abort();
      rejectTimeout(new Error("Google Vision request timed out"));
    },
    options.timeoutMs ?? 25_000,
  );
  let response: Response;
  let data: Record<string, unknown>;
  try {
    const readResponse = async () => {
      const received = await (options.fetcher || fetch)(
        GOOGLE_VISION_ANNOTATE_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Keep credentials out of URLs, proxy logs, and exception traces.
            "x-goog-api-key": key,
          },
          body: JSON.stringify({
            requests: [{
              image: { content },
              features: [{ type: featureType, maxResults: 1 }],
              imageContext: {
                languageHints: ["en"],
                ...(featureType === "TEXT_DETECTION"
                  ? {
                    // REST field documented at ImageContext#TextDetectionParams.
                    textDetectionParams: {
                      enableTextDetectionConfidenceScore: true,
                    },
                  }
                  : {}),
              },
            }],
          }),
          signal: controller.signal,
        },
      );
      const data = await received.json().catch(() => ({})) as Record<
        string,
        unknown
      >;
      return { response: received, data };
    };
    // Headers alone do not complete OCR: apply the same deadline to body reads.
    ({ response, data } = await Promise.race([readResponse(), timeout]));
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Google Vision request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(
      `Google Vision error ${response.status}: ${
        errorMessage(data).slice(0, 500)
      }`,
    );
  }
  const responses = Array.isArray(data.responses) ? data.responses : [];
  const result = (responses[0] || {}) as Record<string, unknown>;
  if (result.error) {
    throw new Error(
      `Google Vision: ${errorMessage(result.error).slice(0, 500)}`,
    );
  }

  const fullText = result.fullTextAnnotation &&
      typeof result.fullTextAnnotation === "object"
    ? result.fullTextAnnotation as Record<string, unknown>
    : null;
  const textAnnotations = Array.isArray(result.textAnnotations)
    ? result.textAnnotations as Array<Record<string, unknown>>
    : [];
  const text = typeof fullText?.text === "string"
    ? fullText.text
    : typeof textAnnotations[0]?.description === "string"
    ? textAnnotations[0].description
    : "";

  const confidence = googleVisionConfidenceDetails(fullText, text);
  const layout = googleVisionLayout(fullText, text);
  return {
    text,
    layoutText: layout?.text,
    recipientRegion: recipientRegionFromLayout(fullText, layout),
    confidence: confidence.confidence,
    confidenceSource: confidence.source,
  };
}
