begin;

-- Paid/confirmed bookings earn an immutable platform-fee snapshot. If that
-- booking is later cancelled because its payment was rejected or failed, the
-- earned fact remains intact while this append-only ledger records why the
-- still-unremitted amount is no longer payable.
create table if not exists public.booking_fee_pre_remittance_releases (
  id uuid primary key default gen_random_uuid(),
  release_ref text not null unique,
  booking_ref text not null unique,
  booking_group_ref text,
  source_remittance_id uuid references public.booking_fee_remittances(id) on delete restrict,
  original_fee_amount numeric(12,2) not null,
  released_amount numeric(12,2) not null,
  fee_earned_at timestamptz not null,
  fee_rate numeric(12,2) not null,
  fee_type text not null,
  fee_units numeric(12,2) not null,
  fee_snapshot_source text not null,
  terminal_booking_status text not null,
  terminal_payment_status text not null,
  release_source text not null,
  reason text not null,
  released_at timestamptz not null default clock_timestamp(),
  actor_user_id uuid,
  actor_role text not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint booking_fee_pre_release_amount_check check (
    original_fee_amount > 0
    and released_amount < 0
    and released_amount = -original_fee_amount
  ),
  constraint booking_fee_pre_release_snapshot_check check (
    fee_rate >= 0 and fee_units >= 0 and fee_type in ('flat', 'per_hour')
  ),
  constraint booking_fee_pre_release_terminal_check check (
    terminal_booking_status = 'cancelled'
    and terminal_payment_status in ('rejected', 'failed', 'unpaid')
  ),
  constraint booking_fee_pre_release_source_check check (
    release_source in ('automatic_terminal_transition', 'one_time_reconciliation')
  ),
  constraint booking_fee_pre_release_reason_check check (
    length(trim(reason)) between 3 and 500
  )
);

create index if not exists idx_booking_fee_pre_releases_group
  on public.booking_fee_pre_remittance_releases (booking_group_ref, released_at, id);
create index if not exists idx_booking_fee_pre_releases_released
  on public.booking_fee_pre_remittance_releases (released_at, id);

comment on table public.booking_fee_pre_remittance_releases is
  'Append-only audit of earned booking fees released before remittance because a cancelled booking had rejected/failed/unpaid payment and retained no deposit.';

create or replace function public.prevent_booking_fee_pre_release_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'Pre-remittance platform-fee releases are permanent and cannot be changed or deleted.'
    using errcode = '22000';
end;
$$;

drop trigger if exists trg_no_update_booking_fee_pre_releases
  on public.booking_fee_pre_remittance_releases;
create trigger trg_no_update_booking_fee_pre_releases
before update on public.booking_fee_pre_remittance_releases
for each row execute function public.prevent_booking_fee_pre_release_change();

drop trigger if exists trg_no_delete_booking_fee_pre_releases
  on public.booking_fee_pre_remittance_releases;
create trigger trg_no_delete_booking_fee_pre_releases
before delete on public.booking_fee_pre_remittance_releases
for each row execute function public.prevent_booking_fee_pre_release_change();

create or replace function public.release_terminal_booking_fee_before_remittance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  release_time timestamptz := clock_timestamp();
  actor_id uuid := auth.uid();
  actor_kind text := coalesce(public.current_account_role(),
    case when auth.role() = 'service_role' then 'service_role' else 'system' end);
  active_remittance public.booking_fee_remittances%rowtype;
  active_item public.booking_fee_remittance_items%rowtype;
  remaining_count integer := 0;
  remaining_booking_amount numeric(12,2) := 0;
  remaining_adjustment_amount numeric(12,2) := 0;
  remaining_due numeric(12,2) := 0;
  audit_reason text;
