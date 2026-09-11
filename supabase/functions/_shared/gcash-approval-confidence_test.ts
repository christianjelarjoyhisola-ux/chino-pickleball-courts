import { gcashApprovalConfidence } from "./gcash-approval-confidence.ts";
import { parseGcashReceipt } from "./gcash-receipt.ts";
import type { GoogleVisionGcashEvidence } from "./google-vision.ts";
import type { GcashRecipientOcrResult } from "./gcash-recipient-ocr.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function evidence(confidence = 0.97): GoogleVisionGcashEvidence {
  return {
    layoutText: "Express Send",
    confidence,
    confidenceSource: "native",
    fields: {
      amount: { text: "1,590.00", confidence },
      totalAmount: { text: "₱1,590.00", confidence },
      reference: { text: "9044 881673119", confidence },
      dateTime: { text: "Sep 10, 2026 9:06 AM", confidence },
      recipientPhone: { text: "+63 9•••••2169", confidence },
      recipientName: { text: "KR••••E L•• C.", confidence },
    },
  };
}

function crop(confidence = 0.96): GcashRecipientOcrResult {
  const text = "KR••••E L•• C.\n+63 9•••••2169";
  const receiver = parseGcashReceipt(`${text}\nSent via GCash`).receiver;
  return {
    attempted: true,
    accepted: true,
    changed: true,
    reason: "optical_agreement",
    confidence,
    receiver,
    primaryReceiver: structuredClone(receiver),
    observations: ["native", "enlarged"].map((view) => ({
      view: view as "native" | "enlarged",
      text,
      confidence,
      confidenceSource: "native",
      receiver,
      recipientCropEvidence: {
        name: { text: receiver.name.raw!, confidence },
        phone: { text: receiver.phone.raw!, confidence },
        confidence,
        confidenceSource: "native",
        basis: "visible_character_symbols",
      },
    })),
    region: { x: 30, y: 100, width: 300, height: 120 },
  };
}

Deno.test("GCash uses the weakest complete native payment field despite low page confidence", () => {
  const observed = evidence();
  observed.fields.reference!.confidence = 0.93;
  const original = structuredClone(observed);
  assertEquals(gcashApprovalConfidence(0.8829, "native", observed), {
    confidence: 0.93,
    source: "gcash_payment_fields",
  });
  assertEquals(observed, original);
});

Deno.test("GCash weak required fields cannot be rescued by a high overall page score", () => {
  for (const field of Object.keys(evidence().fields)) {
    const observed = evidence();
    observed.fields[field as keyof typeof observed.fields]!.confidence = 0.71;
    assertEquals(gcashApprovalConfidence(0.99, "native", observed), {
      confidence: 0.71,
      source: "gcash_payment_fields",
    });
  }
});

Deno.test("GCash complete native fields ignore an untrusted precomputed aggregate", () => {
  const observed = evidence(0.94);
  observed.confidence = 1;
  assertEquals(gcashApprovalConfidence(0.88, "native", observed), {
    confidence: 0.94,
    source: "gcash_payment_fields",
  });
});

Deno.test("GCash incomplete field evidence retains the native page policy", () => {
  for (const field of Object.keys(evidence().fields)) {
    const observed = evidence();
    delete observed.fields[field as keyof typeof observed.fields];
    assertEquals(gcashApprovalConfidence(0.8829, "native", observed), {
      confidence: 0.8829,
      source: "native",
    });
  }
  assertEquals(gcashApprovalConfidence(0.95, "native", undefined), {
    confidence: 0.95,
    source: "native",
  });
});

Deno.test("GCash heuristic or absent OCR never becomes native field confidence", () => {
  for (const source of ["heuristic", "none"] as const) {
    assertEquals(gcashApprovalConfidence(0.88, source, evidence()), {
      confidence: 0.88,
      source,
    });
  }
});

Deno.test("GCash accepted native recipient rereads replace only recipient field scores", () => {
  const observed = evidence();
  observed.fields.recipientName!.confidence = 0.62;
  observed.fields.recipientPhone!.confidence = 0.53;
  observed.fields.amount!.confidence = 0.95;
  assertEquals(gcashApprovalConfidence(0.88, "native", observed, crop()), {
    confidence: 0.95,
    source: "gcash_payment_fields",
  });
  observed.fields.reference!.confidence = 0.8;
  assertEquals(gcashApprovalConfidence(0.88, "native", observed, crop()), {
    confidence: 0.8,
    source: "gcash_payment_fields",
  });
});

