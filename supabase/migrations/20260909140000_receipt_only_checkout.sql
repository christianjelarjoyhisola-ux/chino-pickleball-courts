-- Receipt-only court checkout and a ten-minute temporary slot hold.
begin;
do $$ begin
 if public.chino_project_url() <> 'https://wskzptxekldhsxluhgos.supabase.co' then raise exception 'CHINO project guard failed'; end if;
end $$;

CREATE OR REPLACE FUNCTION public.guard_public_booking_hold_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  request_role text := coalesce(auth.role(), nullif(current_setting('request.jwt.claim.role', true), ''));
  account_role text := public.current_account_role();
  service_fee numeric := 0;
  public_due numeric := 0;
  host_due numeric := 0;
begin
  if request_role = 'anon'
     or (request_role = 'authenticated' and account_role = 'host') then
    if new.ref is distinct from old.ref
      or new.booking_group_ref is distinct from old.booking_group_ref
      or new.court_id is distinct from old.court_id
      or new.court_name is distinct from old.court_name
      or new.date is distinct from old.date
      or new.slots is distinct from old.slots
      or new.start_time is distinct from old.start_time
      or new.end_time is distinct from old.end_time
      or new.duration is distinct from old.duration
      or new.rate is distinct from old.rate
      or new.total is distinct from old.total
      or new.created_at is distinct from old.created_at
      or new.host_booking is distinct from old.host_booking
      or new.host_user_id is distinct from old.host_user_id
      or new.host_name is distinct from old.host_name
      or new.host_email is distinct from old.host_email
      or new.created_via is distinct from old.created_via
      or new.created_by_user_id is distinct from old.created_by_user_id
      or new.created_by_role is distinct from old.created_by_role
      or new.created_by_name is distinct from old.created_by_name
      or new.created_by_email is distinct from old.created_by_email
      or new.payment_provider is distinct from old.payment_provider
      or new.payment_session_id is distinct from old.payment_session_id
      or new.payment_checkout_url is distinct from old.payment_checkout_url
      or new.paid_at is distinct from old.paid_at
      or new.receipt_image_url is distinct from old.receipt_image_url
      or new.receipt_image_hash is distinct from old.receipt_image_hash
      or new.receipt_phash is distinct from old.receipt_phash
      or new.receipt_status is distinct from old.receipt_status
      or new.receipt_flags is distinct from old.receipt_flags
      or new.receipt_extracted is distinct from old.receipt_extracted
      or new.receipt_confidence is distinct from old.receipt_confidence
      or new.receipt_verified_at is distinct from old.receipt_verified_at
      or new.billed_at is distinct from old.billed_at
      or new.weekly_fee_id is distinct from old.weekly_fee_id
      or new.confirmation_email_id is distinct from old.confirmation_email_id
      or new.confirmation_email_sent_at is distinct from old.confirmation_email_sent_at
      or new.confirmation_email_last_event is distinct from old.confirmation_email_last_event then
      raise exception 'Reservation identity, slot, price, and ownership cannot be changed after a hold is created.';
    end if;

    if new.payment_status not in ('unpaid', 'pending', 'for_verification', 'rejected') then
      raise exception 'Reservation payment status cannot be approved by the booking client.';
    end if;
  end if;

  if request_role = 'anon' then
    if coalesce(old.host_booking, false)
      or old.host_user_id is not null
      or old.created_via <> 'customer'
      or old.created_by_user_id is not null then
      raise exception 'Anonymous clients may only finalize public customer holds.';
    end if;

    if new.downpayment is not null then
      if old.total is null or old.total < 0 then
        raise exception 'Reservation payment amount is invalid.';
      end if;
      service_fee := least(
        greatest(coalesce(old.booking_fee_amount_snapshot, 0), 0),
        old.total
      );
      public_due := round(service_fee + ((old.total - service_fee) * 0.50), 2);
      if abs(new.downpayment - old.total) > 0.01
         and abs(new.downpayment - public_due) > 0.01
         -- Grandfather an in-flight/cached checkout opened before this deploy.
         and abs(new.downpayment - (old.total / 2)) > 0.01
         and abs(new.downpayment - round(old.total / 2)) > 0.01 then
        raise exception 'Reservation payment amount is invalid. Expected 50%% of the court fee plus the full service fee.';
      end if;
    end if;
  elsif request_role = 'authenticated' and account_role = 'host' then
    if old.status <> 'verifying'
      or old.created_at is null
      or old.created_at <= now() - interval '10 minutes'
      or not coalesce(old.host_booking, false)
      or old.host_user_id is distinct from auth.uid()
      or old.created_via <> 'host'
      or old.created_by_user_id is distinct from auth.uid()
      or old.created_by_role <> 'host' then
      raise exception 'Hosts may only finalize their own active booking holds.';
    end if;

    if new.status not in ('verifying', 'pending', 'cancelled') then
      raise exception 'Host booking hold status transition is invalid.';
    end if;

    if new.status = 'pending' and new.downpayment is null then
      raise exception 'A finalized host booking must store its payment amount.';
    end if;

    if new.downpayment is not null then
      if old.total is null or old.total < 0 then
        raise exception 'Host booking total is invalid.';
      end if;
      service_fee := least(
        greatest(coalesce(old.booking_fee_amount_snapshot, 0), 0),
        old.total
      );
      host_due := round(service_fee + ((old.total - service_fee) * 0.25), 2);
      if abs(new.downpayment - old.total) > 0.01
         and abs(new.downpayment - host_due) > 0.01 then
        raise exception 'Host payment amount is invalid. Expected 25%% of the court fee plus the full service fee.';
      end if;
    end if;
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.update_public_booking_hold(p_ref text, p_access_token text, p_updates jsonb)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  target public.bookings%rowtype;
  requested_key text;
  token_hash text;
  requested_downpayment numeric;
  effective_payment_method text;
