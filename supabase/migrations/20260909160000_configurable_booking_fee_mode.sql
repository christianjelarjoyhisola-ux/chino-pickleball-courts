-- Owner-configurable court booking fees. Existing totals and fee snapshots stay locked.
begin;
do $$ begin if public.chino_project_url() <> 'https://wskzptxekldhsxluhgos.supabase.co' then raise exception 'CHINO project guard failed'; end if; end $$;

alter table public.bookings add column if not exists booking_fee_mode_snapshot text not null default 'included' check (booking_fee_mode_snapshot in ('included','separate'));
alter table public.booking_fee_policy_history add column if not exists fee_mode text not null default 'included' check (fee_mode in ('included','separate'));
insert into public.settings(key,value) values ('booking_fee_mode','included') on conflict(key) do nothing;
create or replace function public.booking_fee_is_separate() returns boolean language sql stable security definer set search_path=public,pg_temp as $$ select coalesce((select value='separate' from public.settings where key='booking_fee_mode'),false) $$;
revoke all on function public.booking_fee_is_separate() from public,anon,authenticated;
CREATE OR REPLACE FUNCTION public.calculate_booking_court_total(booking_court_id text, booking_slots text[])
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  base_rate numeric;
  court_tiers jsonb;
  global_tiers_text text;
  global_tiers jsonb := '[]'::jsonb;
  active_tiers jsonb := '[]'::jsonb;
  slot_text text;
  slot_hour numeric;
  tier jsonb;
  tier_from_text text;
  tier_to_text text;
  tier_rate_text text;
  tier_from numeric;
  tier_to numeric;
  tier_rate numeric;
  matched_rate numeric;
  minimum_rate numeric;
  court_total numeric := 0;
