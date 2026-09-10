import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";
import {
  BANK_FIXTURES,
  bankFixtureOriginal,
  bankFixtureRead,
} from "./bank-ocr-fixtures.ts";
import {
  deriveGotymeFieldRegions,
  evaluateGotymeFieldReads,
  type GotymeFieldReads,
  recoverGotymeFields,
} from "./gotyme-field-recovery.ts";
import { bankOcrText } from "./bank-ocr-evidence.ts";
import { receiptImageDimensions } from "./google-vision.ts";
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function eq(actual: unknown, expected: unknown, message = "equality") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
    );
  }
}
const fixture = BANK_FIXTURES[3];
function original() {
  const read = bankFixtureRead(
    fixture.text.replace("****************9WO7", "**\n*9W07").replace(
      "Amount ₱265.00",
      "Amount $265.00",
    ),
  );
  for (const line of read.nativeLines!) {
    for (const word of line.words) {
      if (word.text.includes("9W07") || word.text === "₱0.00") {
        word.confidence = .65;
        word.symbols.forEach((symbol) => symbol.confidence = .65);
      }
    }
  }
  return bankFixtureOriginal(fixture, read);
}
function reads(): GotymeFieldReads {
  const recipient = () =>
    bankFixtureRead(
      "To KR****E L** C*\n****************9WO7\nG-Xchange, Inc (GCash)",
    );
  const amounts = () =>
    bankFixtureRead("Amount ₱265.00\nFee ₱0.00\nTotal ₱265.00");
  return {
    recipient: { contrast: recipient(), enlarged: recipient() },
    amounts: { contrast: amounts(), enlarged: amounts() },
  };
}
function evaluate(input = original(), views = reads()) {
  const regions = deriveGotymeFieldRegions(input.read, {
    width: 1000,
    height: 1000,
  });
  assert(
    regions,
    "source geometry gives bounded panels without parsed account or recipientRegion",
  );
  return evaluateGotymeFieldReads(input, fixture.context, regions, views);
}

Deno.test("native panel geometry works despite fragmented masks and missing legacy recipientRegion", () => {
  const input = original();
  eq(input.read.recipientRegion, undefined);
  const regions = deriveGotymeFieldRegions(input.read, {
    width: 1000,
    height: 1000,
  });
  assert(regions, "found both panels");
  assert(
    regions.recipient.end < regions.amounts.start,
    "sender panel is excluded",
  );
  assert(
    input.read.nativeLines![regions.recipient.start].text.startsWith("To"),
    "To anchor included",
  );
  eq(
    input.read.nativeLines![regions.recipient.end].text.startsWith("From"),
    true,
  );
  const ambiguous = structuredClone(input.read);
  ambiguous.nativeLines!.push(ambiguous.nativeLines![regions.recipient.start]);
  eq(
    deriveGotymeFieldRegions(ambiguous, { width: 1000, height: 1000 }),
    null,
    "ambiguous anchors cannot generate crops",
  );
});

Deno.test("two native panel views can repair only weak observed fields while conserving the whole receipt", () => {
  const input = original(), raw = input.read.text;
  const result = evaluate(input);
  eq(result.accepted, true, JSON.stringify(result.audit));
  eq(result.reason, "targeted_readings_agree");
  eq(result.selected?.parsed.receipt.amount.amount, 265);
  eq(
    result.selected?.parsed.receipt.recipient.accountRaw,
    "****************9WO7",
  );
  eq(
    result.selected?.parsed.receipt.reference.value,
    input.parsed.receipt.reference.value,
  );
  eq(
    result.selected?.parsed.receipt.timestamp.instant,
    input.parsed.receipt.timestamp.instant,
  );
  eq(result.selected?.read.text, raw, "original raw OCR retained");
  eq(input.read.text, raw, "no original mutation");
  eq(
    result.selected?.approval.confidence,
    .97,
    "native score not agreement percentage",
  );
  assert(
    bankOcrText(result.selected!.read).includes("From SHEEJAN"),
    "untouched original sender context remains",
  );
});

