import {
  detectReceiptImageContentType,
  googleVisionConfidence,
  googleVisionConfidenceDetails,
  googleVisionLayoutText,
  googleVisionOcr,
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
