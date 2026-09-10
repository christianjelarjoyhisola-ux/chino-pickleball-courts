import {
  bankApprovalConfidence,
  bankLayoutFamily,
  bankReceiptHasIncompleteStatus,
} from "./bank-ocr-evidence.ts";
import {
  BANK_FIXTURES,
  bankFixtureOriginal,
  bankFixtureRead,
} from "./bank-ocr-fixtures.ts";
import { verifyProviderReceipt } from "./receipt-providers/index.ts";
import { refineGotymeRecipient } from "./gotyme-recipient-refinement.ts";
import { googleVisionOcr } from "./google-vision.ts";
function eq(actual: unknown, expected: unknown, message = "equality") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
    );
  }
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

for (const fixture of BANK_FIXTURES) {
  Deno.test(`${fixture.provider} measures every critical observed field without unrelated page text`, () => {
    const original = bankFixtureOriginal(fixture);
    eq(
      verifyProviderReceipt(original.parsed, fixture.context).flags,
      [],
      "fixture policy passes",
    );
    const approval = bankApprovalConfidence(
      original.read,
      original.parsed,
      fixture.context,
    );
    eq(approval.confidence, .97);
    eq(approval.source, "bank_payment_fields");
    eq(approval.complete, true);
    assert(
      approval.confidence > original.read.confidence,
      "page confidence excludes irrelevant text",
    );
    assert(
      bankLayoutFamily(fixture.provider, fixture.text) !== "unknown",
      "tested layout recognized",
    );
    assert(
      approval.fields.secondaryReference.confidence === .97,
      "secondary payment ID has native evidence",
    );
    const wrongMerchant = {
      ...fixture.context,
      expectedRecipientName: "DIFFERENT MERCHANT",
      expectedAmount: 999999,
    };
    eq(
      bankApprovalConfidence(original.read, original.parsed, wrongMerchant)
        .fields,
      approval.fields,
      "merchant expectations do not alter optical evidence",
    );
  });

  Deno.test(`${fixture.provider} cannot wash a low critical reference with a high page average`, () => {
    const original = bankFixtureOriginal(fixture);
    const ref = original.parsed.receipt.reference.raw!.replace(/\s/g, "");
    original.read.confidence = .999;
    for (const line of original.read.nativeLines!) {
      for (const word of line.words) {
        if (
          ref.includes(word.text.replace(/\s/g, "")) && /\d/.test(word.text)
        ) {
          word.confidence = .62;
        }
      }
    }
    const approval = bankApprovalConfidence(
      original.read,
      original.parsed,
      fixture.context,
    );
    eq(approval.source, "bank_payment_fields");
    eq(approval.confidence, .62);
  });
}

Deno.test("missing native confidence does not become page confidence when geometry exists", () => {
  const fixture = BANK_FIXTURES[0], original = bankFixtureOriginal(fixture);
  original.read.confidence = .999;
  original.read.nativeLines!.flatMap((line) => line.words).find((word) =>
    word.text === "EC99"
  )!.confidence = undefined;
  const approval = bankApprovalConfidence(
    original.read,
    original.parsed,
    fixture.context,
  );
  eq(approval.source, "none");
  eq(approval.confidence, 0);
  eq(approval.complete, false);
});

Deno.test("legacy native whole-image fallback requires complete provider checks", () => {
  const fixture = BANK_FIXTURES[0], original = bankFixtureOriginal(fixture);
  delete original.read.nativeLines;
  original.read.confidence = .96;
  eq(
    bankApprovalConfidence(original.read, original.parsed, fixture.context)
      .source,
    "native",
  );
  eq(
    bankApprovalConfidence(original.read, original.parsed, {
      ...fixture.context,
      expectedAmount: 799,
    }).source,
    "none",
  );
  original.read.confidenceSource = "heuristic";
  eq(
    bankApprovalConfidence(original.read, original.parsed, fixture.context)
      .source,
    "none",
  );
});

Deno.test("masked identity uses observed visible-character confidence without inventing hidden digits", () => {
  const fixture = BANK_FIXTURES[3], original = bankFixtureOriginal(fixture);
  const account = original.read.nativeLines!.flatMap((line) => line.words).find(
    (word) => word.text.includes("9WO7"),
  )!;
  account.confidence = .61;
  account.symbols.forEach((symbol) =>
    symbol.confidence = symbol.text === "*" ? .31 : .98
  );
  const approval = bankApprovalConfidence(
    original.read,
    original.parsed,
    fixture.context,
  );
  eq(approval.fields.recipientAccount.text, "****************9WO7");
  eq(approval.fields.recipientAccount.confidence, .98);
  account.symbols.find((symbol) => symbol.text === "O")!.confidence = .55;
  eq(
    bankApprovalConfidence(original.read, original.parsed, fixture.context)
      .confidence,
    .55,
  );
});

