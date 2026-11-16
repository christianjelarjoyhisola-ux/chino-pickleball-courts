-- Owner policy (2026-11-16): a MariBank booking paid from the GCash app to the
-- court's own configured GCash account may auto-approve through one dedicated
-- route, "maribank_paid_to_gcash", using GCash-verifier evidence (gcash_v1)
-- with a GCash destination. All other settlement checks are unchanged. On
-- settlement the booking's received account becomes GCash so finance reports
-- follow the money. MariBank-app-to-GCash screens are not eligible.
begin;

CREATE OR REPLACE FUNCTION public.finalize_digital_receipt_auto_approval(p_booking_ref text, p_booking_refs text[], p_lease_key text, p_lease_token uuid, p_provider text, p_payment_reference text, p_payment_status text, p_receipt_image_url text, p_receipt_image_hash text, p_receipt_phash text, p_receipt_flags text[], p_receipt_extracted jsonb, p_receipt_confidence numeric, p_receipt_verified_at timestamp with time zone, p_raw_ocr_text text)
 RETURNS TABLE(booking_ref text, booking_status text, booking_payment_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  provider_value text := lower(trim(coalesce(p_provider, '')));
  expected_route text;
  expected_parser_version text;
  expected_destination text;
  normalized_reference text;
  extracted_reference text;
  target_booking public.bookings%rowtype;
  lease_row public.receipt_verification_leases%rowtype;
  actual_refs text[];
  expected_refs text[];
  observed_group_ref text;
  logical_booking_key text;
  invalid_rows integer;
  updated_count integer;
  non_host_rows integer;
  paid_amount numeric;
  expected_total numeric;
  expected_due numeric;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the receipt verification service may auto-approve a payment.'
      using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_booking_ref, '')), '') is null then
    raise exception 'Booking reference is required.' using errcode = '22023';
  end if;
  if provider_value not in ('gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'securitybank') then
    raise exception 'This provider does not have an approved automatic verifier.'
      using errcode = '22023';
  end if;
  if not public.public_payment_method_ready(provider_value) then
    raise exception 'This payment method is not currently enabled.'
      using errcode = '23514';
  end if;
  if coalesce(p_receipt_image_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid checkpoint image hash is required.'
      using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_receipt_image_url, '')), '') is null then
    raise exception 'A private receipt image path is required.'
      using errcode = '22023';
  end if;
  if p_payment_status not in ('paid', 'downpayment_paid') then
    raise exception 'Invalid automatic payment status.' using errcode = '22023';
  end if;
  if cardinality(coalesce(p_receipt_flags, array[]::text[])) <> 0 then
    raise exception 'Flagged receipt evidence requires manual review.'
      using errcode = '22023';
  end if;
  if p_receipt_confidence is null
     or p_receipt_confidence < 0.90
     or p_receipt_confidence > 1 then
    raise exception 'High-confidence receipt evidence is required.'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_receipt_extracted) <> 'object' then
    raise exception 'Structured receipt evidence is required.'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_receipt_extracted->'dedupeKeys') <> 'array'
     or jsonb_array_length(p_receipt_extracted->'dedupeKeys') = 0 then
    raise exception 'Clean receipt evidence must include dedupeKeys.'
      using errcode = '22023';
  end if;

  expected_route := case provider_value
    when 'gcash' then 'gcash'
    when 'bdopay' then 'bdopay_to_gcash'
    when 'maya' then 'maya_to_gcash'
    when 'securitybank' then 'gcash_to_securitybank' when 'bpi' then 'bpi_to_gcash'
    when 'gotyme' then 'gotyme_to_gcash'
    when 'maribank' then 'maribank_direct'
  end;
  expected_parser_version := case provider_value
    when 'gcash' then 'gcash_v1'
    when 'bdopay' then 'bdopay_to_gcash_v1'
    when 'maya' then 'maya_to_gcash_v1'
    when 'securitybank' then 'gcash_to_securitybank_v1' when 'bpi' then 'bpi_to_gcash_v1'
    when 'gotyme' then 'gotyme_to_gcash_v1'
    when 'maribank' then 'maribank_direct_v1'
  end;
  expected_destination := case when provider_value in ('securitybank', 'maribank') then provider_value else 'gcash' end;
  -- Owner policy (2026-11-16): a MariBank booking paid from the GCash app to
  -- the court's own configured GCash account settles only through this
  -- route, with GCash-verifier evidence and a GCash destination. Every other
  -- check below still applies, and the booking must still be a MariBank one.
  if provider_value = 'maribank'
     and p_receipt_extracted->>'route' = 'maribank_paid_to_gcash' then
    expected_route := 'maribank_paid_to_gcash';
    expected_parser_version := 'gcash_v1';
    expected_destination := 'gcash';
  end if;
  if lower(coalesce(p_receipt_extracted->>'provider', '')) <> provider_value
     or coalesce(p_receipt_extracted->>'parserVersion', '') <>
          expected_parser_version
     or coalesce(p_receipt_extracted->>'verifierVersion', '') <>
          'receipt_evidence_v1'
     or lower(coalesce(p_receipt_extracted->>'route', '')) <> expected_route
     or lower(coalesce(
       p_receipt_extracted#>>'{verification,decision}',
       ''
     )) <> 'valid'
     or coalesce(
       p_receipt_extracted#>>'{verification,sourceProviderMatch}',
       ''
     ) <> 'true'
     or coalesce(
       p_receipt_extracted#>>'{verification,referenceMatch}',
       ''
     ) <> 'true'
     or coalesce(
       p_receipt_extracted#>>'{verification,amountMatch}',
       ''
     ) <> 'true'
     or coalesce(
       p_receipt_extracted#>>'{verification,timestampValid}',
       ''
     ) <> 'true'
     or coalesce(
       p_receipt_extracted#>>'{verification,recipientMatch}',
       ''
     ) <> 'true'
     or coalesce(
       p_receipt_extracted#>>'{verification,duplicateClear}',
       ''
     ) <> 'true'
     or lower(coalesce(
       p_receipt_extracted#>>'{verification,destinationProvider}',
       ''
     )) <> expected_destination then
    raise exception 'Receipt verifier evidence is incomplete or requires review.'
      using errcode = '22023';
  end if;
  if coalesce(p_receipt_extracted->>'autoPaymentStatus', '') <>
       p_payment_status then
    raise exception 'Automatic payment classification changed.'
      using errcode = '22023';
  end if;
  if coalesce(p_receipt_extracted->>'amount', '')
       !~ '^[0-9]+([.][0-9]+)?$' then
    raise exception 'A reliable parsed receipt amount is required.'
      using errcode = '22023';
  end if;
  if coalesce(p_receipt_extracted->>'receiptAgeMinutes', '')
       !~ '^-?[0-9]+([.][0-9]+)?$'
     or (p_receipt_extracted->>'receiptAgeMinutes')::numeric < -2
     or (p_receipt_extracted->>'receiptAgeMinutes')::numeric > 15 then
    raise exception 'Receipt timestamp is outside the payment window.'
      using errcode = '22023';
  end if;

  normalized_reference := public.normalize_payment_reference_key(
    provider_value,
    p_payment_reference
  );
  extracted_reference := public.normalize_payment_reference_key(
    provider_value,
    p_receipt_extracted->>'ref'
  );
  if extracted_reference is distinct from normalized_reference then
    raise exception 'Parsed and submitted payment references do not match.'
      using errcode = '22023';
  end if;
  paid_amount := (p_receipt_extracted->>'amount')::numeric;

  select nullif(trim(coalesce(b.booking_group_ref, '')), '')
    into observed_group_ref
    from public.bookings b
   where b.ref = p_booking_ref;
  if not found then
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;

  logical_booking_key := coalesce(observed_group_ref, p_booking_ref);
  if trim(coalesce(p_lease_key, '')) <> logical_booking_key then
    raise exception 'Receipt verification lease does not match this booking.'
      using errcode = '40001';
  end if;

  if observed_group_ref is not null then
    perform pg_advisory_xact_lock(
      hashtextextended(
        'paddle-rage-public-booking-group:' || observed_group_ref,
        0
      )
    );
  end if;

  select leases.*
    into lease_row
    from public.receipt_verification_leases leases
   where leases.booking_key = logical_booking_key
   for update;
  if not found
     or lease_row.claim_token is distinct from p_lease_token
     or lease_row.lease_expires_at <= clock_timestamp() then
    raise exception 'Receipt verification lease is stale.'
      using errcode = '40001';
  end if;

  if observed_group_ref is null then
    select b.*
      into target_booking
      from public.bookings b
     where b.ref = p_booking_ref
     for update;
    if not found
       or nullif(trim(coalesce(target_booking.booking_group_ref, '')), '')
         is not null then
      raise exception 'Booking scope changed during receipt verification.'
        using errcode = '40001';
    end if;
    actual_refs := array[p_booking_ref];
  else
    perform 1
      from public.bookings b
     where b.booking_group_ref = observed_group_ref
     order by b.ref
     for update;

    select b.*
      into target_booking
      from public.bookings b
     where b.ref = p_booking_ref;
    if not found
       or nullif(trim(coalesce(target_booking.booking_group_ref, '')), '')
         is distinct from observed_group_ref then
      raise exception 'Booking scope changed during receipt verification.'
        using errcode = '40001';
    end if;

    select array_agg(b.ref order by b.ref)
      into actual_refs
      from public.bookings b
     where b.booking_group_ref = observed_group_ref;
  end if;

  select array_agg(candidate order by candidate)
    into expected_refs
    from (
      select distinct unnest(coalesce(p_booking_refs, array[]::text[])) candidate
    ) refs;

  if actual_refs is null
     or expected_refs is null
     or actual_refs is distinct from expected_refs
     or not (p_booking_ref = any(actual_refs)) then
    raise exception 'Booking group changed during receipt verification.'
      using errcode = '40001';
  end if;

  select
    count(*) filter (
      where lower(trim(coalesce(b.payment_method, ''))) <> provider_value
         or (nullif(trim(coalesce(b.gcash_ref, '')), '') is not null
             and public.normalize_payment_reference_key(provider_value, b.gcash_ref) <> normalized_reference)
         or (nullif(trim(coalesce(b.gcash_ref, '')), '') is null
             and coalesce(p_receipt_extracted->>'referenceInputMode', '') <> 'receipt_only')
         or lower(trim(coalesce(b.received_account, ''))) <> (case when provider_value in ('securitybank', 'maribank') then provider_value else 'gcash' end)
         or b.status not in ('verifying', 'pending')
         or b.payment_status not in ('unpaid', 'pending', 'for_verification')
         or b.total is null
         or b.total <= 0
         or b.downpayment is null
         or b.downpayment <= 0
         or b.downpayment > b.total + 0.01
         or b.receipt_image_hash is distinct from p_receipt_image_hash
         or b.receipt_status <> 'manual_review'
    ),
    count(*) filter (where b.host_booking is distinct from true),
    round(coalesce(sum(b.total), 0)::numeric, 2),
    round(coalesce(sum(b.downpayment), 0)::numeric, 2)
    into invalid_rows, non_host_rows, expected_total, expected_due
    from public.bookings b
   where b.ref = any(actual_refs);

  if invalid_rows <> 0 then
    raise exception 'Booking payment state changed during receipt verification.'
      using errcode = '40001';
  end if;
  if expected_total <= 0
     or expected_due <= 0
     or expected_due > expected_total + 0.01 then
    raise exception 'Stored booking payment amounts require manual review.'
      using errcode = '22023';
  end if;

  if p_payment_status = 'paid' then
    if abs(expected_due - expected_total) > 0.01
       or abs(paid_amount - expected_total) > 0.01 then
      raise exception 'Parsed amount does not match the full booking total.'
        using errcode = '22023';
    end if;
  else
    if non_host_rows <> 0
       or expected_due >= expected_total - 0.01
       or abs(paid_amount - expected_due) > 0.01 then
      raise exception 'Parsed amount does not match the host amount due.'
        using errcode = '22023';
    end if;
  end if;

  if exists (
    select 1
      from public.bookings other_booking
     where not (other_booking.ref = any(actual_refs))
       and lower(trim(coalesce(other_booking.payment_method, ''))) =
           provider_value
       and nullif(trim(coalesce(other_booking.gcash_ref, '')), '') is not null
       and public.normalize_payment_reference_key(
             provider_value,
             other_booking.gcash_ref
           ) = normalized_reference
  ) then
    raise exception 'This payment reference is attached to another booking.'
      using errcode = '23505';
  end if;

  perform public.claim_verified_receipt_evidence_keys(
    p_receipt_extracted,
    provider_value,
    p_payment_reference,
    case when observed_group_ref is null then 'booking' else 'booking_group' end,
    logical_booking_key,
    p_booking_ref
  );

  update public.bookings b
     set status = 'confirmed',
         payment_status = p_payment_status,
         paid_at = coalesce(p_receipt_verified_at, clock_timestamp()),
         gcash_ref = coalesce(nullif(trim(b.gcash_ref), ''), nullif(trim(p_payment_reference), '')),
         receipt_image_url = p_receipt_image_url,
         receipt_image_hash = p_receipt_image_hash,
         receipt_phash = p_receipt_phash,
         receipt_status = 'auto_approved',
         -- The money arrived in GCash; finance reports follow the account.
         received_account = case when expected_route = 'maribank_paid_to_gcash' then 'gcash' else b.received_account end,
         receipt_flags = array[]::text[],
         receipt_extracted = p_receipt_extracted,
         receipt_confidence = p_receipt_confidence,
         receipt_verified_at =
           coalesce(p_receipt_verified_at, clock_timestamp())
   where b.ref = any(actual_refs);

  get diagnostics updated_count = row_count;
  if updated_count <> cardinality(actual_refs) then
    raise exception 'Automatic settlement did not update the complete booking group.'
      using errcode = '40001';
  end if;

  insert into public.receipt_verifications (
    booking_ref,
    result,
    flags,
    extracted,
    confidence,
    image_hash,
    phash,
    raw_ocr_text
  ) values (
    p_booking_ref,
    'auto_approved',
    array[]::text[],
    p_receipt_extracted,
    p_receipt_confidence,
    p_receipt_image_hash,
    p_receipt_phash,
    p_raw_ocr_text
  );

  delete from public.receipt_verification_leases leases
   where leases.booking_key = logical_booking_key
     and leases.claim_token = p_lease_token;
  if not found then
    raise exception 'Receipt verification lease changed before commit.'
      using errcode = '40001';
  end if;

  return query
  select b.ref, b.status, b.payment_status
    from public.bookings b
   where b.ref = any(actual_refs)
   order by b.ref;
