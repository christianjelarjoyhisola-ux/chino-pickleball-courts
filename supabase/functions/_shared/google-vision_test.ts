import {
  detectReceiptImageContentType,
  googleVisionConfidence,
  googleVisionConfidenceDetails,
  googleVisionLayoutText,
  googleVisionOcr,
  receiptImageDimensions,
  receiptImageSafeToDecode,
} from "./google-vision.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("detects supported receipt image signatures", () => {
  assertEquals(
    detectReceiptImageContentType(new Uint8Array([0xff, 0xd8, 0xff, 0x00])),
    "image/jpeg",
    "JPEG signature",
  );
  assertEquals(
    detectReceiptImageContentType(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ),
    "image/png",
    "PNG signature",
  );
  assertEquals(
    detectReceiptImageContentType(
      new Uint8Array([
        0x52,
        0x49,
        0x46,
        0x46,
        0,
        0,
        0,
        0,
        0x57,
        0x45,
        0x42,
        0x50,
      ]),
    ),
    "image/webp",
    "WebP signature",
  );
  assertEquals(
    detectReceiptImageContentType(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    null,
    "non-image signature",
  );
});

Deno.test("reads declared dimensions and skips decompression bombs", () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  png.set([0x49, 0x48, 0x44, 0x52], 12);
  png.set([0x00, 0x00, 0x0f, 0xa0], 16); // 4000
  png.set([0x00, 0x00, 0x0b, 0xb8], 20); // 3000
  const dimensions = receiptImageDimensions(png, "image/png");
  assertEquals(dimensions?.width, 4000, "PNG width");
  assertEquals(dimensions?.height, 3000, "PNG height");
  assert(receiptImageSafeToDecode(png, "image/png"), "12 MP PNG is safe");

  png.set([0x00, 0x01, 0x86, 0xa0], 16); // 100000
  assert(
    !receiptImageSafeToDecode(png, "image/png"),
    "extreme declared dimensions must not reach Image.decode",
  );

  const jpeg = new Uint8Array(21);
  jpeg.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  jpeg.set([0x04, 0x38, 0x07, 0x80], 7); // 1080 x 1920
  const jpegDimensions = receiptImageDimensions(jpeg, "image/jpeg");
  assertEquals(jpegDimensions?.width, 1920, "JPEG width");
  assertEquals(jpegDimensions?.height, 1080, "JPEG height");
});