Deno.test("two amount displays cannot hide one weak display or fee", () => {
  const fixture = BANK_FIXTURES[1], original = bankFixtureOriginal(fixture);
  const displays = original.read.nativeLines!.flatMap((line) => line.words)
    .filter((word) => word.text === "1,600.00");
  displays[1].confidence = .65;
  eq(
    bankApprovalConfidence(original.read, original.parsed, fixture.context)
      .confidence,
    .65,
  );
  displays[1].confidence = .97;
  original.read.nativeLines!.flatMap((line) => line.words).find((word) =>
    word.text === "0.00"
  )!.confidence = .6;
  eq(
    bankApprovalConfidence(original.read, original.parsed, fixture.context)
      .fields.fee0.confidence,
    .6,
  );
});

Deno.test("Security Bank bare amount remains original optical value, not parser-added PHP", () => {
  const fixture = BANK_FIXTURES[5], original = bankFixtureOriginal(fixture);
  const approval = bankApprovalConfidence(
    original.read,
    original.parsed,
    fixture.context,
  );
  eq(approval.fields.amount.text, "1.00");
  eq(approval.fields.fee0.text, "10.00");
  eq(approval.fields.total0.text, "₱ 11.00");
});

Deno.test("high native text from a different image cannot corroborate parsed values", () => {
  const fixture = BANK_FIXTURES[0], original = bankFixtureOriginal(fixture);
  original.read.nativeLines =
    bankFixtureRead("Help balance 800.00").nativeLines;
  const approval = bankApprovalConfidence(
    original.read,
    original.parsed,
    fixture.context,
  );
  eq(approval.source, "none");
  eq(approval.fields.reference.occurrences, 0);
});

Deno.test("unknown provider/receipt grammar is excluded from strategy learning", () => {
  eq(bankLayoutFamily("pnb", BANK_FIXTURES[0].text), "unknown");
  eq(bankLayoutFamily("maya", "maya Amount Reference"), "unknown");
});

Deno.test("adverse status cannot be outvoted by success and processing fee is not status", () => {
  for (
    const value of [
      "Processing",
      "Pending",
      "Failed",
      "Reversed",
      "Refunded",
      "In progress",
      "On hold",
      "Not completed",
    ]
  ) {
    eq(
      bankReceiptHasIncompleteStatus("Transfer successful!\n" + value),
      true,
      value,
    );
  }
  eq(
    bankReceiptHasIncompleteStatus(
      "Transfer successful!\nProcessing fee 10.00\nProcessing time: Instant",
    ),
    false,
  );
});

Deno.test("a visible X inside a masked recipient suffix keeps its real confidence", () => {
  const fixture = BANK_FIXTURES[3],
    text = fixture.text.replaceAll("9WO7", "9WX7");
  const original = bankFixtureOriginal(fixture, bankFixtureRead(text));
  const word = original.read.nativeLines!.flatMap((line) => line.words).find((
    word,
  ) => word.text.includes("9WX7"))!;
  word.confidence = .55;
  word.symbols.forEach((symbol) =>
    symbol.confidence = symbol.text === "X"
      ? .2
      : symbol.text === "*"
      ? .3
      : .97
  );
  eq(
    bankApprovalConfidence(original.read, original.parsed, fixture.context)
      .fields.recipientAccount.confidence,
    .2,
  );
});

Deno.test("mask-only native words are excluded while every visible suffix word remains required", () => {
  const fixture = BANK_FIXTURES[3];
  const text = fixture.text.replace(
    "****************9WO7",
    "**************** 9WO7",
  );
  const original = bankFixtureOriginal(fixture, bankFixtureRead(text));
  const words = original.read.nativeLines!.flatMap((line) => line.words);
  words.find((word) => word.text === "****************")!.confidence = .2;
  eq(
    bankApprovalConfidence(original.read, original.parsed, fixture.context)
      .fields.recipientAccount.confidence,
    .97,
  );
  words.find((word) => word.text === "9WO7")!.confidence = undefined;
  words.find((word) => word.text === "9WO7")!.symbols.find((symbol) =>
    symbol.text === "O"
  )!.confidence = undefined;
  eq(
    bankApprovalConfidence(original.read, original.parsed, fixture.context)
      .source,
    "none",
  );
});

Deno.test("a separate masked-account suffix word cannot hide a low native O behind its high word average", () => {
  const fixture = BANK_FIXTURES[3];
  const original = bankFixtureOriginal(
    fixture,
    bankFixtureRead(
      fixture.text.replace("****************9WO7", "**************** 9WO7"),
    ),
  );
  const word = original.read.nativeLines!.flatMap((line) => line.words).find((
    word,
  ) => word.text === "9WO7")!;
  word.confidence = .95;
  word.symbols.find((symbol) => symbol.text === "O")!.confidence = .798;
  eq(
    bankApprovalConfidence(original.read, original.parsed, fixture.context)
      .fields.recipientAccount.confidence,
    .798,
  );
});

