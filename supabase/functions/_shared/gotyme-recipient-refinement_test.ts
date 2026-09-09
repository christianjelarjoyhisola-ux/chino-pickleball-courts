import {
  type GotymeRecipientCropObservation,
  refineGotymeRecipient,
} from "./gotyme-recipient-refinement.ts";
import {
  parseGotymeToGcashReceipt,
  verifyGotymeToGcashReceipt,
} from "./receipt-providers/gotyme.ts";

function equal(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

const PRIMARY_TEXT = `Transferred
P265.00
InstaPay Instant
To KR****E L** C*
****9W07
G-Xchange, Inc (GCash)
From SHEEJAN E*****
********4162
GoTyme Bank
Amount P265.00
Fee P0.00
Total P265.00
Trace ID 941016
Reference No. ITO260909055941016
Date 09 Sep 2026 at 1:59 PM`;

function primary(suffix = "9W07") {
  return parseGotymeToGcashReceipt(PRIMARY_TEXT.replace("9W07", suffix));
}

function crop(
  suffix = "9WO7",
  overrides: Partial<GotymeRecipientCropObservation> = {},
): GotymeRecipientCropObservation {
  return {
    text: `To\nKR****E L** C*\n****${suffix}\nG-Xchange, Inc (GCash)`,
    confidence: 0.98,
    confidenceSource: "native",
    ...overrides,
  };
}

Deno.test("two independent native-confidence GoTyme crop reads can refine only O versus zero", () => {
  const parsed = primary();
  const before = JSON.stringify(parsed);
  const result = refineGotymeRecipient(parsed, {
    native: crop(),
    enlarged: crop(),
  });
  equal(result.accepted, true, "accepted optical evidence");
  equal(result.changed, true, "O/zero changed");
  equal(result.reason, "optical_agreement", "audit reason");
  equal(result.originalAccountSuffix, "9W07", "original preserved in audit");
  equal(
    result.observedAccountSuffix,
    "9WO7",
    "independent optical observation",
  );
  equal(result.recipient.accountSuffix, "9WO7", "refined suffix");
  equal(result.recipient.accountRaw, "****9WO7", "account read from crop");
  equal(result.observations.map((observation) => observation.view), [
    "native",
    "enlarged",
  ], "separate audited views");
  equal(result.observations.map((observation) => observation.text), [
    crop().text,
    crop().text,
  ], "raw crop OCR retained");
  equal(JSON.stringify(parsed), before, "primary receipt never mutated");
  assert(
    !("reference" in result) && !("amount" in result) &&
      !("timestamp" in result),
    "return only recipient evidence",
  );
});

Deno.test("matching O reads and matching genuine-zero reads remain unchanged", () => {
  for (const suffix of ["9WO7", "9W07"]) {
    const parsed = primary(suffix);
    const result = refineGotymeRecipient(parsed, {
      native: crop(suffix),
      enlarged: crop(suffix),
    });
    equal(result.accepted, true, "concordant reads");
    equal(result.changed, false, "same characters remain unchanged");
    equal(result.reason, "unchanged", "unchanged audit reason");
    equal(
      result.recipient,
      parsed.recipient,
      "retain original account evidence",
    );
  }
});

Deno.test("multiple O/zero character changes remain in review even with crop consensus", () => {
  const parsed = primary("9W007");
  const result = refineGotymeRecipient(parsed, {
    native: crop("9WOO7"),
    enlarged: crop("9WOO7"),
  });
  equal(result.accepted, false, "only one optical character may change");
  equal(
    result.reason,
    "change_not_optically_confusable",
    "multiple changes rejected",
  );
  equal(
    result.recipient,
    parsed.recipient,
    "retain original recipient evidence",
  );
});

Deno.test("mask length and whitespace may differ without changing visible name or account", () => {
  const text =
    "To\nKR **** E L ** C *\n* * * * * * 9 W O 7\nG-Xchange, Inc (GCash)";
  const result = refineGotymeRecipient(primary(), {
    native: crop(),
    enlarged: crop("9WO7", { text }),
  });
  equal(result.accepted, true, "spacing and mask-count differences");
  equal(
    result.recipient.accountSuffix,
    "9WO7",
    "visible account characters unchanged",
  );
  equal(
    result.recipient.nameRaw,
    primary().recipient.nameRaw,
    "primary name retained",
  );
});

Deno.test("recipient refinement needs both high native-confidence crop reads", () => {
  const cases: Array<Partial<GotymeRecipientCropObservation>> = [
    { confidence: 0.899 },
    { confidence: 1.01 },
    { confidence: Number.NaN },
    { confidence: Number.POSITIVE_INFINITY },
    { confidence: 0.999, confidenceSource: "heuristic" },
    { confidence: 1, confidenceSource: "none" },
  ];
  for (const observation of cases) {
    for (const view of ["native", "enlarged"] as const) {
      const crops = { native: crop(), enlarged: crop() };
      crops[view] = crop("9WO7", observation);
      const parsed = primary();
      const result = refineGotymeRecipient(parsed, crops);
      equal(result.accepted, false, `${view} confidence fails closed`);
      equal(result.reason, "crop_confidence_insufficient", "quality reason");
      equal(result.recipient, parsed.recipient, "primary remains unchanged");
    }
  }
  equal(
    refineGotymeRecipient(primary(), {
      native: crop("9WO7", { confidence: 0.90 }),
      enlarged: crop("9WO7", { confidence: 0.90 }),
    }).accepted,
    true,
    "inclusive native confidence threshold",
  );
});

Deno.test("disagreeing crop account reads never select the matching expectation", () => {
  for (
    const observations of [
      { native: crop("9WO7"), enlarged: crop("9W07") },
      { native: crop("9W07"), enlarged: crop("9WO7") },
    ]
  ) {
    const result = refineGotymeRecipient(primary(), observations);
    equal(result.accepted, false, "OCR conflict stays in review");
    equal(result.reason, "crop_accounts_disagree", "conflict audit");
    equal(result.recipient.accountSuffix, "9W07", "original remains unchanged");
  }
});

Deno.test("non-O/zero account changes are rejected even when both crops agree", () => {
  for (const suffix of ["9WO8", "8WO7", "9VO7", "19WO7", "9WOI"]) {
    const result = refineGotymeRecipient(primary(), {
      native: crop(suffix),
      enlarged: crop(suffix),
    });
    equal(result.accepted, false, `reject ${suffix}`);
    equal(
      result.reason,
      "change_not_optically_confusable",
      "only O/zero changes permitted",
    );
    equal(result.recipient.accountSuffix, "9W07", "original stays unchanged");
  }
});

Deno.test("wrong, missing, or changed masked names cannot refine account identity", () => {
  for (
    const name of [
      "JO** D** R*",
      "KR***E L** C*",
      "KR****E L** C.",
      "",
      "SHEEJAN E*****",
    ]
  ) {
    const text = `To\n${name}\n****9WO7\nG-Xchange, Inc (GCash)`;
    const result = refineGotymeRecipient(primary(), {
      native: crop("9WO7", { text }),
      enlarged: crop("9WO7", { text }),
    });
    equal(result.accepted, false, "name cannot change");
    equal(result.reason, "crop_name_changed", "name audit reason");
  }
});

Deno.test("crop evidence must remain inside explicit To with a GCash destination", () => {
  const texts = [
    "To\nFrom\nKR****E L** C*\n****9WO7\nG-Xchange, Inc (GCash)",
    "To KR****E L** C*\n****9WO7\nOther Bank",
    "KR****E L** C*\n****9WO7\nG-Xchange, Inc (GCash)",
    "To KR****E L** C*\n****9WO7\nFrom\nG-Xchange, Inc (GCash)",
  ];
  for (const text of texts) {
    const result = refineGotymeRecipient(primary(), {
      native: crop("9WO7", { text }),
      enlarged: crop("9WO7", { text }),
    });
    equal(result.accepted, false, "wrong/missing recipient boundary");
    equal(
      result.reason,
      "crop_destination_unreadable",
      "recipient destination required",
    );
  }
});

Deno.test("reference numbers, full IDs, and sender accounts cannot replace masked recipient evidence", () => {
  const texts = [
    "To KR****E L** C*\nG-Xchange, Inc (GCash)\nReference No. ITO260909055941016",
    "To KR****E L** C*\nITO260909055941016\nG-Xchange, Inc (GCash)",
    "To KR****E L** C*\n****941016\nG-Xchange, Inc (GCash)",
    "To KR****E L** C*\nG-Xchange, Inc (GCash)\nFrom\n****9WO7",
    "To KR****E L** C*\n****9WO7\nOTHERACCOUNT1111\nG-Xchange, Inc (GCash)",
  ];
  for (const text of texts) {
    const result = refineGotymeRecipient(primary(), {
      native: crop("9WO7", { text }),
      enlarged: crop("9WO7", { text }),
    });
    equal(result.accepted, false, "unrelated or ambiguous account");
    equal(
      result.reason,
      "crop_recipient_incomplete",
      "masked destination required",
    );
  }
});

Deno.test("refinement supports GoTyme masked primary recipients only", () => {
  const unsupported = {
    ...primary(),
    provider: "maribank" as const,
    parserVersion: "maribank_to_gcash_v1" as const,
  };
  equal(
    refineGotymeRecipient(unsupported, { native: crop(), enlarged: crop() })
      .reason,
    "unsupported_primary",
    "provider gate",
  );
  const cases = [
    parseGotymeToGcashReceipt(
      PRIMARY_TEXT.replace("****9W07", "TESTMERCHANT9W07"),
    ),
    parseGotymeToGcashReceipt(
      PRIMARY_TEXT.replace(
        "To KR****E L** C*\n****9W07\nG-Xchange, Inc (GCash)",
        "To",
      ),
    ),
    {
      ...primary(),
      recipient: { ...primary().recipient, nameRaw: "KRISTIE LOU CACHUELA" },
    },
    {
      ...primary(),
      recipient: { ...primary().recipient, accountRaw: "****OTHER" },
    },
  ];
  for (const parsed of cases) {
    equal(
      refineGotymeRecipient(parsed, { native: crop(), enlarged: crop() })
        .reason,
      "primary_recipient_incomplete",
      "strict primary evidence",
    );
  }
});

Deno.test("genuine-zero consensus still fails the unchanged downstream expected-account check", () => {
  const parsed = primary();
  const result = refineGotymeRecipient(parsed, {
    native: crop("9W07"),
    enlarged: crop("9W07"),
  });
  const verified = verifyGotymeToGcashReceipt({
    ...parsed,
    recipient: result.recipient,
  }, {
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
  assert(
    verified.flags.includes("RECEIVER_ACCOUNT_MISMATCH"),
    "refinement never replaces the trusted configured-recipient gate",
  );
});
