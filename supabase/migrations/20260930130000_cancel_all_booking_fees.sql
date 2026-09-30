begin;

-- Cancellation voids the platform booking fee regardless of payment/source.
-- Keep immutable fee snapshots and settlement history for the audit trail.
alter table public.booking_fee_pre_remittance_releases
  drop constraint booking_fee_pre_release_terminal_check;
alter table public.booking_fee_pre_remittance_releases
  add constraint booking_fee_pre_release_terminal_check check (terminal_booking_status = 'cancelled');
alter table public.booking_fee_pre_remittance_releases
  drop constraint booking_fee_pre_release_source_check;
alter table public.booking_fee_pre_remittance_releases
  add constraint booking_fee_pre_release_source_check check (release_source in (
    'automatic_terminal_transition', 'automatic_admin_cancellation',
    'one_time_reconciliation', 'automatic_cancellation'
  ));
-- Automatic cancellation credits can originate from a customer/system action.
-- Direct ledger writes remain revoked; the existing owner RPC is unchanged.
alter table public.booking_fee_adjustments alter column created_by_user_id drop not null;
alter table public.booking_fee_adjustments drop constraint booking_fee_adjustments_actor_check;
alter table public.booking_fee_adjustments add constraint booking_fee_adjustments_actor_check
  check (created_by_role in ('owner', 'system'));

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
  credit_amount numeric(12,2);
begin
  if new.booking_fee_earned_at is null
     or coalesce(new.booking_fee_amount_snapshot, 0) <= 0
     or not coalesce(new.booking_fee_ledger_eligible_snapshot, false)
     or new.status <> 'cancelled'
     or new.payment_reassigned_to_ref is not null then
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

  if active_item.id is not null and (
    active_remittance.status not in ('prepared', 'payment_rejected')
    or coalesce(active_remittance.amount_settled, 0) <> 0
    or exists (
      select 1 from public.booking_fee_remittance_payments payment
      where payment.remittance_id = active_remittance.id
        and payment.status in ('pending', 'accepted', 'partially_accepted')
    )
  ) then
    -- Keep submitted/settled payment history. Offset its remaining fee exactly
    -- once through the existing signed credit ledger, including prior credits.
    perform pg_advisory_xact_lock(
      hashtextextended('paddle-rage-booking-fee-adjustment:' || new.ref, 0)
    );
    select greatest(0, round(active_item.fee_amount + coalesce(sum(a.amount), 0), 2))
      into credit_amount from public.booking_fee_adjustments a
      where a.booking_ref = new.ref;
    if credit_amount > 0 then
      insert into public.booking_fee_adjustments (
        adjustment_ref, booking_ref, booking_group_ref, source_remittance_id,
        adjustment_type, amount, reason, source_fee_amount, source_fee_earned_at,
        effective_at, created_by_user_id, created_by_role, idempotency_key
      ) values (
        'CANCEL-' || new.ref, new.ref, new.booking_group_ref, active_remittance.id,
        'correction_credit', -credit_amount,
        'Booking cancelled: reverse the remaining platform booking fee.',
        active_item.fee_amount, active_item.fee_earned_at,
        release_time, actor_id, 'system', 'cancel-booking-fee-' || new.ref
      ) on conflict (adjustment_ref) do nothing;
    end if;
    return new;
  end if;

  audit_reason := 'Booking cancelled: release the platform booking fee regardless of payment status or booking source.';

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
    'automatic_cancellation',
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


-- Reconcile existing cancellations using the same idempotent trigger.
update public.bookings b set status = b.status
where b.status = 'cancelled'
  and b.booking_fee_earned_at is not null
  and coalesce(b.booking_fee_amount_snapshot, 0) > 0
  and b.booking_fee_ledger_eligible_snapshot
  and b.payment_reassigned_to_ref is null
  and not exists (select 1 from public.booking_fee_pre_remittance_releases r where r.booking_ref = b.ref);

comment on function public.release_terminal_booking_fee_before_remittance() is
  'Cancelling a booking releases unremitted fees or records an offsetting credit for submitted/settled fees, independent of payment status and source.';
notify pgrst, 'reload schema';
commit;
