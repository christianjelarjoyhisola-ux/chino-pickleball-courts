-- Date-bound court promotions affect new reservations only. A court's normal
-- rate schedule and every existing booking/payment snapshot remain unchanged.
begin;

alter table public.courts
  add column if not exists promo_enabled boolean not null default false,
  add column if not exists promo_rate numeric,
  add column if not exists promo_start_date date,
  add column if not exists promo_end_date date;

alter table public.courts
  add constraint courts_promo_rate_check check (
    promo_rate is null or (promo_rate > 0 and promo_rate < 10000000000 and promo_rate = round(promo_rate, 2))
  ),
  add constraint courts_promo_enabled_rate_check check (
    not promo_enabled or promo_rate is not null
  ),
  add constraint courts_promo_dates_check check (
    (promo_start_date is null or isfinite(promo_start_date))
    and (promo_end_date is null or isfinite(promo_end_date))
    and (promo_start_date is null or promo_end_date is null or promo_end_date >= promo_start_date)
  );

create or replace function public.validate_court_promo_configuration()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $promo$
declare
  active_tiers jsonb := '[]'::jsonb;
  global_tiers_text text;
  tier jsonb;
  tier_rate numeric;
  minimum_rate numeric;
begin
  -- Court RLS already restricts all writes to active owner/court_owner accounts.
  -- Also reject an authenticated non-owner if a future policy becomes broader.
  if auth.role() = 'authenticated'
     and not public.has_account_role(array['owner','court_owner']) then
    raise exception 'Only an owner or court owner can change court pricing.' using errcode = '42501';
  end if;
  if new.promo_enabled and new.promo_rate is null then
    raise exception 'Enter a promotional hourly rate before enabling the promo.' using errcode = '22023';
  end if;
  if new.promo_start_date is not null and not isfinite(new.promo_start_date)
     or new.promo_end_date is not null and not isfinite(new.promo_end_date)
     or new.promo_start_date is not null and new.promo_end_date is not null
        and new.promo_end_date < new.promo_start_date then
    raise exception 'Choose valid promo dates with the end on or after the start.' using errcode = '22023';
  end if;
  if new.promo_rate is null then return new; end if;
  if not (new.promo_rate > 0 and new.promo_rate < 10000000000 and new.promo_rate = round(new.promo_rate, 2)) then
    raise exception 'The promo rate must be positive with no more than two decimal places.' using errcode = '22023';
  end if;
  -- An outdated saved discount must never prevent an owner from switching it off.
  if not new.promo_enabled then return new; end if;

  if jsonb_typeof(new.rate_schedule) = 'array' then
    active_tiers := new.rate_schedule;
  end if;
  if jsonb_array_length(active_tiers) = 0 then
    select value into global_tiers_text from public.settings where key = 'pricing_tiers';
    if nullif(btrim(coalesce(global_tiers_text, '')), '') is not null then
      begin
        if jsonb_typeof(global_tiers_text::jsonb) = 'array' then
          active_tiers := global_tiers_text::jsonb;
        end if;
      exception when invalid_text_representation then
        active_tiers := '[]'::jsonb;
      end;
    end if;
  end if;
  for tier in select value from jsonb_array_elements(active_tiers) loop
    -- Match the normal SQL calculator's valid tier definition exactly.
    if btrim(coalesce(tier->>'from', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
       and btrim(coalesce(tier->>'to', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
       and btrim(coalesce(tier->>'rate', '')) ~ '^[0-9]+([.][0-9]+)?$' then
      tier_rate := btrim(tier->>'rate')::numeric;
      minimum_rate := case when minimum_rate is null then tier_rate else least(minimum_rate, tier_rate) end;
    end if;
  end loop;
  minimum_rate := coalesce(minimum_rate, new.rate);
  if minimum_rate is null or not (new.promo_rate < minimum_rate) then
    raise exception 'The promo rate must be lower than every active regular hourly rate.' using errcode = '22023';
  end if;
  return new;
end;
$promo$;

revoke all on function public.validate_court_promo_configuration() from public, anon, authenticated;
drop trigger if exists validate_court_promo_configuration on public.courts;
create trigger validate_court_promo_configuration
before insert or update of rate, rate_schedule, promo_enabled, promo_rate, promo_start_date, promo_end_date
on public.courts for each row execute function public.validate_court_promo_configuration();

create or replace function public.court_promo_is_active(booking_court_id text, booking_date date)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $promo$
  select coalesce((
    select c.promo_enabled and booking_date is not null
      and c.promo_rate > 0 and c.promo_rate < 10000000000
      and (c.promo_start_date is null or booking_date >= c.promo_start_date)
      and (c.promo_end_date is null or booking_date <= c.promo_end_date)
      and (c.promo_start_date is null or c.promo_end_date is null or c.promo_end_date >= c.promo_start_date)
    from public.courts c where c.id = booking_court_id
  ), false);
$promo$;
revoke all on function public.court_promo_is_active(text, date) from public, anon, authenticated;

-- Keep the existing two-argument calculator and its normal tier semantics.
-- The overload below accepts the date of play, never the date of payment.
create or replace function public.calculate_booking_court_total(
  booking_court_id text,
  booking_slots text[],
  booking_date date
)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $promo$
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
      + public.calculate_booking_service_fee(array[slot_text]);
    -- A later global-tier change must never let a saved promo increase a price.
    gross_total := gross_total + least(normal_slot_total, promo_rate);
  end loop;
  -- Configured rates include the allocation. Existing insert canonicalizers
  -- add it back once; the immutable snapshot caps it to the final gross total.
  return round(gross_total - public.calculate_booking_service_fee(booking_slots), 2);
end;
$promo$;
revoke all on function public.calculate_booking_court_total(text, text[], date) from public, anon, authenticated;
grant execute on function public.calculate_booking_court_total(text, text[], date) to service_role;

-- Preserve the current hardened bodies, locks, tokens and payment guards. Only
-- inject the date-aware price calculation into the two INSERT canonicalizers.
do $migration$
declare
  signature text;
  definition text;
  old_call constant text := 'public.calculate_booking_court_total(new.court_id, new.slots)';
  new_call constant text := 'public.calculate_booking_court_total(new.court_id, new.slots, new.date)';
  old_rate constant text := 'new.rate := authoritative_rate;';
  new_rate constant text := 'new.rate := case when public.court_promo_is_active(new.court_id, new.date) then round((court_total + service_fee) / greatest(cardinality(new.slots), 1), 2) else authoritative_rate end;';
begin
  foreach signature in array array[
    'public.prepare_public_booking_insert()',
    'public.prepare_authenticated_host_booking_hold()'
  ] loop
    select pg_get_functiondef(signature::regprocedure) into definition;
    if position(old_call in definition) = 0 or position(old_rate in definition) = 0 then
      raise exception 'Promo migration found an unexpected booking canonicalizer: %', signature;
    end if;
    definition := replace(definition, old_call, new_call);
    definition := replace(definition, old_rate, new_rate);
    execute definition;
  end loop;
end;
$migration$;

comment on column public.courts.promo_rate is
  'Optional complete player-facing hourly promo price; evaluated against the inclusive date of play on new reservations only.';
comment on function public.calculate_booking_court_total(text, text[], date) is
  'Date-aware net court share for new holds. Promos never raise a normal slot price; stored booking and payment snapshots are never repriced.';

notify pgrst, 'reload schema';
commit;