Deno.test("sends the Vision key in a header and builds one OCR request", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const fetcher = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    requestedUrl = String(input);
    requestedInit = init;
    return new Response(
      JSON.stringify({
        responses: [{
          fullTextAnnotation: {
            text: "CHINO receipt",
            pages: [{ confidence: 0.97 }],
          },
        }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const result = await googleVisionOcr(
    "test-secret-key",
    "data:image/png;base64,QUJD",
    { fetcher },
  );

  assertEquals(
    requestedUrl,
    "https://vision.googleapis.com/v1/images:annotate",
    "Vision endpoint",
  );
  assert(
    !requestedUrl.includes("test-secret-key"),
    "key must not appear in URL",
  );
  const headers = new Headers(requestedInit?.headers);
  assertEquals(
    headers.get("x-goog-api-key"),
    "test-secret-key",
    "API key header",
  );
  const requestBody = JSON.parse(String(requestedInit?.body || "{}"));
  assertEquals(requestBody.requests.length, 1, "one image request");
  assertEquals(
    requestBody.requests[0].features[0].type,
    "DOCUMENT_TEXT_DETECTION",
    "OCR feature",
  );
  assertEquals(requestBody.requests[0].image.content, "QUJD", "base64 content");
  assertEquals(result.text, "CHINO receipt", "OCR text");
  assertEquals(result.confidence, 0.97, "OCR confidence");
  assertEquals(result.confidenceSource, "native", "OCR confidence source");
});

Deno.test("surfaces a bounded Google Vision API error", async () => {
  const fetcher = (async () =>
    new Response(
      JSON.stringify({ error: { message: "Cloud Vision API is disabled" } }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  let message = "";
  try {
    await googleVisionOcr("test-key", "QUJD", { fetcher });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("403"), "status should be included");
  assert(
    message.includes("Cloud Vision API is disabled"),
    "provider error should be included",
  );
  assert(
    !message.includes("test-key"),
    "API key must not be included in errors",
  );
});

Deno.test("averages nested OCR confidence when page confidence is absent", () => {
  const confidence = googleVisionConfidence({
    pages: [{
      blocks: [{ confidence: 0.8 }, { confidence: 0.6 }],
    }],
  }, "receipt");
  assertEquals(confidence, 0.7, "nested confidence average");
});

Deno.test("marks text-length confidence as heuristic, never native", () => {
  const result = googleVisionConfidenceDetails(
    { pages: [], text: "unused" },
    "A readable receipt-shaped OCR response longer than forty characters",
  );
  assertEquals(result.confidence, 0.9, "heuristic confidence");
  assertEquals(result.source, "heuristic", "heuristic provenance");
});

function visionWord(
  text: string,
  x: number,
  y: number,
  width = text.length * 8,
) {
  return {
    symbols: [...text].map((text) => ({ text })),
    boundingBox: {
      vertices: [{ x, y }, { x: x + width, y }, {
        x: x + width,
        y: y + 20,
      }, { x, y: y + 20 }],
    },
  };
}

function visionPage(words: ReturnType<typeof visionWord>[]) {
  return { width: 1000, height: 2000, blocks: [{ paragraphs: [{ words }] }] };
}

Deno.test("reconstructs receipt label and value columns without changing native OCR", async () => {
  const text = "Amount\nFee\nTotal\nTrace ID\nReference No.\nDate\n" +
    "P265.00\nP0.00\nP265.00\n941016\nITO260909055941016\n09 Sep 2026 at 1:59 PM";
  const fullTextAnnotation = {
    text,
    pages: [visionPage([
      visionWord("Amount", 20, 20),
      visionWord("Fee", 20, 60),
      visionWord("Total", 20, 100),
      visionWord("Trace", 20, 140),
      visionWord("ID", 70, 140),
      visionWord("Reference", 20, 180),
      visionWord("No.", 100, 180),
      visionWord("Date", 20, 220),
      visionWord("P265.00", 800, 21),
      visionWord("P0.00", 820, 61),
      visionWord("P265.00", 800, 101),
      visionWord("941016", 800, 141),
      visionWord("ITO260909055941016", 650, 181),
      visionWord("09 Sep 2026 at 1:59 PM", 600, 221),
    ])],
  };
  const fetcher =
    (async () =>
      new Response(JSON.stringify({ responses: [{ fullTextAnnotation }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
  const result = await googleVisionOcr("test-key", "QUJD", { fetcher });
  assertEquals(result.text, text, "native OCR retained for audit");
  assertEquals(
    result.layoutText,
    "Amount P265.00\nFee P0.00\nTotal P265.00\nTrace ID 941016\n" +
      "Reference No. ITO260909055941016\nDate 09 Sep 2026 at 1:59 PM",
    "geometry restores label-value associations",
  );
});

Deno.test("retains every split reference and masked-name word without correcting characters", () => {
  const words = [
    visionWord("To", 10, 10),
    visionWord("From", 10, 130),
    visionWord("Reference", 10, 200),
    visionWord("No.", 90, 200),
    visionWord("C*", 700, 10),
    visionWord("L**", 660, 10),
    visionWord("KR****E", 590, 10),
    visionWord("****", 580, 50),
    visionWord("9W07", 620, 50),
    visionWord("G-Xchange,", 500, 90),
    visionWord("Inc", 590, 90),
    visionWord("(GCash)", 630, 90),
    visionWord("SHEEJAN", 550, 130),
    visionWord("E*****", 620, 130),
    visionWord("ITO260909", 560, 200),
    visionWord("055941016", 640, 200),
  ];
  const original = words.map((word) => word.symbols.map((s) => s.text).join(""))
    .join("\n");
  assertEquals(
    googleVisionLayoutText({ pages: [visionPage(words)] }, original),
    "To KR****E L** C*\n**** 9W07\nG-Xchange, Inc (GCash)\nFrom SHEEJAN E*****\nReference No. ITO260909 055941016",
    "all observed characters stay unchanged, including zero in masked account",
  );
});

Deno.test("missing, invalid or rotated geometry falls back without dropping a word", () => {
  const validWord = visionWord("P265.00", 600, 100);
  const badWords: unknown[] = [
    { symbols: validWord.symbols },
    { ...validWord, boundingBox: { vertices: [] } },
    { ...validWord, boundingBox: { vertices: [null, {}, {}, {}] } },
    {
      ...validWord,
      boundingBox: { vertices: [{ x: "600", y: 100 }, {}, {}, {}] },
    },
    visionWord("P265.00", -10, 100),
    visionWord("P265.00", 990, 100),
    visionWord("P265.00", 600, Number.NaN),
    { ...validWord, symbols: [{ text: null }] },
    {
      ...validWord,
      boundingBox: {
        vertices: [
          { x: 600, y: 100 },
          { x: 600, y: 200 },
          { x: 580, y: 200 },
          { x: 580, y: 100 },
        ],
      },
    },
  ];
  for (const badWord of badWords) {
    const annotation = {
      pages: [{
        width: 1000,
        height: 2000,
        blocks: [{
          paragraphs: [{
            words: [visionWord("Amount", 10, 100), badWord],
          }],
        }],
      }],
    };
    assertEquals(
      googleVisionLayoutText(annotation, "Amount\nP265.00"),
      undefined,
      "no partial reconstruction",
    );
  }
  assertEquals(
    googleVisionLayoutText(null, "Amount P265.00"),
    undefined,
    "absent annotation",
  );
  assertEquals(
    googleVisionLayoutText({ pages: [] }, "Amount P265.00"),
    undefined,
    "absent pages",
  );
});

Deno.test("partial word hierarchy cannot remove evidence from original OCR", () => {
  const page = visionPage([
    visionWord("Amount", 20, 20),
    visionWord("P265.00", 200, 20),
  ]);
  assertEquals(
    googleVisionLayoutText(
      { pages: [page] },
      "Amount P265.00\nTransfer Failed",
    ),
    undefined,
    "unrepresented native evidence invalidates alternate text",
  );
  assertEquals(
    googleVisionLayoutText({ pages: [page] }, "Amount P260.00"),
    undefined,
    "symbol disagreement cannot replace original evidence",
  );
});

Deno.test("multiple OCR pages never combine into one label-value row", () => {
  const annotation = {
    pages: [
      visionPage([visionWord("Amount", 20, 20)]),
      visionPage([visionWord("P265.00", 200, 20)]),
    ],
  };
  assertEquals(
    googleVisionLayoutText(annotation, "Amount\nP265.00"),
    "Amount\n\f\nP265.00",
    "explicit page separator",
  );
});

Deno.test("supports documented zero coordinates and normalized word boxes", () => {
  const annotation = {
    pages: [{
      width: 1000,
      height: 2000,
      blocks: [{
        paragraphs: [{
          words: [{
            symbols: [{ text: "Amount" }],
            boundingBox: {
              vertices: [{}, { x: 60 }, { x: 60, y: 20 }, { y: 20 }],
            },
          }, {
            symbols: [{ text: "P265.00" }],
            boundingBox: {
              normalizedVertices: [
                { x: 0.8 },
                { x: 0.9 },
                { x: 0.9, y: 0.01 },
                { x: 0.8, y: 0.01 },
              ],
            },
          }],
        }],
      }],
    }],
  };
  assertEquals(
    googleVisionLayoutText(annotation, "Amount\nP265.00"),
    "Amount P265.00",
    "zero axis values are valid",
  );
});