begin
  if coalesce(auth.role(), nullif(current_setting('request.jwt.claim.role', true), '')) <> 'anon' then
    raise exception 'This endpoint is only for anonymous customer holds.' using errcode = '42501';
  end if;

  if jsonb_typeof(coalesce(p_updates, '{}'::jsonb)) <> 'object' then
    raise exception 'Booking updates must be a JSON object.' using errcode = '22023';
  end if;

  if length(coalesce(p_access_token, '')) < 32
     or length(coalesce(p_access_token, '')) > 256 then
    raise exception 'Booking access token is invalid.' using errcode = '42501';
  end if;

  for requested_key in
    select jsonb_object_keys(coalesce(p_updates, '{}'::jsonb))
  loop
    if requested_key <> all(array[
      'full_name',
      'contact_number',
      'email',
      'payment_method',
      'payment_flow',
      'gcash_ref',
      'downpayment',
      'payment_status',
      'status'
    ]) then
      raise exception 'Booking field % cannot be updated by a public client.', requested_key
        using errcode = '42501';
    end if;
  end loop;

  token_hash := encode(extensions.digest(p_access_token, 'sha256'), 'hex');

  select b.*
    into target
    from public.bookings b
   where b.ref = trim(coalesce(p_ref, ''))
   for update;

  if not found
     or target.customer_access_token_hash is null
     or target.customer_access_token_hash <> token_hash then
    raise exception 'Booking hold was not found or the access token is invalid.' using errcode = '42501';
  end if;

  if target.status <> 'verifying'
     or target.created_at is null
     or target.created_at <= now() - interval '10 minutes'
     or coalesce(target.host_booking, false)
     or target.host_user_id is not null
     or target.created_via <> 'customer'
     or target.created_by_user_id is not null then
    raise exception 'Booking hold has expired or cannot be changed by this client.' using errcode = '42501';
  end if;

  if p_updates ? 'full_name' and (
    nullif(trim(coalesce(p_updates->>'full_name', '')), '') is null
    or length(trim(p_updates->>'full_name')) > 150
  ) then
    raise exception 'A valid customer name is required.' using errcode = '22023';
  end if;

  if length(coalesce(p_updates->>'contact_number', '')) > 40
     or length(coalesce(p_updates->>'email', '')) > 254
     or length(coalesce(p_updates->>'gcash_ref', '')) > 100 then
    raise exception 'Booking contact or payment reference is too long.' using errcode = '22023';
  end if;

  if p_updates ? 'payment_method'
     and lower(coalesce(p_updates->>'payment_method', '')) not in
       ('cash', 'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'pnb', 'securitybank') then
    raise exception 'Unsupported payment method.' using errcode = '22023';
  end if;

  effective_payment_method := lower(coalesce(
    nullif(p_updates->>'payment_method', ''),
    target.payment_method,
    'cash'
  ));
  if not public.public_payment_method_ready(effective_payment_method) then
    raise exception 'This payment method is not currently enabled.' using errcode = '23514';
  end if;

  if p_updates ? 'downpayment' then
    if coalesce(p_updates->>'downpayment', '') !~ '^[0-9]+([.][0-9]{1,2})?$' then
      raise exception 'The requested payment amount is invalid.' using errcode = '22023';
    end if;
    requested_downpayment := (p_updates->>'downpayment')::numeric;
    if not (
      abs(requested_downpayment - target.total) <= 0.01
      or abs(requested_downpayment - (target.total / 2)) <= 0.01
      or abs(requested_downpayment - round(target.total / 2)) <= 0.01
      or abs(
        requested_downpayment - round(
          least(greatest(coalesce(target.booking_fee_amount_snapshot, 0), 0), target.total)
          + ((target.total - least(greatest(coalesce(target.booking_fee_amount_snapshot, 0), 0), target.total)) * 0.50),
          2
        )
      ) <= 0.01
    ) then
      raise exception 'The requested payment amount is invalid.' using errcode = '22023';
    end if;
  end if;

  if p_updates ? 'status'
     and coalesce(p_updates->>'status', '') not in ('verifying', 'pending', 'cancelled') then
    raise exception 'Booking status cannot be approved by a public client.' using errcode = '42501';
  end if;

  if p_updates ? 'payment_status'
     and coalesce(p_updates->>'payment_status', '') not in
       ('unpaid', 'pending', 'for_verification', 'rejected') then
    raise exception 'Payment status cannot be approved by a public client.' using errcode = '42501';
  end if;

  if coalesce(p_updates->>'status', target.status) = 'pending'
     and effective_payment_method <> 'cash'
     and target.receipt_image_url is null then
    raise exception 'A digital booking cannot become pending before its receipt is stored.' using errcode = '42501';
  end if;

  update public.bookings b
     set full_name = case
           when p_updates ? 'full_name' then trim(p_updates->>'full_name')
           else b.full_name
         end,
         contact_number = case
           when p_updates ? 'contact_number' then nullif(trim(p_updates->>'contact_number'), '')
           else b.contact_number
         end,
         email = case
           when p_updates ? 'email' then nullif(trim(p_updates->>'email'), '')
           else b.email
         end,
         payment_method = case
           when p_updates ? 'payment_method' then lower(p_updates->>'payment_method')
           else b.payment_method
         end,
         received_account = case
           when p_updates ? 'payment_method' then
             case when lower(p_updates->>'payment_method') = 'cash' then 'cash' else 'gcash' end
           else b.received_account
         end,
         payment_flow = case
           when p_updates ? 'payment_flow' then
             case
               when nullif(trim(p_updates->>'payment_flow'), '') is null then null
               when p_updates ? 'payment_method' then lower(p_updates->>'payment_method')
               else b.payment_method
             end
           else b.payment_flow
         end,
         gcash_ref = case
           when p_updates ? 'gcash_ref' then nullif(trim(p_updates->>'gcash_ref'), '')
           else b.gcash_ref
         end,
         downpayment = case
           when p_updates ? 'downpayment' then (p_updates->>'downpayment')::numeric
           else b.downpayment
         end,
         payment_status = case
           when p_updates ? 'payment_status' then p_updates->>'payment_status'
           else b.payment_status
         end,
         status = case
           when p_updates ? 'status' then p_updates->>'status'
           else b.status
         end
   where b.ref = target.ref
   returning b.* into target;

  return target.ref;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.booking_occupies_slot(booking_status text, booking_email text, booking_full_name text, booking_created_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  select case
    when lower(btrim(coalesce(booking_status, ''))) in ('cancelled', 'forfeited')
      then false
    when booking_created_at is not null
      and booking_created_at <= now() - interval '10 minutes'
      and lower(btrim(coalesce(booking_status, ''))) = 'verifying'
      and lower(btrim(coalesce(booking_email, ''))) = 'reserve@hold.internal'
      and lower(btrim(coalesce(booking_full_name, ''))) in ('reserving...', 'reserving…')
      then false
    else true
  end
$function$
;

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
    when 'maribank' then 'maribank_to_gcash'
  end;
  expected_parser_version := case provider_value
    when 'gcash' then 'gcash_v1'
    when 'bdopay' then 'bdopay_to_gcash_v1'
    when 'maya' then 'maya_to_gcash_v1'
    when 'securitybank' then 'gcash_to_securitybank_v1' when 'bpi' then 'bpi_to_gcash_v1'
    when 'gotyme' then 'gotyme_to_gcash_v1'
    when 'maribank' then 'maribank_to_gcash_v1'
  end;
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
     )) <> (case when provider_value = 'securitybank' then 'securitybank' else 'gcash' end) then
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
         or lower(trim(coalesce(b.received_account, ''))) <> (case when provider_value = 'securitybank' then 'securitybank' else 'gcash' end)
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
$function$
;