Deno.test("unchanged wrong O/0 or currency glyphs never become approval", () => {
  const wrongAccount = reads();
  for (const view of ["contrast", "enlarged"] as const) {
    wrongAccount.recipient[view] = bankFixtureRead(
      wrongAccount.recipient[view].text.replace("9WO7", "9W07"),
      .6,
    );
  }
  eq(evaluate(original(), wrongAccount).accepted, false);
  const wrongCurrency = reads();
  for (const view of ["contrast", "enlarged"] as const) {
    wrongCurrency.amounts[view] = bankFixtureRead(
      wrongCurrency.amounts[view].text.replace(
        "Amount ₱265.00",
        "Amount $265.00",
      ),
    );
  }
  eq(evaluate(original(), wrongCurrency).accepted, false);
});

Deno.test("native confidence remains mandatory in every recipient and monetary view", () => {
  for (const panel of ["recipient", "amounts"] as const) {
    for (const view of ["contrast", "enlarged"] as const) {
      const views = reads();
      views[panel][view] = bankFixtureRead(views[panel][view].text, .85);
      eq(evaluate(original(), views).accepted, false, `${panel} ${view}`);
    }
  }
});

Deno.test("owner or merchant configuration cannot make conflicting strong source fields recoverable", () => {
  const input = original();
  for (const word of input.read.nativeLines!.flatMap((line) => line.words)) {
    if (word.text.includes("9W07")) {
      word.confidence = .98;
      word.symbols.forEach((symbol) => symbol.confidence = .98);
    }
  }
  const result = evaluate(input);
  eq(result.accepted, false);
  assert(
    result.reason.startsWith("original_conflict:"),
    "strong wrong original recipient is not rewritten",
  );
});

Deno.test("processing and reversal remain vetoes even when every crop appears clean", () => {
  const input = original();
  input.read.text += "\nPending";
  eq(evaluate(input).reason, "original_conflict:PAYMENT_STATUS_NOT_COMPLETED");
  const views = reads();
  views.recipient.enlarged.text += "\nReversed";
  eq(evaluate(original(), views).reason, "recovery_conflict");
});

Deno.test("one high-confidence wrong recipient or changed fee is not outvoted", () => {
  const views = reads();
  views.recipient.enlarged = bankFixtureRead(
    views.recipient.enlarged.text.replace("9WO7", "9WX7"),
  );
  eq(evaluate(original(), views).accepted, false);
  const money = reads();
  money.amounts.enlarged = bankFixtureRead(
    "Amount ₱260.00\nFee ₱5.00\nTotal ₱265.00",
  );
  eq(
    evaluate(original(), money).accepted,
    false,
    "fee and principal cannot be traded to fit total",
  );
});

Deno.test("targeted optical calls use pixels only with four concurrent bounded diverse reads", async () => {
  const bytes = await new Image(1000, 1000).fill(0xffffffff).encode(),
    input = original();
  let calls = 0, release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => release = resolve);
  const observed: Array<{ feature?: string; dimensions: unknown }> = [];
  const result = await recoverGotymeFields(
    bytes,
    input,
    fixture.context,
    "test-key",
    {
      ocr: async (_key, encoded, options) => {
        const index = calls++;
        observed.push({
          feature: options?.featureType,
          dimensions: receiptImageDimensions(
            Uint8Array.from(
              atob(encoded),
              (character) => character.charCodeAt(0),
            ),
          ),
        });
        assert(
          options?.timeoutMs! <= 10000 && options?.timeoutMs! > 0,
          "shared deadline includes preparation",
        );
        if (index < 3) await waiting;
        else release();
        const views = reads();
        return index < 2
          ? views.recipient[index === 0 ? "contrast" : "enlarged"]
          : views.amounts[index === 2 ? "contrast" : "enlarged"];
      },
    },
  );
  eq(result.accepted, true, JSON.stringify(result.audit));
  eq(calls, 4);
  eq(observed.map((view) => view.feature), [
    "TEXT_DETECTION",
    "DOCUMENT_TEXT_DETECTION",
    "TEXT_DETECTION",
    "DOCUMENT_TEXT_DETECTION",
  ]);
});