begin
  if new.booking_fee_earned_at is null
     or coalesce(new.booking_fee_amount_snapshot, 0) <= 0
     or not coalesce(new.booking_fee_ledger_eligible_snapshot, false)
     or new.status <> 'cancelled'
     or new.payment_status not in ('rejected', 'failed', 'unpaid')
     or (old.status = new.status and old.payment_status = new.payment_status) then
    return new;
  end if;

  -- Serialize against exact-cutoff remittance preparation. Whichever action
  -- obtains this lock first becomes the durable, auditable ledger outcome.
  perform pg_advisory_xact_lock(
    hashtextextended('paddle-rage-pickleball-booking-fee-remittance', 0)
  );

  if exists (
    select 1
      from public.booking_fee_pre_remittance_releases release
     where release.booking_ref = new.ref
  ) then
    return new;
  end if;

  select item.*
    into active_item
    from public.booking_fee_remittance_items item
   where item.booking_ref = new.ref
     and item.released_at is null
   order by item.created_at desc
   limit 1
   for update;

  if active_item.id is not null then
    select remittance.*
      into active_remittance
      from public.booking_fee_remittances remittance
     where remittance.id = active_item.remittance_id
     for update;
  end if;

  if active_item.id is not null then
    -- Submitted/settled money is corrected only through the existing signed
    -- adjustment ledger. This automatic path is strictly pre-remittance.
    if active_remittance.status not in ('prepared', 'payment_rejected')
       or coalesce(active_remittance.amount_settled, 0) <> 0
       or exists (
         select 1
           from public.booking_fee_remittance_payments payment
          where payment.remittance_id = active_remittance.id
            and payment.status in ('pending', 'accepted', 'partially_accepted')
       ) then
      return new;
    end if;
  end if;

  audit_reason := format(
    'Automatically released before remittance: booking changed from %s/%s to cancelled/%s with no retained deposit.',
    coalesce(old.status, 'unknown'),
    coalesce(old.payment_status, 'unknown'),
    new.payment_status
  );

  insert into public.booking_fee_pre_remittance_releases (
    release_ref,
    booking_ref,
    booking_group_ref,
    source_remittance_id,
    original_fee_amount,
    released_amount,
    fee_earned_at,
    fee_rate,
    fee_type,
    fee_units,
    fee_snapshot_source,
    terminal_booking_status,
    terminal_payment_status,
    release_source,
    reason,
    released_at,
    actor_user_id,
    actor_role
  ) values (
    'REL-' || new.ref,
    new.ref,
    new.booking_group_ref,
    active_remittance.id,
    round(new.booking_fee_amount_snapshot, 2),
    -round(new.booking_fee_amount_snapshot, 2),
    new.booking_fee_earned_at,
    round(new.booking_fee_rate_snapshot, 2),
    new.booking_fee_type_snapshot,
    round(new.booking_fee_units_snapshot, 2),
    new.booking_fee_snapshot_source,
    new.status,
    new.payment_status,
    'automatic_terminal_transition',
    audit_reason,
    release_time,
    actor_id,
    actor_kind
  ) on conflict (booking_ref) do nothing;

  if active_item.id is null then
    return new;
  end if;

  update public.booking_fee_remittance_items item
     set released_at = release_time,
         released_by_user_id = actor_id,
         release_reason = audit_reason
   where item.id = active_item.id
     and item.released_at is null;

  select
    count(*)::integer,
    coalesce(round(sum(item.fee_amount), 2), 0)
    into remaining_count, remaining_booking_amount
    from public.booking_fee_remittance_items item
   where item.remittance_id = active_remittance.id
     and item.released_at is null;

  select coalesce(round(sum(adjustment.amount), 2), 0)
    into remaining_adjustment_amount
    from public.booking_fee_adjustment_applications adjustment
   where adjustment.remittance_id = active_remittance.id
     and adjustment.released_at is null;

  remaining_due := round(remaining_booking_amount + remaining_adjustment_amount, 2);
  if remaining_due <= 0 then
    update public.booking_fee_remittances remittance
       set bookings_count = 0,
           amount_due = 0,
           status = 'cancelled',
           cancelled_at = release_time,
           cancelled_by_user_id = actor_id,
           cancellation_reason = 'No payable balance after automatic pre-remittance booking-fee release.',
           cancel_idempotency_key = 'auto-release-' || active_remittance.id::text
     where remittance.id = active_remittance.id;
  else
    update public.booking_fee_remittances remittance
       set bookings_count = remaining_count,
           amount_due = remaining_due
     where remittance.id = active_remittance.id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_release_terminal_booking_fee_before_remittance
  on public.bookings;
create trigger trg_release_terminal_booking_fee_before_remittance
after update of status, payment_status on public.bookings
for each row execute function public.release_terminal_booking_fee_before_remittance();

