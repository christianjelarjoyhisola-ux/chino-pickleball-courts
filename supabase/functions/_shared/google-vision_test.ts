import {
  detectReceiptImageContentType,
  googleVisionConfidence,
  googleVisionConfidenceDetails,
  googleVisionGcashEvidence,
  googleVisionLayoutText,
  googleVisionNativeLines,
  googleVisionOcr,
  googleVisionRecipientCropEvidence,
  googleVisionRecipientRegion,
  receiptImageDimensions,
  receiptImageSafeToDecode,
} from "./google-vision.ts";
import {
  parseGotymeToGcashReceipt,
  verifyGotymeToGcashReceipt,
} from "./receipt-providers/gotyme.ts";

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
  assertEquals(
    JSON.stringify(requestBody.requests[0].imageContext),
    JSON.stringify({ languageHints: ["en"] }),
    "default document request remains unchanged",
  );
});

Deno.test("TEXT_DETECTION explicitly requests documented native confidence", async () => {
  let body: Record<string, unknown> = {};
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return Response.json({
      responses: [{
        fullTextAnnotation: {
          text: "Observed recipient",
          pages: [{ confidence: 0.96 }],
        },
      }],
    });
  }) as typeof fetch;
  const result = await googleVisionOcr("test-key", "QUJD", {
    featureType: "TEXT_DETECTION",
    fetcher,
  });
  const requests = body.requests as Array<Record<string, unknown>>;
  assertEquals(
    JSON.stringify(requests[0].features),
    JSON.stringify([{ type: "TEXT_DETECTION", maxResults: 1 }]),
    "one alternative feature",
  );
  assertEquals(
    JSON.stringify(requests[0].imageContext),
    JSON.stringify({
      languageHints: ["en"],
      textDetectionParams: { enableTextDetectionConfidenceScore: true },
    }),
    "exact REST confidence parameter",
  );
  assertEquals(result.text, "Observed recipient", "observed text unchanged");
  assertEquals(result.confidence, 0.96, "native confidence retained");
  assertEquals(
    result.confidenceSource,
    "native",
    "confidence provenance retained",
  );
});

Deno.test("OCR timeout includes a stalled response body after headers arrive", async () => {
  let signal: AbortSignal | null | undefined;
  let bodyStarted = false;
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal;
    return {
      ok: true,
      status: 200,
      json: () => {
        bodyStarted = true;
        return new Promise(() => {});
      },
    } as unknown as Response;
  }) as typeof fetch;
  let message = "";
  const started = Date.now();
  try {
    await googleVisionOcr("test-key", "QUJD", { fetcher, timeoutMs: 20 });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(bodyStarted, "response headers arrived and JSON body read started");
  assertEquals(
    message,
    "Google Vision request timed out",
    "body deadline error",
  );
  assert(signal?.aborted, "underlying fetch is aborted at its deadline");
  assert(Date.now() - started < 2000, "stalled JSON cannot run indefinitely");
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

Deno.test("native line export retains exact word and symbol confidences and rejects incomplete geometry", () => {
  const word = {
    ...visionWord("B7942F55EC99", 20, 40),
    confidence: .95,
    symbols: [..."B7942F55EC99"].map((text) => ({
      text,
      confidence: text === "B" ? .91 : .97,
    })),
  };
  const annotation = {
    text: word.symbols.map((symbol) => symbol.text).join(""),
    pages: [visionPage([word])],
  };
  const lines = googleVisionNativeLines(annotation, annotation.text)!;
  assertEquals(lines[0].words[0].confidence, .95, "real word confidence");
  assertEquals(
    lines[0].words[0].symbols[0].confidence,
    .91,
    "real symbol confidence",
  );
  assertEquals(lines[0].words[0].left, 20, "native geometry");
  assertEquals(
    googleVisionNativeLines(
      annotation,
      annotation.text + "\nUnrepresented status",
    ),
    undefined,
    "incomplete native geometry cannot erase adverse status",
  );
});

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
    result.nativeLines?.length,
    6,
    "native rows exposed for dedicated-bank evidence",
  );
  assertEquals(
    result.nativeLines?.[0].words[1].text,
    "P265.00",
    "native value never inferred",
  );
  assertEquals(
    result.nativeLines?.[0].words[1].confidence,
    undefined,
    "no fabricated confidence from page or shape",
  );
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

