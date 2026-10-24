import { parseProviderReceipt, verifyProviderReceipt } from "./index.ts";
import { bankFixtureRead } from "../bank-ocr-fixtures.ts";
import { maribankDirectApprovalConfidence } from "../bank-ocr-evidence.ts";
const ctx = {
  expectedAmount: 530,
  pricingAvailable: true,
  amountTolerance: .01,
  expectedRecipientName: "KRISTIE LOU VILLANUEVA",
  expectedRecipientNumber: "15521507144",
  bookingStartedAt: "2026-10-24T05:40:00Z",
  bookingStartedDate: "2026-10-24",
  paymentWindowMinutes: 15,
  earlyToleranceMinutes: 2,
  now: "2026-10-24T10:00:00Z",
};
const native = `M MariBank
Transaction Receipt
PHP 530.00
From SAMPLE SENDER
MariBank: *******4104
Το KRISTIE LOU V.
M MariBank
Acct. No.: 15521507144
Transfer Amount PHP 530.00
Transaction Number BC550000035337906037
Transaction Date & Time 24 Oct 2026, 13:41
Receipt generated from MariBank app`;
const bpi = `Transfer successful!
Saturday, Oct 24 2026; 01:41:43 PM (GMT +8)
Confirmation No. 1629711914030
Transaction Ref. No. 369548
Sent via BPI
Transfer to
MARIBANK PHILIPPINES INC. (A
RURAL BANK)
KRISTIE LOU V. (QR Code)
XXXXXXXX144
Transfer amount
PHP 530.00
Fee
PHP 0.00
Transfer from
SAVINGS ACCOUNT`;
const gotyme = `Transferred
P530.00
instaPay Instant
To KRISTIE L** V*
*******7144
MariBank Philippines (SeaBank)
From SAMPLE SENDER
********8013
GoTyme Bank
Amount P530.00
Fee P0.00
Total P530.00
Trace ID 927015
Reference No. ITO261024081927015
Date 24 Oct 2026 at 1:41 PM`;
function check(text: string) {
  const p = parseProviderReceipt("maribank_direct", text);
  if (p.provider !== "maribank_direct") throw Error("provider");
  return { p, e: verifyProviderReceipt(p, ctx) };
}
function ok(v: unknown, m = "assertion") {
  if (!v) throw Error(m);
}
for (
  const [name, text] of [["native downloaded", native], ["BPI", bpi], [
    "GoTyme",
    gotyme,
  ]]
) {
  Deno.test(
    name + " to MariBank validates observed receipt and native evidence",
    () => {
      const { p, e } = check(text);
      ok(e.flags.length === 0, JSON.stringify(e.flags));
      ok(
        maribankDirectApprovalConfidence(bankFixtureRead(text), p).confidence >=
          .9,
      );
      ok(e.dedupeKeys.length >= 1);
    },
  );
  Deno.test(
    name + " blocks wrong bank, account, amount, date and failed status",
    () => {
      for (
        const changed of [
          text.replaceAll("MariBank", "OtherBank").replaceAll(
            "MARIBANK",
            "OTHERBANK",
          ),
          text.replaceAll("7144", "9999").replace("XXXXXXXX144", "XXXXXXXX999"),
          text.replaceAll("530.00", "560.00"),
          text.replaceAll("24", "23"),
          text + "\nTransaction status: Reversed",
          text + "\nTransaction status: Pending",
        ]
      ) ok(check(changed).e.flags.length > 0, changed);
    },
  );
}
Deno.test("downloaded variant permits observed zero fee and total but rejects arithmetic conflict", () => {
  const withFee = native.replace(
    "Transaction Number",
    "Transfer Fee FREE\nTotal Amount PHP 530.00\nReference Number",
  );
  ok(check(withFee).e.flags.length === 0);
  ok(
    check(withFee.replace("Total Amount PHP 530.00", "Total Amount PHP 540.00"))
      .e.flags.length > 0,
  );
  ok(
    check(native.replace("Receipt generated from MariBank app", "")).e.flags
      .length > 0,
  );
});
Deno.test("short BPI suffix is exclusive to the full QR identity; no bare suffix or mismatched name", () => {
  ok(check(bpi.replace("XXXXXXXX144", "144")).e.flags.length > 0);
  ok(check(bpi.replace("KRISTIE LOU V.", "OTHER PERSON")).e.flags.length > 0);
  ok(check(bpi).e.dedupeKeys.some((k) => k.key === "bpi:1629711914030"));
  ok(check(bpi).e.dedupeKeys.some((k) => k.key === "bpi_transaction:369548"));
});
Deno.test("GoTyme preserves actual masks and needs complete reference, date and sender", () => {
  for (
    const changed of [
      gotyme.replace("KRISTIE", "OTHER"),
      gotyme.replace("*******7144", "*******9999"),
      gotyme.replace("Reference No. ITO261024081927015", ""),
      gotyme.replace("Date 24 Oct 2026 at 1:41 PM", ""),
      gotyme.replace("From SAMPLE SENDER", ""),
    ]
  ) ok(check(changed).e.flags.length > 0);
  ok(
    check(gotyme).e.dedupeKeys.some((k) =>
      k.key === "gotyme:ITO261024081927015"
    ),
  );
  ok(check(gotyme).e.dedupeKeys.some((k) => k.key === "instapay:927015"));
});
