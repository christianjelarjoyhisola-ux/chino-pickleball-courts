#!/usr/bin/env node
/* Read-only aggregate reporting. Never prints credentials or receipt identities. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const { validateLabels, evaluateLabels } = require('./receipt-feedback-evaluate.cjs');

function localEnvironment() {
  const file = path.join(__dirname, '..', '.env.local');
  const values = fs.existsSync(file) ? Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .filter(line => line.trim() && !line.trim().startsWith('#') && line.includes('='))
    .map(line => { const i = line.indexOf('='); return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2')]; })) : {};
  const env = { ...process.env, ...values };
  for (const key of ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL']) {
    if (env[key] && env[key].replace(/\/$/, '') !== 'https://wskzptxekldhsxluhgos.supabase.co') throw new Error(`${key} does not match the CHINO project.`);
  }
  for (const key of ['SUPABASE_PROJECT_REF', 'SUPABASE_PROJECT_ID']) {
    if (env[key] && env[key] !== 'wskzptxekldhsxluhgos') throw new Error(`${key} does not match the CHINO project.`);
  }
  return env;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !/^--(?:days|layout|revision|labels-file)=/.test(arg))) throw new Error('Usage: node tools/receipt-feedback-report.cjs [--days=30] [--layout=gcash_express_send --revision=gcash_adaptive_20260910] [--labels-file=private-labels.json]');
  const options = Object.fromEntries(args.map(arg => { const i = arg.indexOf('='); return [arg.slice(2, i), arg.slice(i + 1)]; }));
  const days = Number(options.days || '30');
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('days must be an integer from 1 to 365');
  if (Boolean(options.layout) !== Boolean(options.revision)) throw new Error('Supply both layout and revision to inspect a preferred strategy');
  const env = localEnvironment();
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required in the environment or .env.local');
  const supabase = createClient('https://wskzptxekldhsxluhgos.supabase.co', env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const report = await supabase.rpc('receipt_feedback_report', { p_days: days });
  if (report.error) throw new Error(`Receipt report unavailable (${report.error.code || 'unknown code'}).`);
  const output = { report: report.data };
  if (options.layout) {
    const preference = await supabase.rpc('receipt_preferred_reading_strategy', { p_layout: options.layout, p_parser_revision: options.revision });
    if (preference.error) throw new Error(`Receipt strategy report unavailable (${preference.error.code || 'unknown code'}).`);
    output.preference = preference.data;
  }
  if (options['labels-file']) {
    const labels = validateLabels(JSON.parse(fs.readFileSync(path.resolve(options['labels-file']), 'utf8')));
    const events = [];
    // One latest analysis per independently labeled hash. Booking decisions do
    // not affect offline correctness. Optional revision/layout scopes apply.
    for (const label of labels) {
      let query = supabase.from('receipt_feedback_events')
        .select('id,receipt_image_hash,booking_ref,event_type,outcome,created_at')
        .eq('event_type', 'analysis').eq('receipt_image_hash', label.receiptImageHash)
        .eq('booking_ref', label.bookingRef)
        .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1);
      if (options.revision) query = query.eq('parser_revision', options.revision).eq('layout', options.layout);
      const result = await query;
      if (result.error) throw new Error(`Independent label evaluation unavailable (${result.error.code || 'unknown code'}).`);
      events.push(...(result.data || []));
    }
    output.independentEvaluation = evaluateLabels(labels, events);
  }
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}
if (require.main === module) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
module.exports = { localEnvironment };
