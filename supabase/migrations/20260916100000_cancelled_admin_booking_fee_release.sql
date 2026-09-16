-- Owner-created manual bookings remain billable while active, but an owner
-- cancellation releases their platform allocation before remittance even
-- though the admin booking was originally stamped as paid.

begin;

alter table public.booking_fee_pre_remittance_releases
  drop constraint if exists booking_fee_pre_release_terminal_check;
alter table public.booking_fee_pre_remittance_releases
  add constraint booking_fee_pre_release_terminal_check check (
    terminal_booking_status = 'cancelled'
    and terminal_payment_status in ('rejected', 'failed', 'unpaid', 'paid')
  );

alter table public.booking_fee_pre_remittance_releases
  drop constraint if exists booking_fee_pre_release_source_check;
alter table public.booking_fee_pre_remittance_releases
  add constraint booking_fee_pre_release_source_check check (
    release_source in (
      'automatic_terminal_transition',
      'automatic_admin_cancellation',
      'one_time_reconciliation'
    )
  );

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
  is_cancelled_admin_booking boolean := false;
begin
  is_cancelled_admin_booking := new.status = 'cancelled'
    and lower(coalesce(new.created_via, '')) = 'admin';

  if new.booking_fee_earned_at is null
     or coalesce(new.booking_fee_amount_snapshot, 0) <= 0
     or not coalesce(new.booking_fee_ledger_eligible_snapshot, false)
     or new.status <> 'cancelled'
     or (
       new.payment_status not in ('rejected', 'failed', 'unpaid')
       and lower(coalesce(new.created_via, '')) <> 'admin'
     ) then
    return new;
  end if;

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

  if is_cancelled_admin_booking then
    audit_reason := format(
      'Automatically released before remittance: admin-created booking was cancelled by an owner while recorded as %s.',
      coalesce(new.payment_status, 'unknown')
    );
  else
    audit_reason := format(
      'Automatically released before remittance: booking changed from %s/%s to cancelled/%s with no retained deposit.',
      coalesce(old.status, 'unknown'),
      coalesce(old.payment_status, 'unknown'),
      new.payment_status
    );
  end if;

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
    case when is_cancelled_admin_booking
      then 'automatic_admin_cancellation'
      else 'automatic_terminal_transition'
    end,
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

-- Re-run the release path for previously cancelled owner-created bookings.
-- The immutable release row makes this idempotent and preserves the earned
-- snapshot instead of erasing financial history.
update public.bookings b
   set status = b.status
 where b.status = 'cancelled'
   and lower(coalesce(b.created_via, '')) = 'admin'
   and b.booking_fee_earned_at is not null
   and coalesce(b.booking_fee_amount_snapshot, 0) > 0
   and coalesce(b.booking_fee_ledger_eligible_snapshot, false)
   and b.payment_reassigned_to_ref is null
   and not exists (
     select 1
       from public.booking_fee_pre_remittance_releases release
      where release.booking_ref = b.ref
   );

comment on function public.release_terminal_booking_fee_before_remittance() is
  'Creates immutable pre-remittance releases for cancelled no-payment bookings and cancelled owner-created manual bookings.';

comment on table public.booking_fee_pre_remittance_releases is
  'Append-only audit of earned booking fees released before remittance because payment failed or an owner-created manual booking was cancelled.';

commit;
