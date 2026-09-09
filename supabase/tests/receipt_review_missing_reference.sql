-- Exercise the deployed review function against isolated temporary fixtures.
-- No real booking, receipt audit, reference ledger, or notification is changed.
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table review_fixture_bookings (
  ref text primary key, booking_group_ref text, payment_method text,
  gcash_ref text, received_account text, status text, payment_status text,
  receipt_image_hash text, receipt_status text, receipt_image_url text,
  receipt_phash text, receipt_flags text[], receipt_extracted jsonb,
  receipt_confidence numeric, receipt_verified_at timestamptz
);
create temporary table review_fixture_leases (
  booking_key text primary key, claim_token uuid, lease_expires_at timestamptz
);
create temporary table review_fixture_audits (
  booking_ref text, result text, flags text[], extracted jsonb,
  confidence numeric, image_hash text, phash text, raw_ocr_text text
);

-- Only replace the three storage table names and the function name. Every
-- production input, reference, lease, group, hash and state check executes.
do $clone$
declare definition text;
begin
  select pg_get_functiondef(to_regprocedure(
    'public.finalize_digital_receipt_review(text,text[],text,uuid,text,text,text,text,text,text[],jsonb,numeric,timestamp with time zone,text)'
  )) into definition;
  if definition is null then raise exception 'Review finalizer missing'; end if;
  definition := replace(definition, 'public.finalize_digital_receipt_review(', 'pg_temp.review_fixture_finalize(');
  definition := replace(definition, 'public.bookings', 'pg_temp.review_fixture_bookings');
  definition := replace(definition, 'public.receipt_verification_leases', 'pg_temp.review_fixture_leases');
  definition := replace(definition, 'public.receipt_verifications', 'pg_temp.review_fixture_audits');
  execute definition;
end;
$clone$;

do $test$
declare
  scenario text;
  reference_value text;
  group_key text;
  evidence jsonb;
  token uuid := '00000000-0000-4000-8000-000000009209';
  blocked boolean;
  expected_block boolean;
begin
  foreach scenario in array array[
    'missing_reference', 'matching_saved_reference', 'lost_saved_reference',
    'changed_hash', 'changed_method', 'changed_group', 'stale_lease',
    'missing_reference_manual_mode', 'wrong_parser', 'non_service'
  ] loop
    truncate pg_temp.review_fixture_bookings, pg_temp.review_fixture_leases,
      pg_temp.review_fixture_audits;
    reference_value := case when scenario = 'matching_saved_reference' then '1234567890123' else '' end;
    group_key := case when scenario = 'changed_group' then 'REVIEW-TEST-GROUP' else 'REVIEW-TEST-ONE' end;
    evidence := jsonb_build_object(
      'provider', 'gcash', 'parserVersion', 'gcash_v1',
      'verifierVersion', 'receipt_evidence_v1', 'referenceInputMode', 'receipt_only',
      'ref', null, 'amount', 265,
      'verification', jsonb_build_object('decision', 'review', 'referenceMatch', false)
    );
    if scenario = 'missing_reference_manual_mode' then
      evidence := jsonb_set(evidence, '{referenceInputMode}', '"manual"');
    elsif scenario = 'wrong_parser' then
      evidence := jsonb_set(evidence, '{parserVersion}', '"gotyme_to_gcash_v1"');
    end if;

    insert into pg_temp.review_fixture_bookings (
      ref, booking_group_ref, payment_method, gcash_ref, received_account,
      status, payment_status, receipt_image_hash, receipt_status
    ) values (
      'REVIEW-TEST-ONE', case when scenario = 'changed_group' then group_key else null end,
      case when scenario = 'changed_method' then 'gotyme' else 'gcash' end,
      case when scenario in ('matching_saved_reference', 'lost_saved_reference') then '1234567890123' else null end,
      'gcash', 'pending', 'for_verification',
      repeat(case when scenario = 'changed_hash' then 'b' else 'a' end, 64), 'manual_review'
    );
    if scenario = 'changed_group' then
      insert into pg_temp.review_fixture_bookings select
        'REVIEW-TEST-TWO', booking_group_ref, payment_method, gcash_ref,
        received_account, status, payment_status, receipt_image_hash,
        receipt_status, receipt_image_url, receipt_phash, receipt_flags,
        receipt_extracted, receipt_confidence, receipt_verified_at
      from pg_temp.review_fixture_bookings where ref = 'REVIEW-TEST-ONE';
    end if;
    insert into pg_temp.review_fixture_leases values (
      group_key, token, clock_timestamp() +
      case when scenario = 'stale_lease' then interval '-1 minute' else interval '5 minutes' end
    );
    if scenario = 'non_service' then
      perform set_config('request.jwt.claim.role', 'anon', true);
      perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    end if;

    blocked := false;
    begin
      perform pg_temp.review_fixture_finalize(
        'REVIEW-TEST-ONE', array['REVIEW-TEST-ONE'], group_key, token,
        'gcash', reference_value, 'REVIEW-TEST-ONE/' || repeat('a', 64) || '.png',
        repeat('a', 64), null, array['REF_UNREADABLE'], evidence,
        0.5::numeric, clock_timestamp(), 'Synthetic unreadable reference'
      );
    exception when sqlstate '22023' or sqlstate '40001' or sqlstate '42501' then
      blocked := true;
    end;
    perform set_config('request.jwt.claim.role', 'service_role', true);
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    expected_block := scenario not in ('missing_reference', 'matching_saved_reference');
    if blocked is distinct from expected_block then
      raise exception 'Unexpected review outcome for %: blocked=%', scenario, blocked;
    end if;

    if not blocked then
      if not exists (
        select 1 from pg_temp.review_fixture_bookings
        where ref = 'REVIEW-TEST-ONE' and status = 'pending'
          and payment_status = 'for_verification' and receipt_status = 'manual_review'
          and receipt_extracted->>'workflowResult' = 'manual_review'
          and receipt_extracted->>'amount' = '265'
          and receipt_flags = array['REF_UNREADABLE']
          and receipt_verified_at is not null
          and gcash_ref is not distinct from nullif(reference_value, '')
      ) then raise exception 'Review evidence or payment state incorrect for %', scenario; end if;
      if (select count(*) from pg_temp.review_fixture_audits) <> 1
         or exists (select 1 from pg_temp.review_fixture_leases) then
        raise exception 'Review audit or lease finalization incorrect for %', scenario;
      end if;
    elsif exists (select 1 from pg_temp.review_fixture_audits) then
      raise exception 'Blocked review wrote audit evidence for %', scenario;
    end if;
  end loop;

  -- This review-only change must never turn an empty reference into a valid
  -- identifier for the separate automatic or owner-confirmation workflows.
  blocked := false;
  begin
    perform public.normalize_payment_reference_key('gcash', '');
  exception when sqlstate '22023' then blocked := true;
  end;
  if not blocked then raise exception 'Empty payment reference became confirmable'; end if;
end;
$test$;

rollback;
select 'Missing-reference review preserves diagnostics; saved reference, method, group, hash, lease and role guards passed; fixtures rolled back' as result;