Deno.test("native token boundaries preserve split masked names through GoTyme verification", () => {
  const text = "Transferred\nP265.00\nInstaPay Instant\nTo\nFrom\n" +
    "KR****E L** C*\n****9WO7\nG-Xchange, Inc (GCash)\nSHEEJAN E*****\n" +
    "********4162\nGoTyme Bank\nAmount\nFee\nTotal\nTrace ID\nReference No.\nDate\n" +
    "P265.00\nP0.00\nP265.00\n941016\nITO260909055941016\n09 Sep 2026 at 1:59 PM";
  const words = [
    visionWord("Transferred", 400, 10),
    visionWord("P265.00", 400, 50),
    visionWord("InstaPay Instant", 400, 100),
    visionWord("To", 20, 200),
    visionWord("From", 20, 340),
    visionWord("KR", 500, 200),
    visionWord("****", 516, 200),
    visionWord("E", 548, 200),
    visionWord("L", 570, 200),
    visionWord("**", 578, 200),
    visionWord("C", 610, 200),
    visionWord("*", 618, 200),
    visionWord("****", 600, 240),
    visionWord("9WO7", 632, 240),
    visionWord("G-Xchange, Inc (GCash)", 500, 280),
    visionWord("SHEEJAN E*****", 500, 340),
    visionWord("********4162", 500, 380),
    visionWord("GoTyme Bank", 500, 420),
    visionWord("Amount", 20, 460),
    visionWord("Fee", 20, 500),
    visionWord("Total", 20, 540),
    visionWord("Trace ID", 20, 580),
    visionWord("Reference No.", 20, 620),
    visionWord("Date", 20, 660),
    visionWord("P265.00", 600, 460),
    visionWord("P0.00", 600, 500),
    visionWord("P265.00", 600, 540),
    visionWord("941016", 600, 580),
    visionWord("ITO260909", 500, 620),
    visionWord("055941016", 572, 620),
    visionWord("09 Sep 2026 at 1:59 PM", 500, 660),
  ];
  const layout = googleVisionLayoutText({ pages: [visionPage(words)] }, text);
  assert(layout, "valid complete geometry yields alternate text");
  assert(
    layout.includes("To KR****E L** C*"),
    "native name token boundaries retained",
  );
  assert(
    layout.includes("Reference No. ITO260909055941016"),
    "native reference token retained",
  );
  const parsed = parseGotymeToGcashReceipt(layout);
  assertEquals(
    parsed.recipient.nameRaw,
    "KR****E L** C*",
    "parser sees the observed masked name",
  );
  const verified = verifyGotymeToGcashReceipt(parsed, {
    expectedAmount: 265,
    pricingAvailable: true,
    amountTolerance: 0.01,
    expectedRecipientNumber: "09609422169",
    expectedRecipientName: "KRISTIE LOU CACHUELA",
    expectedRecipientAccount: "TESTMERCHANT9WO7",
    bookingStartedAt: "2026-09-09T05:58:00.000Z",
    bookingStartedDate: "2026-09-09",
    paymentWindowMinutes: 15,
    earlyToleranceMinutes: 2,
  });
  assertEquals(
    verified.recipientComparison.name,
    "masked_compatible",
    "name anchors match without injected spaces",
  );
  assertEquals(
    verified.flags.length,
    0,
    "complete observed receipt evidence verifies",
  );
});