Deno.test("GCash live mask-dropout consensus clears only the weak recipient fields", () => {
  const observed = evidence();
  observed.fields.amount!.confidence = 0.98965883;
  observed.fields.totalAmount!.confidence = 0.9061786;
  observed.fields.reference!.confidence = 0.98979497;
  observed.fields.dateTime!.confidence = 0.98474344625;
  observed.fields.recipientPhone!.confidence = 0.9767577483333333;
  observed.fields.recipientName!.confidence = 0.8964695599999999;
  const reread = crop(0.9171828);
  reread.reason = "mask_dropout_agreement";
  assertEquals(
    gcashApprovalConfidence(0.9565279, "native", observed, reread),
    { confidence: 0.9061786, source: "gcash_payment_fields" },
  );
});

Deno.test("GCash rejected recipient rereads retain primary payment-field confidence", () => {
  const observed = evidence();
  observed.fields.recipientName!.confidence = 0.6;
  const rejected = crop();
  rejected.accepted = false;
  for (const refinement of [rejected]) {
    assertEquals(
      gcashApprovalConfidence(0.99, "native", observed, refinement),
      {
        confidence: 0.6,
        source: "gcash_payment_fields",
      },
    );
  }
});

Deno.test("GCash accepted crop scores use actual visible symbols while retaining raw crop confidence", () => {
  const observed = evidence();
  observed.fields.recipientName!.confidence = 0.65;
  const reread = crop(0.95);
  reread.observations[0].confidence = 0.657;
  reread.observations[1].confidence = 0.749;
  reread.observations[1].recipientCropEvidence!.name.confidence = 0.913;
  assertEquals(gcashApprovalConfidence(0.88, "native", observed, reread), {
    confidence: 0.913,
    source: "gcash_payment_fields",
  });
  assertEquals(reread.observations.map((item) => item.confidence), [
    0.657,
    0.749,
  ]);
});

Deno.test("GCash an accepted crop claim cannot use missing, nonnative or weak field evidence", () => {
  const invalid = [crop(0.89)];
  const missing = crop();
  delete missing.observations[0].recipientCropEvidence;
  invalid.push(missing);
  const missingScore = crop();
  delete missingScore.observations[0].recipientCropEvidence!.name.confidence;
  invalid.push(missingScore);
  const nonnative = crop();
  nonnative.observations[0].recipientCropEvidence!.confidenceSource = "none";
  invalid.push(nonnative);
  const wrongBasis = crop();
  Object.assign(wrongBasis.observations[0].recipientCropEvidence!, {
    basis: "parser_match",
  });
  invalid.push(wrongBasis);
  const aggregateOnly = crop();
  aggregateOnly.observations[1].recipientCropEvidence!.phone.confidence = 0.89;
  invalid.push(aggregateOnly);
  const duplicateView = crop();
  duplicateView.observations[1].view = "native";
  invalid.push(duplicateView);
  for (const confidence of [NaN, Infinity, -1, 1.1]) {
    const badScore = crop();
    badScore.observations[0].recipientCropEvidence!.name.confidence =
      confidence;
    invalid.push(badScore);
  }
  for (const refinement of invalid) {
    assertEquals(
      gcashApprovalConfidence(0.99, "native", evidence(), refinement),
      {
        confidence: 0,
        source: "none",
      },
    );
  }
});

Deno.test("GCash incomplete evidence after an accepted crop uses the lower page/crop score", () => {
  const observed = evidence();
  delete observed.fields.dateTime;
  assertEquals(gcashApprovalConfidence(0.99, "native", observed, crop(0.94)), {
    confidence: 0.94,
    source: "native",
  });
  assertEquals(gcashApprovalConfidence(0.88, "native", observed, crop(0.97)), {
    confidence: 0.88,
    source: "native",
  });
});

Deno.test("GCash missing field geometry cannot hide known uncertainty in another payment field", () => {
  const observed = evidence();
  delete observed.fields.dateTime;
  observed.fields.recipientName!.confidence = 0.7;
  assertEquals(gcashApprovalConfidence(0.99, "native", observed), {
    confidence: 0.7,
    source: "native",
  });
  assertEquals(gcashApprovalConfidence(0.99, "native", observed, crop(0.94)), {
    confidence: 0.94,
    source: "native",
  });
  observed.fields.reference!.confidence = 0.65;
  assertEquals(gcashApprovalConfidence(0.99, "native", observed, crop(0.94)), {
    confidence: 0.65,
    source: "native",
  });
});

Deno.test("GCash blank or invalid field scores cannot manufacture complete evidence", () => {
  for (const confidence of [undefined, NaN, Infinity, -0.01, 1.01]) {
    const observed = evidence();
    observed.fields.amount!.confidence = confidence;
    assertEquals(gcashApprovalConfidence(0.88, "native", observed), {
      confidence: 0.88,
      source: "native",
    });
  }
  const observed = evidence();
  observed.fields.amount!.text = " ";
  assertEquals(gcashApprovalConfidence(0.88, "native", observed), {
    confidence: 0.88,
    source: "native",
  });
});