Deno.test("a proven reference-label punctuation boundary is accepted but numeric suffix matches are not", () => {
  const fixture = BANK_FIXTURES[1];
  const original = bankFixtureOriginal(
    fixture,
    bankFixtureRead(
      fixture.text.replace("Reference no.\nBN-", "Reference no.BN-"),
    ),
  );
  eq(verifyProviderReceipt(original.parsed, fixture.context).flags, []);
  eq(
    bankApprovalConfidence(original.read, original.parsed, fixture.context)
      .fields.reference.confidence,
    .97,
  );
  const nativeReference = original.read.nativeLines!.flatMap((line) =>
    line.words
  ).find((word) => word.text.includes("BN-"))!;
  nativeReference.text = "99BN-20260902-69811640";
  eq(
    bankApprovalConfidence(original.read, original.parsed, fixture.context)
      .fields.reference.occurrences,
    0,
  );
});

Deno.test("existing supported status punctuation and BPI zone grammar preserve clean confidence", () => {
  for (
    const [index, from, to] of [[3, "Transferred", "Transferred!"], [
      1,
      "Sent!",
      "Sent",
    ], [2, "(GMT +8)", "(GMT +8:00)"]] as const
  ) {
    const fixture = BANK_FIXTURES[index];
    const original = bankFixtureOriginal(
      fixture,
      bankFixtureRead(fixture.text.replace(from, to)),
    );
    eq(verifyProviderReceipt(original.parsed, fixture.context).flags, []);
    eq(
      bankApprovalConfidence(original.read, original.parsed, fixture.context)
        .confidence,
      .97,
    );
    assert(
      bankLayoutFamily(fixture.provider, original.read.text) !== "unknown",
      "stable layout punctuation",
    );
  }
});

Deno.test("GoTyme uses two actual native crop account observations for a weak original O/0", () => {
  const fixture = BANK_FIXTURES[3];
  const original = bankFixtureOriginal(
    fixture,
    bankFixtureRead(fixture.text.replace("9WO7", "9W07")),
  );
  if (original.parsed.provider !== "gotyme") throw Error("fixture");
  const word = original.read.nativeLines!.flatMap((line) => line.words).find((
    word,
  ) => word.text.includes("9W07"))!;
  word.confidence = .65;
  word.symbols.forEach((symbol) => symbol.confidence = .65);
  const crop = bankFixtureRead(
    "To KR****E L** C*\n****************9WO7\nG-Xchange, Inc (GCash)",
  );
  crop.confidence = .97;
  const refinement = refineGotymeRecipient(original.parsed.receipt, {
    native: crop,
    enlarged: crop,
  });
  assert(refinement.accepted, "existing optical O/0 rule accepted");
  const parsed = {
    ...original.parsed,
    receipt: { ...original.parsed.receipt, recipient: refinement.recipient },
  };
  const approval = bankApprovalConfidence(
    original.read,
    parsed,
    fixture.context,
    { accepted: true, nativeRead: crop, enlargedRead: crop },
  );
  eq(approval.confidence, .97);
  eq(approval.fields.recipientAccount.source, "native_recipient_crop_pair");
  // Neither an accepted boolean alone nor strong contradictory original evidence suffices.
  eq(
    bankApprovalConfidence(original.read, parsed, fixture.context, {
      accepted: true,
    }).source,
    "none",
  );
  word.confidence = .98;
  word.symbols.forEach((symbol) => symbol.confidence = .98);
  eq(
    bankApprovalConfidence(original.read, parsed, fixture.context, {
      accepted: true,
      nativeRead: crop,
      enlargedRead: crop,
    }).source,
    "none",
  );
});

for (const fixture of BANK_FIXTURES) {
  Deno.test(`${fixture.provider} confidence flows through Google Page/Word/Symbol response and geometry`, async () => {
    const template = bankFixtureRead(fixture.text);
    const words = template.nativeLines!.flatMap((line) => line.words).map((
      word,
    ) => ({
      confidence: word.confidence,
      symbols: word.symbols,
      boundingBox: {
        vertices: [
          { x: word.left, y: word.top },
          { x: word.right, y: word.top },
          { x: word.right, y: word.bottom },
          { x: word.left, y: word.bottom },
        ],
      },
    }));
    const fullTextAnnotation = {
      text: fixture.text,
      pages: [{
        width: 4096,
        height: 8192,
        confidence: .72,
        blocks: [{ paragraphs: [{ words }] }],
      }],
    };
    const read = await googleVisionOcr("fixture-key", "QUJD", {
      fetcher: (async () =>
        new Response(JSON.stringify({ responses: [{ fullTextAnnotation }] }), {
          status: 200,
        })) as typeof fetch,
    });
    const original = bankFixtureOriginal(fixture, read);
    eq(read.confidence, .72);
    assert(read.nativeLines?.length, "real response mapper exposes geometry");
    eq(
      bankApprovalConfidence(read, original.parsed, fixture.context).confidence,
      .97,
    );
  });
}
