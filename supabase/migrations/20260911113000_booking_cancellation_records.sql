-- Durable, owner-authored reasons for manual booking cancellations.
begin;

create table public.booking_cancellation_records (
  id uuid primary key default gen_random_uuid(),
  booking_ref text not null,
  booking_group_ref text,
  booking_refs text[] not null check (cardinality(booking_refs) > 0),
  reason_code text not null check (reason_code in (
    'player_request','duplicate_mistake','payment_not_received',
    'court_unavailable','weather','incomplete_hold','other'
  )),
  note text,
  cancelled_by_user_id uuid not null,
  cancelled_by_name text not null,
  cancelled_by_role text not null check (cancelled_by_role in ('owner','court_owner')),
  cancelled_at timestamptz not null default clock_timestamp(),
  check (note is null or char_length(note) between 1 and 1000),
  check (reason_code <> 'other' or char_length(coalesce(note, '')) >= 5)
);

create index booking_cancellation_records_ref_time_idx
  on public.booking_cancellation_records (booking_ref, cancelled_at desc);
create index booking_cancellation_records_group_time_idx
  on public.booking_cancellation_records (booking_group_ref, cancelled_at desc)
  where booking_group_ref is not null;

alter table public.booking_cancellation_records enable row level security;
revoke all on public.booking_cancellation_records from public, anon, authenticated, service_role;
grant select on public.booking_cancellation_records to authenticated;
create policy booking_cancellation_records_admin_read
  on public.booking_cancellation_records for select to authenticated
  using (public.has_account_role(array['owner','court_owner']));

create function public.booking_cancellation_records_immutable()
returns trigger language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  raise exception 'Booking cancellation records are permanent.' using errcode='55000';
end $$;
create trigger booking_cancellation_records_no_update_delete
before update or delete on public.booking_cancellation_records
for each row execute function public.booking_cancellation_records_immutable();

create function public.cancel_booking_group(
  p_booking_ref text,
  p_reason_code text,
  p_note text default null
)
returns table(
  transitioned boolean,
  booking_ref text,
  booking_refs text[],
  cancellation_id uuid,
  cancelled_at timestamptz
)
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  requested_ref text := nullif(trim(coalesce(p_booking_ref,'')), '');
  reason_key text := lower(trim(coalesce(p_reason_code,'')));
  clean_note text := nullif(trim(coalesce(p_note,'')), '');
  observed_group_ref text;
  logical_key text;
  actual_refs text[];
  status_values text[];
  cancel_time timestamptz := clock_timestamp();
  actor_role text;
  actor_name text;
  record_id uuid;
  changed_rows integer := 0;
begin
  if requested_ref is null then
    raise exception 'A booking reference is required.' using errcode='22023';
  end if;
  if not public.has_account_role(array['owner','court_owner']) then
    raise exception 'Only an active owner or court owner can cancel a booking.' using errcode='42501';
  end if;
  actor_role := public.current_account_role();
  select coalesce(nullif(trim(a.full_name),''),nullif(trim(a.username),''),nullif(trim(a.email),''),'Administrator')
    into actor_name from public.accounts a where a.id=auth.uid();
  if actor_name is null then raise exception 'Active account identity was not found.' using errcode='42501'; end if;
  if reason_key not in ('player_request','duplicate_mistake','payment_not_received','court_unavailable','weather','incomplete_hold','other') then
    raise exception 'Choose a cancellation reason.' using errcode='22023';
  end if;
  if clean_note is not null and char_length(clean_note) > 1000 then
    raise exception 'Keep the cancellation note within 1000 characters.' using errcode='22023';
  end if;
  if reason_key = 'other' and char_length(coalesce(clean_note,'')) < 5 then
    raise exception 'Enter a short note when Other is selected.' using errcode='22023';
  end if;

  select nullif(trim(coalesce(b.booking_group_ref,'')), '') into observed_group_ref
    from public.bookings b where b.ref=requested_ref;
  if not found then raise exception 'Booking not found.' using errcode='P0002'; end if;
  logical_key := coalesce(observed_group_ref, requested_ref);

  perform pg_advisory_xact_lock_shared(hashtextextended('paddle-rage-pickleball-booking-fee-remittance',0));
  if observed_group_ref is not null then
    perform pg_advisory_xact_lock(hashtextextended('paddle-rage-public-booking-group:'||observed_group_ref,0));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('chino-booking-cancellation:'||logical_key,0));

  if observed_group_ref is null then
    perform 1 from public.bookings b where b.ref=requested_ref for update;
    select array[requested_ref] into actual_refs;
  else
    perform 1 from public.bookings b where b.booking_group_ref=observed_group_ref order by b.ref for update;
    select array_agg(b.ref order by b.ref) into actual_refs
      from public.bookings b where b.booking_group_ref=observed_group_ref;
  end if;
  if actual_refs is null or not (requested_ref=any(actual_refs)) then
    raise exception 'Booking scope changed while cancellation was starting.' using errcode='40001';
  end if;

  if exists(select 1 from public.bookings b where b.ref=any(actual_refs) and b.payment_reassigned_to_ref is not null) then
    raise exception 'A cancelled payment-transfer source must remain unchanged.' using errcode='22023';
  end if;
  select array_agg(distinct lower(trim(coalesce(b.status,'')))) into status_values
    from public.bookings b where b.ref=any(actual_refs);
  if status_values <@ array['cancelled']::text[] then
    select r.id,r.cancelled_at into record_id,cancel_time
      from public.booking_cancellation_records r
      where r.booking_ref=requested_ref or r.booking_group_ref=observed_group_ref
      order by r.cancelled_at desc limit 1;
    return query select false,requested_ref,actual_refs,record_id,cancel_time;
    return;
  end if;
  if exists(select 1 from public.bookings b where b.ref=any(actual_refs) and lower(trim(coalesce(b.status,''))) in ('completed','forfeited')) then
    raise exception 'Completed or forfeited bookings cannot be cancelled here.' using errcode='22023';
  end if;

  update public.bookings b set status='cancelled' where b.ref=any(actual_refs) and b.status<>'cancelled';
  get diagnostics changed_rows=row_count;
  if changed_rows < 1 then
    raise exception 'No booking was cancelled.' using errcode='40001';
  end if;

  insert into public.booking_cancellation_records(
    booking_ref,booking_group_ref,booking_refs,reason_code,note,
    cancelled_by_user_id,cancelled_by_name,cancelled_by_role,cancelled_at
  ) values (
    requested_ref,observed_group_ref,actual_refs,reason_key,clean_note,
    auth.uid(),actor_name,actor_role,cancel_time
  ) returning id into record_id;

  return query select true,requested_ref,actual_refs,record_id,cancel_time;
end $$;

revoke all on function public.cancel_booking_group(text,text,text) from public,anon,service_role;
grant execute on function public.cancel_booking_group(text,text,text) to authenticated;
comment on function public.cancel_booking_group(text,text,text) is
  'Atomically cancels one logical booking and saves an immutable owner-authored reason record.';

do $$ begin
  if to_regprocedure('public.admin_activity_register_table(regclass)') is not null then
    perform public.admin_activity_register_table('public.booking_cancellation_records'::regclass);
  end if;
end $$;

commit;