Deno.test("native spaces and row boundaries cannot be erased by geometric proximity", () => {
  const words = [
    visionWord("KR", 20, 20),
    visionWord("****", 36, 20),
    visionWord("E", 68, 20),
    visionWord("L", 100, 20),
    visionWord("**", 108, 20),
    visionWord("C", 150, 60),
    visionWord("*", 158, 100),
  ];
  const layout = googleVisionLayoutText(
    { pages: [visionPage(words)] },
    "KR **** E L** C*",
  );
  assertEquals(
    layout,
    "KR **** E L**\nC\n*",
    "observed spaces stay, and a native token never bridges visual rows",
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

function recipientGeometry(extraWords: ReturnType<typeof visionWord>[] = []) {
  const words = [
    visionWord("Transferred", 350, 50),
    visionWord("To", 20, 200),
    visionWord("KR****E L** C*", 450, 198),
    visionWord("****9W07", 500, 250),
    visionWord("G-Xchange, Inc (GCash)", 390, 300),
    visionWord("From", 20, 400),
    visionWord("SENDER E*****", 450, 400),
    ...extraWords,
  ];
  return {
    words,
    annotation: { pages: [visionPage(words)] },
    text: words.map((word) =>
      word.symbols.map((symbol) => symbol.text).join("")
    ).join("\n"),
  };
}

Deno.test("recipient crop geometry encloses observed To evidence and excludes From", async () => {
  const { annotation, text } = recipientGeometry();
  const region = googleVisionRecipientRegion(annotation, text);
  assert(region, "unique complete recipient region is found");
  assert(
    region.x <= 20 && region.y <= 198,
    "To label and name top are enclosed",
  );
  assert(
    region.x + region.width >= 558,
    "entire name and account are enclosed",
  );
  assert(region.y + region.height >= 320, "GCash destination line is enclosed");
  assert(region.y + region.height < 400, "sender section is excluded");
  assert(
    region.x >= 0 && region.y >= 0 && region.x + region.width <= 1000 &&
      region.y + region.height <= 2000,
    "crop stays inside image pixels",
  );
  const fetcher = (async () =>
    Response.json({
      responses: [{ fullTextAnnotation: { ...annotation, text } }],
    })) as typeof fetch;
  const result = await googleVisionOcr("test-key", "QUJD", { fetcher });
  assertEquals(
    JSON.stringify(result.recipientRegion),
    JSON.stringify(region),
    "OCR output exposes bounded region only",
  );
  assertEquals(result.text, text, "original evidence remains unchanged");
});

Deno.test("recipient crop rejects ambiguous anchors, missing evidence, and incomplete geometry", () => {
  const valid = recipientGeometry();
  const original = (words: ReturnType<typeof visionWord>[]) =>
    words.map((word) => word.symbols.map((s) => s.text).join("")).join("\n");
  const invalidRows = [
    recipientGeometry([visionWord("To", 20, 600)]).words,
    recipientGeometry([visionWord("From", 20, 600)]).words,
    valid.words.filter((word) =>
      word.symbols.map((s) => s.text).join("") !== "To"
    ),
    valid.words.filter((word) =>
      word.symbols.map((s) => s.text).join("") !== "From"
    ),
    valid.words.filter((word) =>
      !word.symbols.map((s) => s.text).join("").includes("GCash")
    ),
    valid.words.filter((word) =>
      !word.symbols.map((s) => s.text).join("").includes("9W07")
    ),
    valid.words.filter((word) =>
      !word.symbols.map((s) => s.text).join("").startsWith("KR")
    ),
    recipientGeometry([visionWord("****4ABC", 500, 350)]).words,
    valid.words.map((word) =>
      word.symbols.map((s) => s.text).join("") === "From"
        ? visionWord("From", 20, 100)
        : word
    ),
  ];
  for (const words of invalidRows) {
    assertEquals(
      googleVisionRecipientRegion(
        { pages: [visionPage(words)] },
        original(words),
      ),
      undefined,
      "uncertain region must not be cropped",
    );
  }
  assertEquals(
    googleVisionRecipientRegion({
      pages: [visionPage(valid.words), visionPage(valid.words)],
    }, valid.text + "\n" + valid.text),
    undefined,
    "multiple pages are not a single image crop",
  );
  assertEquals(
    googleVisionRecipientRegion(
      valid.annotation,
      valid.text + "\nUnrepresented evidence",
    ),
    undefined,
    "incomplete word hierarchy cannot define a crop",
  );
  const malformed = structuredClone(valid.annotation);
  malformed.pages[0].blocks[0].paragraphs[0].words[3].boundingBox.vertices = [];
  assertEquals(
    googleVisionRecipientRegion(malformed, valid.text),
    undefined,
    "invalid account geometry cannot be cropped",
  );
});

function gcashGeometry() {
  const word = (
    text: string,
    x: number,
    y: number,
    confidence = 0.98,
  ): ReturnType<typeof visionWord> & {
    confidence: number;
    symbols: Array<{ text: string; confidence?: number }>;
  } => ({
    ...visionWord(text, x, y),
    confidence,
    symbols: [...text].map((text) => ({ text, confidence })),
  });
  // Native Vision may emit the two left-hand labels before the right values.
  // A low-confidence status bar and environmental footer are not payment fields.
  const words = [
    word("9:06", 15, 15, 0.42),
    word("Express Send", 380, 100),
    word("KRE L. C.", 380, 260, 0.96),
    word("+63 92169", 380, 320, 0.97),
    word("Sent via GCash", 360, 380),
    word("Amount", 70, 500, 0.71),
    word("Total Amount Sent", 70, 620, 0.75),
    word("1,590.00", 750, 500, 0.99),
    word("₱1,590.00", 720, 620, 0.98),
    word("Ref No.", 70, 780, 0.87),
    word("9044", 150, 780, 0.97),
    word("881673119", 200, 780, 0.96),
    word("Sep 10, 2026", 400, 780, 0.98),
    word("9:06 AM", 530, 780, 0.99),
    word("279g CO2e carbon footprint", 100, 950, 0.3),
  ];
  const text = words.map((entry) => entry.symbols.map((s) => s.text).join(""))
    .join("\n");
  return {
    words,
    text,
    annotation: { text, pages: [{ ...visionPage(words), confidence: 0.8829 }] },
  };
}

Deno.test("GCash masked recipient confidence excludes mask punctuation but never weak visible digits", () => {
  const fixture = gcashGeometry();
  const phone = fixture.words.find((word) =>
    word.symbols.map((symbol) => symbol.text).join("") === "+63 92169"
  )!;
  phone.symbols = [..."+63 9.. ... 2169"].map((text) => ({
    text,
    confidence: /\d/.test(text) ? 0.97 : 0.42,
  }));
  phone.confidence = 0.8506989723076923;
  fixture.text = fixture.words.map((entry) =>
    entry.symbols.map((symbol) => symbol.text).join("")
  ).join("\n");
  const evidence = googleVisionGcashEvidence(fixture.annotation, fixture.text);
  assert(evidence, "masked Express Send receipt recognized");
  assertEquals(
    evidence.fields.recipientPhone?.text,
    "+63 9.. ... 2169",
    "exact masked phone remains in audit evidence",
  );
  assert(
    Math.abs(evidence.fields.recipientPhone!.confidence! - 0.97) < 1e-12,
    "mask punctuation does not lower visible-digit confidence",
  );
  assert(
    evidence.confidence! >= 0.95,
    "a sharp visible recipient ending can pass the unchanged safety threshold",
  );

  phone.symbols = phone.symbols.map((symbol) => ({
    ...symbol,
    confidence: symbol.text === "2" ? 0.4 : 0.97,
  }));
  const weakVisibleDigit = googleVisionGcashEvidence(
    fixture.annotation,
    fixture.text,
  );
  assert(
    weakVisibleDigit!.fields.recipientPhone!.confidence! < 0.9,
    "an uncertain visible recipient digit still forces review",
  );
});

Deno.test("GCash field confidence uses observed payment words while preserving native page score", async () => {
  const { annotation, text } = gcashGeometry();
  const evidence = googleVisionGcashEvidence(annotation, text);
  assert(evidence, "recognized Express Send geometry");
  assertEquals(
    evidence.fields.amount?.text,
    "1,590.00",
    "amount follows its own label",
  );
  assertEquals(
    evidence.fields.totalAmount?.text,
    "₱1,590.00",
    "total follows its own label",
  );
  assertEquals(
    evidence.fields.reference?.text,
    "9044 881673119",
    "split native reference retained",
  );
  assertEquals(
    evidence.fields.dateTime?.text,
    "Sep 10, 2026 9:06 AM",
    "reference-adjacent timestamp",
  );
  assertEquals(
    evidence.fields.recipientName?.text,
    "KRE L. C.",
    "no masked characters are invented",
  );
  assertEquals(
    evidence.fields.recipientPhone?.text,
    "+63 92169",
    "no missing digits are inferred",
  );
  assert(
    evidence.confidence! >= 0.95,
    "only independently scored receipt values form field confidence",
  );
  assertEquals(
    evidence.confidenceSource,
    "native",
    "native confidence provenance",
  );
  assert(
    evidence.layoutText.includes(
      "Amount 1,590.00\nTotal Amount Sent ₱1,590.00",
    ),
    "geometric labels match values",
  );
  assert(
    evidence.layoutText.includes("279g CO2e"),
    "footer text remains for audit",
  );
  const region = evidence.recipientRegion;
  assert(region, "recipient pixels available for independent OCR reread");
  assert(
    region.y <= 260 && region.y + region.height >= 340,
    "name and phone enclosed",
  );
  assert(
    region.y > 120 && region.y + region.height < 380,
    "crop excludes header and GCash source label",
  );
  const result = await googleVisionOcr("test-key", "QUJD", {
    fetcher: (async () =>
      Response.json({
        responses: [{ fullTextAnnotation: annotation }],
      })) as typeof fetch,
  });
  assertEquals(
    result.confidence,
    0.8829,
    "native page confidence remains unchanged",
  );
  assertEquals(result.text, text, "native OCR remains unchanged");
  assertEquals(
    result.gcashEvidence?.confidence,
    evidence.confidence,
    "optional GCash evidence included",
  );
});

Deno.test("GCash Send Money geometry without an Express Send heading retains recipient recovery", () => {
  const fixture = gcashGeometry();
  fixture.words = fixture.words.filter((entry) =>
    entry.symbols.map((symbol) => symbol.text).join("") !== "Express Send"
  );
  fixture.text = fixture.words.map((entry) =>
    entry.symbols.map((symbol) => symbol.text).join("")
  ).join("\n");
  fixture.annotation = {
    text: fixture.text,
    pages: [{ ...visionPage(fixture.words), confidence: 0.8829 }],
  };
  const evidence = googleVisionGcashEvidence(fixture.annotation, fixture.text);
  assert(evidence, "heading-free Send Money receipt recognized");
  assertEquals(
    evidence.fields.recipientName?.text,
    "KRE L. C.",
    "headerless recipient name",
  );
  assertEquals(
    evidence.fields.recipientPhone?.text,
    "+63 92169",
    "headerless recipient phone",
  );
  assert(evidence.recipientRegion, "recipient pixels remain available for two-view reread");
});

Deno.test("GCash geometry scores a reference wrapped onto an adjacent row", () => {
  const fixture = gcashGeometry();
  const first = fixture.words.find((entry) =>
    entry.symbols.map((symbol) => symbol.text).join("") === "9044"
  )!;
  first.symbols = [..."1044 923"].map((text) => ({ text, confidence: 0.97 }));
  first.confidence = 0.97;
  const remainder = fixture.words.find((entry) =>
    entry.symbols.map((symbol) => symbol.text).join("") === "881673119"
  )!;
  remainder.symbols = [..."718392"].map((text) => ({ text, confidence: 0.96 }));
  remainder.confidence = 0.96;
  remainder.boundingBox.vertices = [
    { x: 150, y: 820 },
    { x: 250, y: 820 },
    { x: 250, y: 840 },
    { x: 150, y: 840 },
  ];
  fixture.text = fixture.words.map((entry) =>
    entry.symbols.map((symbol) => symbol.text).join("")
  ).join("\n");
  fixture.annotation = {
    text: fixture.text,
    pages: [{ ...visionPage(fixture.words), confidence: 0.8829 }],
  };
  const evidence = googleVisionGcashEvidence(fixture.annotation, fixture.text);
  assert(evidence, "wrapped-reference GCash receipt recognized");
  assertEquals(
    evidence.fields.reference?.text,
    "1044 923 718392",
    "both observed reference rows are retained",
  );
  assert(
    (evidence.fields.reference?.confidence || 0) >= 0.96,
    "reference confidence comes from both native rows",
  );
});

Deno.test("GCash unreadable or missing critical words cannot gain confidence from other fields", () => {
  const fixture = gcashGeometry();
  fixture.words.find((word) =>
    word.symbols.map((s) => s.text).join("") === "881673119"
  )!.confidence = 0.2;
  const evidence = googleVisionGcashEvidence(fixture.annotation, fixture.text);
  assert(
    evidence && evidence.confidence! < 0.5,
    "low reference confidence remains low despite all other matches",
  );
  assertEquals(
    evidence.confidence,
    evidence.fields.reference?.confidence,
    "weakest critical field determines score",
  );
  const missing = gcashGeometry();
  delete (missing.words[7] as { confidence?: number }).confidence;
  const missingEvidence = googleVisionGcashEvidence(
    missing.annotation,
    missing.text,
  );
  assert(missingEvidence, "geometry still available without native confidence");
  assertEquals(
    missingEvidence.fields.amount?.confidence,
    undefined,
    "native word score is required",
  );
  assertEquals(
    missingEvidence.confidence,
    undefined,
    "missing critical native score prevents complete confidence",
  );
  assertEquals(
    missingEvidence.confidenceSource,
    "none",
    "no heuristic substitution",
  );
});

Deno.test("GCash field evidence fails closed on incomplete geometry and ambiguous receipt anchors", () => {
  const fixture = gcashGeometry();
  assertEquals(
    googleVisionGcashEvidence(
      fixture.annotation,
      fixture.text + "\nTransfer failed",
    ),
    undefined,
    "geometry cannot hide extra native evidence",
  );
  const duplicate = {
    ...visionWord("Sent via GCash", 350, 1100),
    confidence: 0.99,
  };
  fixture.words.push(duplicate);
  assertEquals(
    googleVisionGcashEvidence(
      fixture.annotation,
      fixture.text + "\nSent via GCash",
    ),
    undefined,
    "ambiguous recipient boundaries do not yield field policy",
  );
  const wrongChars = gcashGeometry();
  assertEquals(
    googleVisionGcashEvidence(
      wrongChars.annotation,
      wrongChars.text.replace("1,590.00", "1,580.00"),
    ),
    undefined,
    "geometry never rewrites native values",
  );
  const zero = gcashGeometry();
  zero.words[7].confidence = 0;
  assertEquals(
    googleVisionGcashEvidence(zero.annotation, zero.text)?.confidence,
    0,
    "zero confidence is evidence, not a missing score",
  );
});

Deno.test("GCash layout preserves rotated Android navigation glyphs without accepting rotated receipt text", () => {
  const fixture = gcashGeometry();
  const nav = { ...visionWord("☐", 350, 1500), confidence: 0.6 };
  nav.boundingBox.vertices = [{ x: 377, y: 1500 }, { x: 377, y: 1525 }, {
    x: 354,
    y: 1525,
  }, { x: 354, y: 1500 }];
  fixture.words.push(nav);
  const text = fixture.text + "\n☐";
  assertEquals(
    googleVisionLayoutText(fixture.annotation, text),
    undefined,
    "generic layout behavior unchanged",
  );
  const evidence = googleVisionGcashEvidence(fixture.annotation, text);
  assert(
    evidence,
    "nonpayment Android symbol does not invalidate GCash fields",
  );
  assert(evidence.layoutText.endsWith("☐"), "symbol remains in audit text");
  nav.symbols = [{ text: "Failed" }];
  assertEquals(
    googleVisionGcashEvidence(fixture.annotation, fixture.text + "\nFailed"),
    undefined,
    "rotated status text is never ignored",
  );
});

Deno.test("native layout retains a small footer chevron without accepting rotated payment text", async () => {
  const nav = visionWord("Λ", 900, 1860);
  nav.boundingBox.vertices = [{ x: 920, y: 1860 }, { x: 920, y: 1890 },
    { x: 900, y: 1890 }, { x: 900, y: 1860 }];
  const words = [visionWord("Amount", 20, 100), visionWord("P4240.00", 400, 100), nav];
  const read = async (tail: string) => googleVisionOcr("test", "test", {
    fetcher: async () => Response.json({ responses: [{ fullTextAnnotation: {
      text: "Amount\nP4240.00\n" + tail, pages: [visionPage(words)],
    } }] }),
  });
  const result = await read("Λ");
  assertEquals(result.nativeLines?.map(line => line.text).join("\n"), "Amount P4240.00\nΛ", "footer retains valid receipt rows");
  assertEquals(result.text, "Amount\nP4240.00\nΛ", "raw evidence stays unchanged");
  nav.symbols = [{ text: "Failed" }];
  assertEquals((await read("Failed")).nativeLines, undefined, "rotated status is not a UI glyph");
  nav.symbols = [{ text: "Λ" }];
  nav.boundingBox.vertices = nav.boundingBox.vertices.map(p => ({ ...p, y: p.y - 900 }));
  assertEquals((await read("Λ")).nativeLines, undefined, "body letters keep strict geometry");
});

Deno.test("recipient crop confidence measures native visible characters and never fabricates missing symbol scores", () => {
  const word = (text: string, x: number, y: number) => ({
    ...visionWord(text, x, y),
    symbols: [...text].map((text) => ({
      text,
      confidence: /[A-Z0-9]/i.test(text) ? 0.96 : 0.2,
    })),
    confidence: 0.65,
  });
  const words = [
    word("KR....E", 200, 200),
    word("L..", 300, 200),
    word("C.", 350, 200),
    word("+63", 200, 300),
    word("9.....2169", 260, 300),
  ];
  const text = "KR....E L.. C.\n+63 9.....2169";
  const annotation = { text, pages: [visionPage(words)] };
  const evidence = googleVisionRecipientCropEvidence(annotation, text);
  assert(evidence, "two upright recipient rows recognized");
  assertEquals(
    evidence.basis,
    "visible_character_symbols",
    "score provenance explicit",
  );
  assert(
    Math.abs(evidence.confidence! - 0.96) < 1e-10,
    "low mask punctuation confidence does not become identity uncertainty",
  );
  delete (words[0].symbols[0] as { confidence?: number }).confidence;
  assertEquals(
    googleVisionRecipientCropEvidence(annotation, text)?.confidence,
    undefined,
    "missing symbol score cannot be inferred from word or page score",
  );
  assertEquals(
    googleVisionRecipientCropEvidence(annotation, text)?.confidenceSource,
    "none",
    "incomplete native source",
  );
  words[0].symbols[0].confidence = 0;
  assert(
    googleVisionRecipientCropEvidence(annotation, text)!.confidence! < 0.9,
    "known low visible letter confidence remains low",
  );
  assertEquals(
    googleVisionRecipientCropEvidence(annotation, text + "\nOTHER PERSON"),
    undefined,
    "partial hierarchy cannot conceal another recipient",
  );
});

Deno.test("Vision retries transient HTTP and embedded RPC failures once with actual request metrics", async () => {
  for (const failure of [429, 503, 4, 8, 13, 14]) {
    let calls = 0;
    const result = await googleVisionOcr("test-key", "QUJD", {
      retryDelayMs: 0,
      fetcher: (async () => {
        calls++;
        if (calls === 1) {
          return failure >= 400
            ? Response.json({ error: { message: "temporary" } }, {
              status: failure,
            })
            : Response.json({
              responses: [{ error: { code: failure, message: "temporary" } }],
            });
        }
        return Response.json({
          responses: [{
            fullTextAnnotation: {
              text: "valid receipt",
              pages: [{ confidence: .97 }],
            },
          }],
        });
      }) as typeof fetch,
    });
    assertEquals(calls, 2, "one recovery attempt");
    assertEquals(result.requestMetrics?.calls, 2, "actual calls recorded");
    assertEquals(result.requestMetrics?.retries, 1, "retry recorded");
  }
});

Deno.test("Vision retries network failures but never authentication/configuration errors", async () => {
  let networkCalls = 0;
  const result = await googleVisionOcr("test-key", "QUJD", {
    retryDelayMs: 0,
    fetcher: (async () => {
      if (++networkCalls === 1) throw new TypeError("temporary network error");
      return Response.json({
        responses: [{
          fullTextAnnotation: {
            text: "valid receipt",
            pages: [{ confidence: .97 }],
          },
        }],
      });
    }) as typeof fetch,
  });
  assertEquals(result.requestMetrics?.calls, 2, "network error retried once");
  for (const status of [400, 401, 403]) {
    let calls = 0;
    let metrics: unknown;
    try {
      await googleVisionOcr("test-key", "QUJD", {
        retryDelayMs: 0,
        fetcher: (async () => {
          calls++;
          return Response.json(
            { error: { message: "configuration failure" } },
            { status },
          );
        }) as typeof fetch,
      });
    } catch (error) {
      metrics = (error as { requestMetrics: unknown }).requestMetrics;
    }
    assertEquals(calls, 1, "configuration errors are not retried");
    assertEquals(
      (metrics as { calls: number }).calls,
      1,
      "failed request metrics retained",
    );
  }
});

Deno.test("Vision aborts a stalled first request and retries within the same total deadline", async () => {
  let calls = 0;
  let firstSignal: AbortSignal | null | undefined;
  const started = Date.now();
  const result = await googleVisionOcr("test-key", "QUJD", {
    timeoutMs: 100,
    retryDelayMs: 0,
    fetcher: (async (_input, init) => {
      if (++calls === 1) {
        firstSignal = init?.signal;
        return {
          ok: true,
          status: 200,
          json: () => new Promise(() => {}),
        } as unknown as Response;
      }
      return Response.json({
        responses: [{
          fullTextAnnotation: {
            text: "recovered receipt",
            pages: [{ confidence: .97 }],
          },
        }],
      });
    }) as typeof fetch,
  });
  assert(firstSignal?.aborted, "first fetch is aborted, not left running");
  assertEquals(calls, 2, "one retry after timeout");
  assertEquals(result.text, "recovered receipt", "second attempt result");
  assert(Date.now() - started < 200, "retry shares total budget");
});

Deno.test("Vision repeated transient errors stop after two calls and preserve failure metrics", async () => {
  let calls = 0;
  let caught: unknown;
  try {
    await googleVisionOcr("test-key", "QUJD", {
      retryDelayMs: 0,
      fetcher: (async () => {
        calls++;
        return Response.json({ error: { message: "unavailable" } }, {
          status: 503,
        });
      }) as typeof fetch,
    });
  } catch (error) {
    caught = error;
  }
  assertEquals(calls, 2, "bounded attempts");
  assertEquals(
    (caught as { requestMetrics: { retries: number } }).requestMetrics.retries,
    1,
    "failure audit includes retry",
  );
});
