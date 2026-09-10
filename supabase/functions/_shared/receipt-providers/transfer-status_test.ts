import { readReceiptTransferStatus } from "./transfer-status.ts";

const INCOMPLETE_RECEIPT_STATUSES = [
  ["Pending", "TRANSFER_PENDING"],
  ["Processing", "TRANSFER_PENDING"],
  ["In progress", "TRANSFER_PENDING"],
  ["Scheduled", "TRANSFER_PENDING"],
  ["Queued", "TRANSFER_PENDING"],
  ["On hold", "TRANSFER_PENDING"],
  ["Awaiting confirmation", "TRANSFER_PENDING"],
  ["Failed", "TRANSFER_STATUS_INVALID"],
  ["Failure", "TRANSFER_STATUS_INVALID"],
  ["Declined", "TRANSFER_STATUS_INVALID"],
  ["Rejected", "TRANSFER_STATUS_INVALID"],
  ["Cancelled", "TRANSFER_STATUS_INVALID"],
  ["Canceled", "TRANSFER_STATUS_INVALID"],
  ["Unsuccessful", "TRANSFER_STATUS_INVALID"],
  ["Reversed", "TRANSFER_STATUS_INVALID"],
  ["Refunded", "TRANSFER_STATUS_INVALID"],
  ["Not completed", "TRANSFER_STATUS_INVALID"],
  ["Not successful", "TRANSFER_STATUS_INVALID"],
] as const;

Deno.test("adverse transaction statuses cannot be overridden by positive copy", () => {
  for (const [label, flag] of INCOMPLETE_RECEIPT_STATUSES) {
    const status = readReceiptTransferStatus(
      `Transfer successful!\nStatus: ${label}`,
    );
    if (
      flag === "TRANSFER_PENDING"
        ? !status.pendingStatus
        : !status.failureStatus
    ) {
      throw new Error(`Adverse status was ignored: ${label}`);
    }
  }
});

Deno.test("processing metadata does not claim a transfer is still processing", () => {
  for (
    const label of [
      "Processing time\nInstant",
      "Processing time: Instant",
      "Processing fee 0.00",
    ]
  ) {
    const status = readReceiptTransferStatus(`Transferred\n${label}`);
    if (status.pendingStatus || status.failureStatus) {
      throw new Error(`Metadata treated as status: ${label}`);
    }
  }
  if (!readReceiptTransferStatus("Processing time\nPending").pendingStatus) {
    throw new Error("Metadata label must not hide a separate pending status");
  }
});