end;
$function$;

CREATE OR REPLACE FUNCTION public.receipt_auto_approval_evidence_is_clean(p_result text, p_flags text[], p_confidence numeric, p_extracted jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select
    lower(trim(coalesce(p_result, ''))) = 'auto_approved'
    and cardinality(coalesce(p_flags, array[]::text[])) = 0
    and p_confidence is not null
    and p_confidence >= 0.90
    and p_confidence <= 1
    and jsonb_typeof(p_extracted) = 'object'
    and lower(coalesce(
      p_extracted#>>'{verification,decision}',
      ''
    )) = 'valid'
    and coalesce(
      p_extracted#>>'{verification,sourceProviderMatch}',
      ''
    ) = 'true'
    and coalesce(
      p_extracted#>>'{verification,referenceMatch}',
      ''
    ) = 'true'
    and coalesce(
      p_extracted#>>'{verification,amountMatch}',
      ''
    ) = 'true'
    and coalesce(
      p_extracted#>>'{verification,timestampValid}',
      ''
    ) = 'true'
    and coalesce(
      p_extracted#>>'{verification,recipientMatch}',
      ''
    ) = 'true'
    and coalesce(
      p_extracted#>>'{verification,duplicateClear}',
      ''
    ) = 'true'
    and lower(coalesce(
      p_extracted#>>'{verification,destinationProvider}',
      ''
    )) = (case when lower(coalesce(p_extracted->>'provider','')) = 'maribank' and p_extracted->>'route' = 'maribank_paid_to_gcash' then 'gcash' when lower(coalesce(p_extracted->>'provider','')) in ('securitybank','maribank') then lower(p_extracted->>'provider') else 'gcash' end)
    and (lower(coalesce(p_extracted->>'provider','')) <> 'maribank' or (p_extracted->>'route' = 'maribank_direct' and p_extracted->>'parserVersion' = 'maribank_direct_v1') or (p_extracted->>'route' = 'maribank_paid_to_gcash' and p_extracted->>'parserVersion' = 'gcash_v1')) and (lower(coalesce(p_extracted->>'provider','')) <> 'securitybank' or (
      p_extracted->>'route' = 'gcash_to_securitybank' and
      p_extracted->>'parserVersion' = 'gcash_to_securitybank_v1'
    ));
$function$;

CREATE OR REPLACE FUNCTION public.receipt_feedback_destination(p_evidence jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare expected text; parser text; route text;
begin
  select d,p,r into expected,parser,route from (values
    ('gcash','gcash','gcash_v1',null::text),
    ('maya','gcash','maya_to_gcash_v1','maya_to_gcash'),
    ('bdopay','gcash','bdopay_to_gcash_v1','bdopay_to_gcash'),
    ('bpi','gcash','bpi_to_gcash_v1','bpi_to_gcash'),
    ('gotyme','gcash','gotyme_to_gcash_v1','gotyme_to_gcash'),
    ('maribank','gcash','maribank_to_gcash_v1','maribank_to_gcash'), ('maribank','maribank','maribank_direct_v1','maribank_direct'), ('maribank','gcash','gcash_v1','maribank_paid_to_gcash'),
    ('securitybank','securitybank','gcash_to_securitybank_v1','gcash_to_securitybank')
  ) known(provider,d,p,r) where provider=p_evidence->>'provider' and p=p_evidence->>'parserVersion';
  if expected is null or p_evidence->>'parserVersion' is distinct from parser
     or p_evidence#>>'{verification,destinationProvider}' is distinct from expected
     or (p_evidence ? 'destinationProvider' and p_evidence->>'destinationProvider' is distinct from expected)
     or (route is not null and p_evidence->>'route' is distinct from route) then return 'unknown'; end if;
  return expected;
end $function$;

commit;
