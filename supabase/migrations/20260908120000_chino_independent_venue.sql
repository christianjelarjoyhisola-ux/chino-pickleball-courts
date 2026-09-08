-- Independent CHINO installation. Run once after the consolidated baseline
-- and the complete forward migration chain, before creating venue accounts.
-- No customer, account, signature, court, booking or receipt data is copied.
begin;

do $$
begin
  if exists (select 1 from public.courts)
     or exists (select 1 from public.bookings)
     or exists (select 1 from public.accounts)
     or exists (select 1 from public.agreements) then
    raise exception 'CHINO initialization requires a fresh database without venue data.';
  end if;
end;
$$;

-- The source allocation is not an agreement with CHINO. Retain its immutable
-- history and append an explicit zero-fee policy for this independent venue.
alter table public.booking_fee_policy_history
  drop constraint if exists booking_fee_policy_history_rate_check;
alter table public.booking_fee_policy_history
  add constraint booking_fee_policy_history_rate_check check (fee_rate >= 0);

insert into public.booking_fee_policy_history (
  policy_key, fee_type, fee_rate, effective_at, source, notes
) values (
  'chino-initial-allocation-v1', 'per_hour', 0, clock_timestamp(),
  'chino_initialization',
  'No platform allocation has been agreed for CHINO. Zero allocation applies until an explicit audited policy migration is approved.'
)
on conflict (policy_key) do nothing;

create or replace function public.guard_fixed_booking_fee_policy()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  policy_rate numeric;
  policy_type text;
begin
  if tg_op = 'DELETE' then
    if old.key in ('maintenance_fee', 'fee_type') then
      raise exception 'The audited platform allocation policy cannot be deleted.'
        using errcode = '22023';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE'
     and old.key in ('maintenance_fee', 'fee_type')
     and new.key is distinct from old.key then
    raise exception 'The platform allocation policy key cannot be renamed.'
      using errcode = '22023';
  end if;
  if new.key not in ('maintenance_fee', 'fee_type') then return new; end if;

  select fee_rate, fee_type into policy_rate, policy_type
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
  elsif lower(trim(coalesce(new.value, ''))) <> policy_type then
    raise exception 'The platform allocation type must match the audited venue policy.'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

comment on function public.guard_fixed_booking_fee_policy() is
  'Uses the latest immutable venue policy. CHINO starts at zero; future policy changes require an explicit audited migration.';

-- Empty details are intentional: the owner supplies the real hours, rates,
-- location and payment destinations. All payment methods start disabled.
insert into public.settings (key, value, updated_at)
values
  ('venue_name', 'CHINO Pickleball Courts', now()),
  ('opening_date', '2026-01-01', now()),
  ('venue_address', '', now()),
  ('venue_contact', '', now()),
  ('venue_email', '', now()),
  ('venue_description', '', now()),
  ('open_time', '', now()),
  ('close_time', '', now()),
  ('open_hour', '', now()),
  ('close_hour', '', now()),
  ('booking_fee', '0', now()),
  ('service_fee_rate', '0', now()),
  ('maintenance_fee', '0', now()),
  ('fee_type', 'per_hour', now()),
  ('open_play_fee', '0', now()),
  ('open_play_config', '{"enabled":false,"days":[],"specificDates":[],"courtIds":[],"fee":0,"maxPlayers":16}', now()),
  ('maintenance_config', '{"rules":[]}', now()),
  ('pricing_tiers', '[]', now()),
  ('payment_method_cash', '0', now()),
  ('payment_method_gcash', '0', now()),
  ('payment_method_bdopay', '0', now()),
  ('payment_method_maya', '0', now()),
  ('payment_method_bpi', '0', now()),
  ('payment_method_gotyme', '0', now()),
  ('payment_method_maribank', '0', now()),
  ('payment_method_pnb', '0', now()),
  ('gcash_checkout_enabled', '0', now()),
  ('gcash_checkout_url', '', now()),
  ('gcash_merchant_number', '', now()),
  ('gcash_merchant_name', '', now()),
  ('gcash_qr_image', '', now()),
  ('payment_merchant_name', '', now()),
  ('bpi_receipt_recipient_name', '', now()),
  ('bdopay_receipt_recipient_name', '', now()),
  ('bdopay_receipt_destination_token', '', now()),
  ('gcash_qr_receipt_recipient_name', '', now()),
  ('gcash_qr_receipt_destination_token', '', now()),
  ('platform_gcash_number', '', now()),
  ('platform_gcash_name', '', now()),
  ('platform_gcash_qr', '', now()),
  ('owner_signature', '', now()),
  ('court_owner_signature', '', now())
on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;

update public.settings
set value = '', updated_at = now()
where key ~ '(^|_)(merchant_(name|number)|receipt_recipient_name|receipt_destination_token|qr_image|signature)$';

-- Realtime invalidations preserve the live booking, dashboard and host flows.
-- Publication membership does not bypass any RLS or column privilege rules.
do $$
declare
  table_name text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach table_name in array array[
    'bookings', 'deleted_booking_archive', 'courts', 'settings', 'blocked_dates',
    'open_play_registrations', 'open_play_host_applications',
    'open_play_host_sessions', 'open_play_host_session_registrations',
    'open_play_game_sessions', 'open_play_game_players', 'open_play_game_rounds',
    'weekly_fees', 'booking_fee_remittances', 'booking_fee_remittance_items',
    'booking_fee_remittance_payments', 'accounts', 'host_booking_balance_payments'
  ] loop
    if to_regclass('public.' || table_name) is not null and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public'
        and tablename = table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end;
$$;

notify pgrst, 'reload schema';
commit;
