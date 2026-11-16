const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const migration = fs.readFileSync('supabase/migrations/20261116120000_maribank_paid_to_gcash.sql', 'utf8');
const verifier = fs.readFileSync('supabase/functions/verify-gcash-receipt/index.ts', 'utf8');

test('settlement accepts GCash evidence for a MariBank booking only on its own named route', () => {
  // The alternate route is entered only for MariBank bookings with that exact route label,
  // and then demands the GCash parser and a GCash destination.
  assert.match(migration, /if provider_value = 'maribank'\s+and p_receipt_extracted->>'route' = 'maribank_paid_to_gcash' then\s+expected_route := 'maribank_paid_to_gcash';\s+expected_parser_version := 'gcash_v1';\s+expected_destination := 'gcash';/);
  // Every other provider keeps its previous destination rule.
  assert.match(migration, /expected_destination := case when provider_value in \('securitybank', 'maribank'\) then provider_value else 'gcash' end;/);
  // The booking must still be a MariBank booking recorded against MariBank before settlement.
  assert.match(migration, /lower\(trim\(coalesce\(b\.received_account, ''\)\)\) <> \(case when provider_value in \('securitybank', 'maribank'\) then provider_value else 'gcash' end\)/);
  // Only this route moves the received account to GCash.
  assert.match(migration, /received_account = case when expected_route = 'maribank_paid_to_gcash' then 'gcash' else b\.received_account end/);
  // The clean-evidence guard allows exactly the two MariBank routes.
  assert.match(migration, /\(p_extracted->>'route' = 'maribank_direct' and p_extracted->>'parserVersion' = 'maribank_direct_v1'\) or \(p_extracted->>'route' = 'maribank_paid_to_gcash' and p_extracted->>'parserVersion' = 'gcash_v1'\)/);
  assert.equal((migration.match(/maribank_paid_to_gcash/g) || []).length >= 5, true);
});

test('the verifier labels the route only when the GCash verifier read the receipt', () => {
  assert.match(verifier, /provider === "maribank" && receiptProvider === "gcash"\s+\? MARIBANK_PAID_TO_GCASH_ROUTE/);
  // The booking keeps its MariBank reference key, which settlement requires.
  assert.match(verifier, /if \(provider === "maribank" && receiptProvider === "gcash" && extractedRef\) \{\s+dedupeKeys\.push\(\{\s+key: `maribank:\$\{extractedRef\}`/);
  // GCash merchant expectations replace the MariBank ones for that check.
  assert.match(verifier, /const gcashMerchant = expectedMerchantForProvider\(settings, "gcash"\);/);
});