Deno.test("one failed panel retains every attempt metric and cannot alter source data", async () => {
  const bytes = await new Image(1000, 1000).fill(0xffffffff).encode();
  let calls = 0;
  const result = await recoverGotymeFields(
    bytes,
    original(),
    fixture.context,
    "test-key",
    {
      ocr: async () => {
        const index = calls++;
        if (index === 3) {
          throw Object.assign(new Error("unavailable"), {
            requestMetrics: { calls: 2, retries: 1, durationMs: 10 },
          });
        }
        const views = reads();
        return index < 2 ? views.recipient.contrast : views.amounts.contrast;
      },
    },
  );
  eq(result.accepted, false);
  eq(result.reason, "transport_unavailable");
  eq(result.audit.readings.length, 4);
  eq(result.audit.readings[3].requestMetrics?.retries, 1);
});

Deno.test("a weak unreadable crop total rejects that view without blocking later full-image recovery", () => {
  const views = reads();
  views.amounts.enlarged = bankFixtureRead(
    "Amount ₱265.00\nFee ₱0.00\nTotal $265.00",
  );
  const result = evaluate(original(), views);
  eq(
    result.accepted,
    false,
    "the candidate never replaces the strong original total",
  );
  eq(
    result.reason,
    "recovery_incomplete",
    "a failed optional crop remains recoverable",
  );
  assert(
    result.audit.readings.some((reading) =>
      reading.flags.includes("ORIGINAL_TOTAL0_CONFLICT")
    ),
    "conservation failure remains in audit",
  );
  assert(
    result.audit.readings.every((reading) => reading.outcome !== "conflict"),
    "no high-confidence contradiction was observed",
  );
});

Deno.test("a confident changed crop total remains a hard conflict", () => {
  const views = reads();
  views.amounts.enlarged = bankFixtureRead(
    "Amount ₱265.00\nFee ₱0.00\nTotal ₱266.00",
  );
  const result = evaluate(original(), views);
  eq(result.accepted, false);
  eq(result.reason, "recovery_conflict");
  assert(
    result.audit.readings.some((reading) =>
      reading.outcome === "conflict" &&
      reading.flags.includes("ORIGINAL_TOTAL0_CONFLICT")
    ),
    "strong different total blocks approval",
  );
});

Deno.test("completed optical attempts remain in the audit after the shared deadline expires", async () => {
  const bytes = await new Image(1000, 1000).fill(0xffffffff).encode();
  const realNow = Date.now;
  let clock = 0, calls = 0;
  try {
    Date.now = () => clock;
    const result = await recoverGotymeFields(
      bytes,
      original(),
      fixture.context,
      "test",
      {
        deadlineMs: 100,
        ocr: async () => {
          const index = calls++;
          const views = reads();
          const read = index < 2
            ? views.recipient.contrast
            : views.amounts.contrast;
          read.requestMetrics = { calls: 1, retries: 0, durationMs: 25 };
          if (index === 3) clock = 101;
          return read;
        },
      },
    );
    eq(result.accepted, false);
    eq(result.reason, "recovery_deadline_exceeded");
    eq(result.audit.attempted, true);
    eq(result.audit.readings.length, 4);
    eq(result.audit.readings.map((reading) => reading.requestMetrics?.calls), [
      1,
      1,
      1,
      1,
    ]);
    assert(
      result.audit.readings.every((reading) =>
        !!reading.rawText && !!reading.layoutText &&
        reading.outcome === "uncertain"
      ),
      "completed optical evidence remains available without approval",
    );
    eq(result.audit.elapsedMs, 101);
  } finally {
    Date.now = realNow;
  }
});

Deno.test("one failed optical attempt cannot hide another panel's pending status", async () => {
  const bytes = await new Image(1000, 1000).fill(0xffffffff).encode();
  let calls = 0;
  const result = await recoverGotymeFields(
    bytes,
    original(),
    fixture.context,
    "test",
    {
      ocr: async () => {
        const index = calls++;
        if (index === 3) throw new Error("network unavailable");
        const views = reads();
        const read = index < 2
          ? views.recipient.contrast
          : views.amounts.contrast;
        if (index === 2) read.text += "\nPending";
        return read;
      },
    },
  );
  eq(result.accepted, false);
  eq(result.reason, "recovery_conflict");
  eq(result.audit.readings[2].outcome, "conflict");
  eq(result.audit.readings[3].outcome, "error");
});