-- Retain the immutable earned snapshot while excluding its signed release
-- from the accumulating payable set.
create or replace function public.booking_fee_unclaimed_rows()
returns table (
  booking_ref text,
  booking_group_ref text,
  booking_created_at timestamptz,
  fee_earned_at timestamptz,
  court_id text,
  court_name text,
  booking_date date,
  host_booking boolean,
  created_via text,
  fee_amount numeric,
  fee_rate numeric,
  fee_type text,
  fee_units numeric,
  fee_snapshot_source text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    b.ref,
    b.booking_group_ref,
    b.created_at,
    b.booking_fee_earned_at,
    b.court_id,
    b.court_name,
    b.date,
    coalesce(b.host_booking, false),
    b.created_via,
    b.booking_fee_amount_snapshot,
    b.booking_fee_rate_snapshot,
    b.booking_fee_type_snapshot,
    b.booking_fee_units_snapshot,
    b.booking_fee_snapshot_source
  from public.bookings b
  where b.booking_fee_earned_at is not null
    and b.booking_fee_amount_snapshot is not null
    and b.booking_fee_amount_snapshot > 0
    and b.booking_fee_rate_snapshot is not null
    and b.booking_fee_type_snapshot in ('flat', 'per_hour')
    and b.booking_fee_units_snapshot is not null
    and b.booking_fee_snapshot_source is not null
    and b.booking_fee_ledger_eligible_snapshot
    and b.weekly_fee_id is null
    and b.billed_at is null
    and not exists (
      select 1
      from public.weekly_fees wf
      where wf.status = 'paid'
        and coalesce(wf.billed_refs, '[]'::jsonb) @> jsonb_build_array(b.ref)
    )
    and not exists (
      select 1
      from public.booking_fee_remittance_items item
      where item.booking_ref = b.ref
        and item.released_at is null
    )
    and not exists (
      select 1
      from public.booking_payment_transfers transfer
      where b.ref = any(transfer.source_booking_refs)
    )
    and not exists (
      select 1
      from public.booking_fee_pre_remittance_releases release
      where release.booking_ref = b.ref
    )
  order by b.booking_fee_earned_at, b.created_at, b.ref
$$;

comment on function public.booking_fee_unclaimed_rows() is
  'Returns immutable unclaimed fee snapshots, excluding audited transferred-out and pre-remittance-released booking rows.';

-- One-time CHINO reconciliation. Fresh databases have no matching rows and
-- safely skip this block. If the known group exists with unexpected facts,
-- fail closed instead of applying a different financial correction.
do $$
declare
  affected_count integer;
  affected_amount numeric(12,2);
  active_item_count integer;
begin
  select
    count(*)::integer,
    coalesce(round(sum(b.booking_fee_amount_snapshot), 2), 0),
    count(item.id)::integer
    into affected_count, affected_amount, active_item_count
    from public.bookings b
    left join public.booking_fee_remittance_items item
      on item.booking_ref = b.ref and item.released_at is null
   where b.booking_group_ref = 'PB-MTVPNME6-1MQO-G';

  if affected_count > 0 then
    if affected_count <> 4 or affected_amount <> 240 or active_item_count <> 0 then
      raise exception 'Known CHINO cancellation no longer matches the audited 4-row/PHP 240 unremitted correction.'
        using errcode = '22000';
    end if;
    if exists (
      select 1 from public.bookings b
       where b.booking_group_ref = 'PB-MTVPNME6-1MQO-G'
         and (
           b.status <> 'cancelled'
           or b.payment_status <> 'rejected'
           or b.booking_fee_earned_at is null
           or coalesce(b.booking_fee_amount_snapshot, 0) <> 60
           or coalesce(b.booking_fee_units_snapshot, 0) <> 4
         )
    ) then
      raise exception 'Known CHINO cancellation status, payment, or immutable fee snapshots changed; no correction applied.'
        using errcode = '22000';
    end if;

    insert into public.booking_fee_pre_remittance_releases (
      release_ref,
      booking_ref,
      booking_group_ref,
      original_fee_amount,
      released_amount,
      fee_earned_at,
      fee_rate,
      fee_type,
      fee_units,
      fee_snapshot_source,
      terminal_booking_status,
      terminal_payment_status,
      release_source,
      reason,
      released_at,
      actor_role
    )
    select
      'REL-' || b.ref,
      b.ref,
      b.booking_group_ref,
      round(b.booking_fee_amount_snapshot, 2),
      -round(b.booking_fee_amount_snapshot, 2),
      b.booking_fee_earned_at,
      round(b.booking_fee_rate_snapshot, 2),
      b.booking_fee_type_snapshot,
      round(b.booking_fee_units_snapshot, 2),
      b.booking_fee_snapshot_source,
      b.status,
      b.payment_status,
      'one_time_reconciliation',
      'Audited correction: cancelled/rejected four-court booking retained no payment; release PHP 60 of the PHP 240 group total before remittance.',
      clock_timestamp(),
      'migration'
    from public.bookings b
    where b.booking_group_ref = 'PB-MTVPNME6-1MQO-G'
    on conflict (booking_ref) do nothing;
  end if;
end;
$$;

alter table public.booking_fee_pre_remittance_releases enable row level security;

drop policy if exists booking_fee_pre_releases_select_owner
  on public.booking_fee_pre_remittance_releases;
create policy booking_fee_pre_releases_select_owner
  on public.booking_fee_pre_remittance_releases
  for select to authenticated
  using (public.current_account_role() = 'owner');

revoke all on table public.booking_fee_pre_remittance_releases
  from public, anon, authenticated;
grant select on table public.booking_fee_pre_remittance_releases
  to authenticated;

revoke all on function public.prevent_booking_fee_pre_release_change()
  from public, anon, authenticated, service_role;
revoke all on function public.release_terminal_booking_fee_before_remittance()
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