begin
  select c.rate, c.rate_schedule
    into base_rate, court_tiers
    from public.courts c
   where c.id = booking_court_id
   limit 1;

  if not found then
    raise exception 'Booking court was not found.';
  end if;
  if base_rate is null or base_rate < 0 then
    raise exception 'Booking court rate is invalid.';
  end if;
  if booking_slots is null or coalesce(cardinality(booking_slots), 0) = 0 then
    raise exception 'Booking must contain at least one time slot.';
  end if;

  if jsonb_typeof(court_tiers) = 'array' then
    active_tiers := court_tiers;
  end if;

  if jsonb_array_length(active_tiers) = 0 then
    select s.value
      into global_tiers_text
      from public.settings s
     where s.key = 'pricing_tiers'
     limit 1;

    if nullif(trim(coalesce(global_tiers_text, '')), '') is not null then
      begin
        global_tiers := global_tiers_text::jsonb;
      exception when others then
        global_tiers := '[]'::jsonb;
      end;
    end if;

    if jsonb_typeof(global_tiers) = 'array' then
      active_tiers := global_tiers;
    end if;
  end if;

  foreach slot_text in array booking_slots loop
    if trim(coalesce(slot_text, '')) !~ '^[0-9]+([.][0-9]+)?$' then
      raise exception 'Booking contains an invalid time slot.';
    end if;

    slot_hour := trim(slot_text)::numeric;
    if slot_hour <> trunc(slot_hour) or slot_hour < 0 or slot_hour >= 24 then
      raise exception 'Booking contains an invalid time slot.';
    end if;

    matched_rate := null;
    minimum_rate := null;

    for tier in
      select value
      from jsonb_array_elements(active_tiers)
    loop
      tier_from_text := tier->>'from';
      tier_to_text := tier->>'to';
      tier_rate_text := tier->>'rate';

      if trim(coalesce(tier_from_text, '')) ~ '^-?[0-9]+([.][0-9]+)?$'
         and trim(coalesce(tier_to_text, '')) ~ '^-?[0-9]+([.][0-9]+)?$'
         and trim(coalesce(tier_rate_text, '')) ~ '^[0-9]+([.][0-9]+)?$' then
        tier_from := trim(tier_from_text)::numeric;
        tier_to := trim(tier_to_text)::numeric;
        tier_rate := trim(tier_rate_text)::numeric;
        minimum_rate := case
          when minimum_rate is null then tier_rate
          else least(minimum_rate, tier_rate)
        end;

        if (tier_from < tier_to and slot_hour >= tier_from and slot_hour < tier_to)
           or (tier_from >= tier_to and (slot_hour >= tier_from or slot_hour < tier_to)) then
          matched_rate := tier_rate;
          exit;
        end if;
      end if;
    end loop;

    court_total := court_total + coalesce(matched_rate, minimum_rate, base_rate);
  end loop;

  -- Configured court/tier rates are the complete player-facing price. Existing
  -- hardened insert paths add the private fee allocation after this function,
  -- so return the net court share to keep the stored total equal to the rate.
  return round(
    court_total - case when public.booking_fee_is_separate() then 0 else public.calculate_booking_service_fee(booking_slots) end,
    2
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION public.calculate_booking_court_total(booking_court_id text, booking_slots text[], booking_date date)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  promo_rate numeric;
  slot_text text;
  normal_slot_total numeric;
  gross_total numeric := 0;
begin
  if not public.court_promo_is_active(booking_court_id, booking_date) then
    return public.calculate_booking_court_total(booking_court_id, booking_slots);
  end if;
  -- Validate the full selection with the original authoritative calculator.
  perform public.calculate_booking_court_total(booking_court_id, booking_slots);
  select c.promo_rate into promo_rate from public.courts c where c.id = booking_court_id;
  foreach slot_text in array booking_slots loop
    normal_slot_total := public.calculate_booking_court_total(booking_court_id, array[slot_text])
      + case when public.booking_fee_is_separate() then 0 else public.calculate_booking_service_fee(array[slot_text]) end;
    -- A later global-tier change must never let a saved promo increase a price.
    gross_total := gross_total + least(normal_slot_total, promo_rate);
  end loop;
  -- Configured rates include the allocation. Existing insert canonicalizers
  -- add it back once; the immutable snapshot caps it to the final gross total.
  return round(gross_total - case when public.booking_fee_is_separate() then 0 else public.calculate_booking_service_fee(booking_slots) end, 2);
end;
$function$
;
CREATE OR REPLACE FUNCTION public.snapshot_booking_fee_on_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  fee_text text;
  fee_type_text text;
  fee_rate numeric := 0;
  fee_type text := 'per_hour';
  fee_units numeric := 0;
  calculated_fee numeric := 0;
  authoritative_total numeric := 0;
begin
  select s.value
    into fee_text
    from public.settings s
   where s.key in ('maintenance_fee', 'service_fee_rate', 'booking_fee')
     and s.value is not null
   order by case s.key
     when 'maintenance_fee' then 1
     when 'service_fee_rate' then 2
     else 3
   end
   limit 1;

  if trim(coalesce(fee_text, '')) ~ '^[0-9]+([.][0-9]+)?$' then
    fee_rate := round(trim(fee_text)::numeric, 2);
  end if;

  select s.value
    into fee_type_text
    from public.settings s
   where s.key = 'fee_type'
   limit 1;

  if lower(trim(coalesce(fee_type_text, ''))) in
     ('flat', 'booking', 'per_booking', 'per_transaction') then
    fee_type := 'flat';
    fee_units := 1;
  else
    fee_units := coalesce(cardinality(new.slots), 0);
  end if;

  calculated_fee := round(greatest(fee_rate, 0) * greatest(fee_units, 0), 2);
  authoritative_total := round(greatest(coalesce(new.total, 0), 0), 2);

  -- Ignore all client-supplied snapshot values.
  new.booking_fee_mode_snapshot := case when public.booking_fee_is_separate() then 'separate' else 'included' end;
  new.booking_fee_rate_snapshot := greatest(fee_rate, 0);
  new.booking_fee_type_snapshot := fee_type;
  new.booking_fee_units_snapshot := greatest(fee_units, 0);
  new.booking_fee_amount_snapshot := least(calculated_fee, authoritative_total);
  new.booking_fee_snapshot_source := 'server_insert';
  new.booking_fee_ledger_eligible_snapshot := (
    auth.role() = 'anon'
    or public.current_account_role() = 'host'
    or (
      lower(coalesce(new.created_via, '')) in ('customer', 'host', 'admin')
      and lower(coalesce(new.payment_method, '')) <> 'manual'
      and new.ref not ilike 'MANUAL-%'
    )
  );

  -- Restores and direct inserts may carry old client-controlled billing stamps.
  -- Preserve them only when this exact reference belongs to a paid legacy
  -- statement; otherwise clear them so they cannot suppress the new ledger.
  if not exists (
    select 1
      from public.weekly_fees wf
     where wf.status = 'paid'
       and (
         coalesce(wf.billed_refs, '[]'::jsonb) @> jsonb_build_array(new.ref)
         or (
           public.current_account_role() = 'owner'
           and wf.id = new.weekly_fee_id
         )
       )
  ) then
    new.weekly_fee_id := null;
    new.billed_at := null;
  end if;

  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.guard_booking_fee_snapshot_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if new.booking_fee_mode_snapshot is distinct from old.booking_fee_mode_snapshot
     or new.booking_fee_amount_snapshot is distinct from old.booking_fee_amount_snapshot
     or new.booking_fee_rate_snapshot is distinct from old.booking_fee_rate_snapshot
     or new.booking_fee_type_snapshot is distinct from old.booking_fee_type_snapshot
     or new.booking_fee_units_snapshot is distinct from old.booking_fee_units_snapshot
     or new.booking_fee_snapshot_source is distinct from old.booking_fee_snapshot_source
     or new.booking_fee_ledger_eligible_snapshot is distinct from old.booking_fee_ledger_eligible_snapshot then
    raise exception 'Booking fee snapshots are immutable after booking creation.'
      using errcode = '22000';
  end if;
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.can_write_setting(setting_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
    when public.current_account_role() = 'owner' then true
    when public.current_account_role() = 'court_owner' then
      coalesce(setting_key, '') not in (
        'booking_fee_mode',
        'booking_fee',
        'service_fee_rate',
        'maintenance_fee',
        'fee_type',
        'platform_gcash_number',
        'platform_gcash_name',
        'platform_gcash_qr'
      )
    else false
  end
$function$
;
CREATE OR REPLACE FUNCTION public.guard_fixed_booking_fee_policy()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  policy_rate numeric;
  policy_type text;
  policy_mode text;
begin
  if tg_op = 'DELETE' then
    if old.key in ('maintenance_fee', 'fee_type', 'booking_fee_mode') then
      raise exception 'The audited platform allocation policy cannot be deleted.'
        using errcode = '22023';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE'
     and old.key in ('maintenance_fee', 'fee_type', 'booking_fee_mode')
     and new.key is distinct from old.key then
    raise exception 'The platform allocation policy key cannot be renamed.'
      using errcode = '22023';
  end if;
  if new.key not in ('maintenance_fee', 'fee_type', 'booking_fee_mode') then return new; end if;

  select fee_rate, fee_type, fee_mode into policy_rate, policy_type, policy_mode
  from public.booking_fee_policy_history
  order by effective_at desc, recorded_at desc, policy_key desc
  limit 1;
  if policy_rate is null or policy_type is null then
    raise exception 'An audited platform allocation policy is required.';
  end if;
  if new.key = 'maintenance_fee' then
    if trim(coalesce(new.value, '')) !~ '^[0-9]+([.][0-9]+)?$' then
      raise exception 'The platform allocation must match the audited venue policy.'
        using errcode = '22023';
    end if;
    if round(trim(new.value)::numeric, 2) <> policy_rate then
      raise exception 'The platform allocation must match the audited venue policy.'
        using errcode = '22023';
    end if;
  elsif new.key = 'booking_fee_mode' then
    if new.value is distinct from policy_mode then raise exception 'Booking fee mode must match the audited policy.' using errcode='22023'; end if;
  elsif lower(trim(coalesce(new.value, ''))) <> policy_type then
    raise exception 'The platform allocation type must match the audited venue policy.'
      using errcode = '22023';
  end if;
  return new;
end;
$function$
;

create or replace function public.set_booking_fee_policy(p_mode text,p_rate numeric) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if public.current_account_role() is distinct from 'owner' then raise exception 'Only the System Owner can change booking fees.' using errcode='42501'; end if;
 if p_mode is null or p_mode not in ('included','separate') or p_rate is null or p_rate < 0 or p_rate > 100000 or p_rate <> round(p_rate,2) then raise exception 'Choose a fee mode and a valid hourly amount with up to two decimal places.' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtext('chino_booking_fee_policy'));
 insert into public.booking_fee_policy_history(policy_key,fee_type,fee_rate,fee_mode,effective_at,source,notes)
 values ('chino-owner-'||gen_random_uuid()::text,'per_hour',p_rate,p_mode,clock_timestamp(),'system_owner_settings','Changed by '||auth.uid()::text||'; applies to new bookings only.');
 insert into public.settings(key,value) values ('maintenance_fee',p_rate::text),('fee_type','per_hour'),('booking_fee_mode',p_mode) on conflict(key) do update set value=excluded.value;
 return jsonb_build_object('booking_fee_mode',p_mode,'maintenance_fee',p_rate::text,'fee_type','per_hour');
end $$;
revoke all on function public.set_booking_fee_policy(text,numeric) from public,anon;
grant execute on function public.set_booking_fee_policy(text,numeric) to authenticated;
CREATE OR REPLACE FUNCTION public.prepare_authenticated_host_booking_hold()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  account_name text;
  account_email text;
  authoritative_court_name text;
  authoritative_rate numeric;
  court_blocked boolean;
  court_total numeric;
  service_fee numeric;
begin
  if auth.role() = 'authenticated'
     and public.current_account_role() = 'host' then
    select a.full_name, a.email
      into account_name, account_email
      from public.accounts a
     where a.id = auth.uid()
       and a.role = 'host'
       and a.status = 'active'
     limit 1;

    select c.name, c.rate, c.blocked
      into authoritative_court_name, authoritative_rate, court_blocked
      from public.courts c
     where c.id = new.court_id
     limit 1;

    if not found then
      raise exception 'Booking court was not found.';
    end if;
    if coalesce(court_blocked, false) then
      raise exception 'This court is not currently available for booking.';
    end if;

    court_total := public.calculate_booking_court_total(new.court_id, new.slots, new.date);
    service_fee := public.calculate_booking_service_fee(new.slots);

    new.host_booking := true;
    new.host_user_id := auth.uid();
    new.host_name := account_name;
    new.host_email := account_email;
    new.created_via := 'host';
    new.created_by_user_id := auth.uid();
    new.created_by_role := 'host';
    new.created_by_name := account_name;
    new.created_by_email := account_email;
    new.court_name := authoritative_court_name;
    new.rate := case when public.court_promo_is_active(new.court_id, new.date) then round((court_total + case when public.booking_fee_is_separate() then 0 else service_fee end) / greatest(cardinality(new.slots), 1), 2) else authoritative_rate end;
    new.total := round(court_total + service_fee, 2);
  end if;

  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.prepare_public_booking_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  request_role text := coalesce(
    auth.role(),
    nullif(current_setting('request.jwt.claim.role', true), '')
  );
  is_public_submission boolean :=
    coalesce(current_setting('paddle_rage.public_booking_submission', true), '') = 'on'
    or request_role = 'anon';
  authoritative_court_name text;
  authoritative_rate numeric;
  court_blocked boolean;
  court_total numeric;
  service_fee numeric;
  first_hour integer;
  last_hour integer;
begin
  if not is_public_submission then
    return new;
  end if;

  if nullif(trim(coalesce(new.ref, '')), '') is null
     or length(new.ref) > 100 then
    raise exception 'A valid booking reference is required.' using errcode = '22023';
  end if;

  if nullif(trim(coalesce(new.full_name, '')), '') is null
     or length(trim(new.full_name)) > 150 then
    raise exception 'A valid customer name is required.' using errcode = '22023';
  end if;

  if length(coalesce(new.contact_number, '')) > 40
     or length(coalesce(new.email, '')) > 254
     or length(coalesce(new.gcash_ref, '')) > 100 then
    raise exception 'Booking contact or payment reference is too long.' using errcode = '22023';
  end if;

  if new.date is null
     or new.date < current_date
     or new.date > current_date + 366 then
    raise exception 'Booking date is outside the allowed reservation window.' using errcode = '22023';
  end if;

  if new.slots is null
     or coalesce(cardinality(new.slots), 0) = 0
     or cardinality(new.slots) > 24 then
    raise exception 'Booking must contain valid time slots.' using errcode = '22023';
  end if;

  if (
    select count(distinct slot_value)
      from unnest(new.slots) as slot_value
  ) <> cardinality(new.slots) then
    raise exception 'Booking time slots cannot contain duplicates.' using errcode = '22023';
  end if;
  if exists (
    select 1
      from unnest(new.slots) as slot_value
     where slot_value !~ '^(?:[0-9]|1[0-9]|2[0-3])$'
  ) then
    raise exception 'Booking time slots are invalid.' using errcode = '22023';
  end if;

  if new.customer_access_token_hash is null
     or new.customer_access_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A secure booking access token is required.' using errcode = '42501';
  end if;

  new.booking_group_ref := nullif(trim(coalesce(new.booking_group_ref, '')), '');
  if new.booking_group_ref is not null then
    if length(new.booking_group_ref) > 100 then
      raise exception 'Booking group reference is too long.' using errcode = '22023';
    end if;

    -- Every row in a browser-created group must share the same access-token
    -- digest. This prevents a caller from attaching its row to another
    -- customer's group and causing a service-role receipt update to fan out to
    -- the victim's bookings. The advisory lock closes the first-row race.
    perform pg_advisory_xact_lock(
      hashtextextended('paddle-rage-public-booking-group:' || new.booking_group_ref, 0)
    );
    if exists (
      select 1
        from public.bookings existing
       where existing.booking_group_ref = new.booking_group_ref
         and existing.customer_access_token_hash is distinct from new.customer_access_token_hash
    ) then
      raise exception 'Booking group does not belong to this reservation.' using errcode = '42501';
    end if;
  end if;

  select c.name, c.rate, c.blocked
    into authoritative_court_name, authoritative_rate, court_blocked
    from public.courts c
   where c.id = new.court_id
   limit 1;

  if not found then
    raise exception 'Booking court was not found.' using errcode = '22023';
  end if;
  if coalesce(court_blocked, false) then
    raise exception 'This court is not currently available for booking.' using errcode = '22023';
  end if;

  if lower(coalesce(new.payment_method, 'cash')) not in
     ('cash', 'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'pnb', 'securitybank') then
    raise exception 'Unsupported payment method.' using errcode = '22023';
  end if;

  court_total := public.calculate_booking_court_total(new.court_id, new.slots, new.date);
  service_fee := public.calculate_booking_service_fee(new.slots);

  -- Serialize the database conflict check for one court/date. The legacy
  -- overlap trigger remains the final check, while this lock closes its
  -- concurrent check-then-insert race.
  perform pg_advisory_xact_lock(
    hashtextextended('paddle-rage-booking:' || new.court_id || ':' || new.date::text, 0)
  );

  select min(slot_value::integer), max(slot_value::integer)
    into first_hour, last_hour
    from unnest(new.slots) as slot_value;

  -- Values below are authoritative regardless of what the browser supplied.
  new.full_name := trim(new.full_name);
  new.court_name := authoritative_court_name;
  new.rate := case when public.court_promo_is_active(new.court_id, new.date) then round((court_total + case when public.booking_fee_is_separate() then 0 else service_fee end) / greatest(cardinality(new.slots), 1), 2) else authoritative_rate end;
  new.duration := cardinality(new.slots);
  new.total := round(court_total + service_fee, 2);
  new.start_time := format(
    '%s:00 %s',
    case when first_hour % 12 = 0 then 12 else first_hour % 12 end,
    case when first_hour < 12 then 'AM' else 'PM' end
  );
  new.end_time := format(
    '%s:00 %s',
    case when (last_hour + 1) % 12 = 0 then 12 else (last_hour + 1) % 12 end,
    case when ((last_hour + 1) % 24) < 12 then 'AM' else 'PM' end
  );
  if new.downpayment is not null and not (
    abs(new.downpayment - new.total) <= 0.01
    or abs(new.downpayment - (new.total / 2)) <= 0.01
    or abs(new.downpayment - round(new.total / 2)) <= 0.01
    or abs(
      new.downpayment - round(
        least(greatest(coalesce(new.booking_fee_amount_snapshot, 0), 0), new.total)
        + ((new.total - least(greatest(coalesce(new.booking_fee_amount_snapshot, 0), 0), new.total)) * 0.50),
        2
      )
    ) <= 0.01
  ) then
    raise exception 'The requested payment amount is invalid.' using errcode = '22023';
  end if;
  new.created_at := clock_timestamp();
  new.host_booking := false;
  new.host_user_id := null;
  new.host_name := null;
  new.host_email := null;
  new.created_via := 'customer';
  new.created_by_user_id := null;
  new.created_by_role := null;
  new.created_by_name := null;
  new.created_by_email := null;
  new.payment_method := lower(coalesce(new.payment_method, 'cash'));
  new.received_account := case
    when new.payment_method = 'cash' then 'cash'
    else 'gcash'
  end;
  new.payment_flow := case
    when new.payment_flow is null then null
    else new.payment_method
  end;
  new.payment_provider := null;
  new.payment_session_id := null;
  new.payment_checkout_url := null;
  new.paid_at := null;
  new.balance_due_at := null;
  new.forfeited_at := null;
  new.forfeiture_reason := null;
  new.receipt_image_url := null;
  new.receipt_image_hash := null;
  new.receipt_phash := null;
  new.receipt_status := 'none';
  new.receipt_flags := '{}'::text[];
  new.receipt_extracted := null;
  new.receipt_confidence := null;
  new.receipt_verified_at := null;
  new.billed_at := null;
  new.weekly_fee_id := null;
  new.confirmation_email_id := null;
  new.confirmation_email_sent_at := null;
  new.confirmation_email_last_event := null;
  -- Every browser-created row begins as a short-lived, unpaid hold. Neither
  -- the Edge payload nor a service-role caller may create a permanent pending
  -- blocker. Only the token-authorized finalizer or receipt verifier can move
  -- this row to its next canonical state.
  new.status := 'verifying';
  new.payment_status := 'unpaid';

  -- The existing fee-snapshot trigger runs after this alphabetically and
  -- stamps the immutable platform fee. The existing RLS policy then validates
  -- full/partial downpayments against the authoritative total.
  return new;
end;
$function$
;
notify pgrst,'reload schema';
commit;