CREATE OR REPLACE FUNCTION public.finalize_digital_receipt_review(p_booking_ref text, p_booking_refs text[], p_lease_key text, p_lease_token uuid, p_provider text, p_payment_reference text, p_receipt_image_url text, p_receipt_image_hash text, p_receipt_phash text, p_receipt_flags text[], p_receipt_extracted jsonb, p_receipt_confidence numeric, p_receipt_verified_at timestamp with time zone, p_raw_ocr_text text)
 RETURNS TABLE(booking_ref text, booking_status text, booking_payment_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  provider_value text := lower(trim(coalesce(p_provider, '')));
  expected_parser_version text;
  normalized_reference text;
  target_booking public.bookings%rowtype;
  lease_row public.receipt_verification_leases%rowtype;
  actual_refs text[];
  expected_refs text[];
  observed_group_ref text;
  logical_booking_key text;
  invalid_rows integer;
  updated_count integer;
  review_extracted jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the receipt verification service may queue a review.'
      using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_booking_ref, '')), '') is null then
    raise exception 'Booking reference is required.' using errcode = '22023';
  end if;
  if provider_value not in ('gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'securitybank') then
    raise exception 'This provider does not have a dedicated receipt reviewer.'
      using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_receipt_image_url, '')), '') is null
     or coalesce(p_receipt_image_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid private receipt checkpoint is required.'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_receipt_extracted) <> 'object' then
    raise exception 'Structured parser evidence is required.'
      using errcode = '22023';
  end if;

  expected_parser_version := case provider_value
    when 'gcash' then 'gcash_v1'
    when 'bdopay' then 'bdopay_to_gcash_v1'
    when 'maya' then 'maya_to_gcash_v1'
    when 'securitybank' then 'gcash_to_securitybank_v1' when 'bpi' then 'bpi_to_gcash_v1'
    when 'gotyme' then 'gotyme_to_gcash_v1'
    when 'maribank' then 'maribank_to_gcash_v1'
  end;
  if lower(coalesce(p_receipt_extracted->>'provider', '')) <> provider_value
     or coalesce(p_receipt_extracted->>'parserVersion', '') <>
          expected_parser_version
     or coalesce(p_receipt_extracted->>'verifierVersion', '') <>
          'receipt_evidence_v1' then
    raise exception 'Dedicated provider parser/verifier evidence is required.'
      using errcode = '22023';
  end if;
  if p_receipt_confidence is not null
     and (p_receipt_confidence < 0 or p_receipt_confidence > 1) then
    raise exception 'Receipt confidence is outside the valid range.'
      using errcode = '22023';
  end if;

  normalized_reference := public.normalize_payment_reference_key(
    provider_value,
    p_payment_reference
  );
  review_extracted := p_receipt_extracted || jsonb_build_object(
    'workflowResult', 'manual_review'
  );

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

  select count(*)
    into invalid_rows
    from public.bookings b
   where b.ref = any(actual_refs)
     and (
       lower(trim(coalesce(b.payment_method, ''))) <> provider_value
       or (nullif(trim(coalesce(b.gcash_ref, '')), '') is not null
             and public.normalize_payment_reference_key(provider_value, b.gcash_ref) <> normalized_reference)
         or (nullif(trim(coalesce(b.gcash_ref, '')), '') is null
             and coalesce(p_receipt_extracted->>'referenceInputMode', '') <> 'receipt_only')
       or lower(trim(coalesce(b.received_account, ''))) <> (case when provider_value = 'securitybank' then 'securitybank' else 'gcash' end)
       or b.status not in ('verifying', 'pending')
       or b.payment_status not in ('unpaid', 'pending', 'for_verification')
       or b.receipt_image_hash is distinct from p_receipt_image_hash
       or b.receipt_status <> 'manual_review'
     );
  if invalid_rows <> 0 then
    raise exception 'Booking payment state changed during receipt verification.'
      using errcode = '40001';
  end if;

  update public.bookings b
     set status = 'pending',
         payment_status = 'for_verification',
         gcash_ref = coalesce(nullif(trim(b.gcash_ref), ''), nullif(trim(p_payment_reference), '')),
         receipt_image_url = p_receipt_image_url,
         receipt_image_hash = p_receipt_image_hash,
         receipt_phash = p_receipt_phash,
         receipt_status = 'manual_review',
         receipt_flags = coalesce(p_receipt_flags, array[]::text[]),
         receipt_extracted = review_extracted,
         receipt_confidence = p_receipt_confidence,
         receipt_verified_at =
           coalesce(p_receipt_verified_at, clock_timestamp())
   where b.ref = any(actual_refs);

  get diagnostics updated_count = row_count;
  if updated_count <> cardinality(actual_refs) then
    raise exception 'Manual review did not update the complete booking group.'
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
    'manual_review',
    coalesce(p_receipt_flags, array[]::text[]),
    review_extracted,
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
$function$
;

commit;
