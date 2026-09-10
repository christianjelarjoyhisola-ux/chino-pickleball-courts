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

function parseReportOptions(args) {
  if (args.some(arg => !/^--(?:days|provider|destination|layout|revision|labels-file)=/.test(arg))) throw new Error('Usage: node tools/receipt-feedback-report.cjs [--days=30] [--provider=maya --destination=gcash --layout=maya_sent_money_v1 --revision=bank_adaptive_20260910] [--labels-file=private-labels.json]');
  const options = {};
  for (const arg of args) {
    const i = arg.indexOf('='); const key = arg.slice(2, i); const value = arg.slice(i + 1);
    if (!value.trim() || Object.hasOwn(options, key)) throw new Error(`Supply ${key} once with a nonempty value`);
    options[key] = value;
  }
  const days = Number(options.days || '30');
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('days must be an integer from 1 to 365');
  if (Boolean(options.layout) !== Boolean(options.revision)) throw new Error('Supply both layout and revision to inspect a preferred strategy');
  if (Boolean(options.provider) !== Boolean(options.destination) || (options.provider && !options.layout)) throw new Error('Supply provider, destination, layout and revision together');
  if (options.provider && !['gcash', 'maya', 'bdopay', 'bpi', 'gotyme', 'maribank', 'securitybank'].includes(options.provider)) throw new Error('Unsupported feedback provider');
  if (options.destination && !['gcash', 'securitybank'].includes(options.destination)) throw new Error('Unsupported receiving route');
  for (const key of ['layout', 'revision']) {
    if (options[key] && (options[key].length > 100 || !/^[a-zA-Z0-9_-]+$/.test(options[key]))) throw new Error(`${key} must be a supported identifier of at most 100 characters`);
  }
  return { ...options, days };
}

async function main() {
  const options = parseReportOptions(process.argv.slice(2));
  const env = localEnvironment();
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required in the environment or .env.local');
  const supabase = createClient('https://wskzptxekldhsxluhgos.supabase.co', env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const report = await supabase.rpc('receipt_feedback_report', { p_days: options.days });
  if (report.error) throw new Error(`Receipt report unavailable (${report.error.code || 'unknown code'}).`);
  const output = { report: report.data };
  if (options.layout) {
    const preference = options.provider
      ? await supabase.rpc('receipt_preferred_provider_reading_strategy', { p_provider: options.provider, p_destination_provider: options.destination, p_layout: options.layout, p_parser_revision: options.revision })
      : await supabase.rpc('receipt_preferred_reading_strategy', { p_layout: options.layout, p_parser_revision: options.revision });
    if (preference.error) throw new Error(`Receipt strategy report unavailable (${preference.error.code || 'unknown code'}).`);
    output.preference = preference.data;
  }
  if (options['labels-file']) {
    const labels = validateLabels(JSON.parse(fs.readFileSync(path.resolve(options['labels-file']), 'utf8')));
    const events = [];
    // One latest analysis per independently labeled hash. Booking decisions do
    // not affect offline correctness. Optional provider/route/revision/layout
    // scopes apply; GCash without explicit provider preserves legacy usage.
    for (const label of labels) {
      let query = supabase.from('receipt_feedback_events')
        .select('id,receipt_image_hash,booking_ref,event_type,outcome,created_at')
        .eq('event_type', 'analysis').eq('receipt_image_hash', label.receiptImageHash)
        .eq('booking_ref', label.bookingRef)
        .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1);
      if (options.revision) query = query.eq('parser_revision', options.revision).eq('layout', options.layout);
      if (options.provider) {
        query = query.eq('provider', options.provider);
        query = options.provider === 'gcash' && options.destination === 'gcash' && options.layout === 'gcash_express_send'
          ? query.in('destination_provider', ['gcash', 'unknown'])
          : query.eq('destination_provider', options.destination);
      }
      const result = await query;
      if (result.error) throw new Error(`Independent label evaluation unavailable (${result.error.code || 'unknown code'}).`);
      events.push(...(result.data || []));
    }
    output.independentEvaluation = evaluateLabels(labels, events);
  }
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}
if (require.main === module) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
module.exports = { localEnvironment, parseReportOptions };
