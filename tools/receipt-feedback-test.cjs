#!/usr/bin/env node
/* Applies candidate telemetry DDL and synthetic audit fixtures in one transaction,
 * then ALWAYS rolls back. Never updates bookings or financial ledgers. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { localEnvironment } = require('./receipt-feedback-report.cjs');

async function main() {
  if (process.argv.slice(2).join(' ') !== '--rollback-live') throw new Error('Use --rollback-live to run the rollback-only CHINO database contract test.');
  const env = localEnvironment();
  if (!env.SUPABASE_DB_PASSWORD) throw new Error('SUPABASE_DB_PASSWORD is required.');
  const client = new Client({ host: 'db.wskzptxekldhsxluhgos.supabase.co', database: 'postgres', user: 'postgres', password: env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  let connected = false;
  try {
    await client.connect(); connected = true;
    await client.query('begin');
    await client.query("set local lock_timeout = '4s'");
    await client.query("set local statement_timeout = '30s'");
    for (const filename of ['20260910130000_receipt_feedback.sql', '20260910140000_bank_receipt_feedback.sql']) {
      const source = fs.readFileSync(path.join(__dirname, '../supabase/migrations', filename), 'utf8');
      if ((source.match(/^begin;$/gmi) || []).length !== 1 || (source.match(/^commit;$/gmi) || []).length !== 1) throw new Error('Unexpected migration transaction boundaries');
      await client.query(source.replace(/^begin;$/mi, '').replace(/^commit;$/mi, ''));
    }
    for (const filename of ['receipt_feedback.sql', 'bank_receipt_feedback.sql']) {
      await client.query(fs.readFileSync(path.join(__dirname, '../supabase/tests', filename), 'utf8'));
    }
    process.stdout.write('PASS: GCash and bank feedback security, provider/route/layout isolation, native-confidence gate, distinct-image threshold, fixed strategies, owner outcome separation, compatible reporting and failure isolation. All test changes rolled back.\n');
  } finally {
    if (connected) { await client.query('rollback'); await client.end(); }
  }
}
main().catch(error => { process.stderr.write(`Receipt feedback test failed (${error.code || 'test'}): ${error.message}\n`); process.exitCode = 1; });
