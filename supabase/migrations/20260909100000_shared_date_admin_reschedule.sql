-- Shared-date rescheduling with audited admin overrides. Guest rules are unchanged.
begin;
create table if not exists public.admin_booking_reschedule_history (
  id bigint generated always as identity primary key,
  booking_ref text not null references public.bookings(ref),
  actor_id uuid not null,
  created_at timestamptz not null default now(),
  reason text,
  old_schedule jsonb not null,
  new_schedule jsonb not null
);
alter table public.admin_booking_reschedule_history enable row level security;
revoke all on public.admin_booking_reschedule_history from public,anon,authenticated;
grant select on public.admin_booking_reschedule_history to authenticated;
create policy admin_reschedule_history_read on public.admin_booking_reschedule_history
  for select to authenticated using (public.has_account_role(array['owner','court_owner','staff']));
create trigger immutable_admin_reschedule_history before update or delete on public.admin_booking_reschedule_history
  for each row execute function public.deny_booking_reschedule_audit_mutation();

create or replace function public.admin_reschedule_booking_context(p_ref text)
returns public.bookings
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  booking public.bookings%rowtype;
  hours integer[];
begin
  if not public.has_account_role(array['owner','court_owner','staff']) then
    raise exception 'An active dashboard account is required.' using errcode='42501';
  end if;
  select b.* into booking from public.bookings b where b.ref=btrim(p_ref);
  if booking.ref is null then
    raise exception 'Booking not found.' using errcode='P0002';
  end if;
  if booking.status not in ('confirmed','pending','verifying','completed') then
    raise exception 'Cancelled or forfeited bookings cannot be rescheduled.' using errcode='23514';
  end if;
  if exists (select 1 from public.booking_reschedule_active_items a where a.booking_ref=booking.ref) then
    raise exception 'Review the pending reschedule request before moving this booking.' using errcode='23514';
  end if;
  if coalesce(cardinality(booking.slots),0)<1 or cardinality(booking.slots)>24
     or exists(select 1 from unnest(booking.slots) s where s is null or s !~ '^(?:[0-9]|1[0-9]|2[0-3])$') then
    raise exception 'The original booking has invalid time slots.' using errcode='23514';
  end if;
  select array_agg(s::integer order by s::integer) into hours from unnest(booking.slots) s;
  if (select count(distinct h) from unnest(hours) h)<>cardinality(hours)
     or hours[cardinality(hours)]-hours[1]+1<>cardinality(hours)
     or coalesce(booking.duration,cardinality(hours))<>cardinality(hours) then
    raise exception 'The original booking must have a continuous, valid duration.' using errcode='23514';
  end if;
  return booking;
end;
$$;
revoke all on function public.admin_reschedule_booking_context(text) from public,anon,authenticated;


create or replace function public.reschedule_bookings_transaction(
  p_ref text,
  p_changes jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  anchor public.bookings%rowtype;
  locked_anchor public.bookings%rowtype;
  booking public.bookings%rowtype;
  family_key text;
  family_refs text[];
  selected_refs text[];
  requested_change jsonb;
  normalized_changes jsonb := '[]'::jsonb;
  original_slots integer[];
  expected_slots integer[];
  candidate_slots text[];
  requested_date date;
  requested_start integer;
  duration_hours integer;
  lock_key text;
  updated_count integer;
  move_reason text;
begin
  if not public.has_account_role(array['owner','court_owner','staff']) then
    raise exception 'An active dashboard account is required.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception 'Choose between one and eight booking items.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_changes) not between 1 and 8 then
    raise exception 'Choose between one and eight booking items.' using errcode = '22023';
  end if;

  -- Validate JSON types before casts or array operations. Every schedule carries
  -- its original snapshot, so a changed child invalidates the complete batch.
  for requested_change in select value from jsonb_array_elements(p_changes) loop
    if jsonb_typeof(requested_change) is distinct from 'object'
       or jsonb_typeof(requested_change->'bookingRef') is distinct from 'string'
       or nullif(btrim(requested_change->>'bookingRef'), '') is null
       or jsonb_typeof(requested_change->'date') is distinct from 'string'
       or requested_change->>'date' !~ '^\d{4}-\d{2}-\d{2}$'
       or jsonb_typeof(requested_change->'startHour') is distinct from 'number'
       or requested_change->>'startHour' !~ '^(?:[0-9]|1[0-9]|2[0-3])$'
       or jsonb_typeof(requested_change->'expectedDate') is distinct from 'string'
       or requested_change->>'expectedDate' !~ '^\d{4}-\d{2}-\d{2}$'
       or jsonb_typeof(requested_change->'expectedCourtId') is distinct from 'string'
       or nullif(btrim(requested_change->>'expectedCourtId'), '') is null
       or jsonb_typeof(requested_change->'expectedSlots') is distinct from 'array' then
      raise exception 'Each booking needs a complete valid schedule and original snapshot.' using errcode = '22023';
    end if;
    if jsonb_array_length(requested_change->'expectedSlots') not between 1 and 24
       or exists (
         select 1 from jsonb_array_elements(requested_change->'expectedSlots') slot(value)
         where jsonb_typeof(slot.value) not in ('number','string')
            or (slot.value #>> '{}') !~ '^(?:[0-9]|1[0-9]|2[0-3])$'
       ) then
      raise exception 'The original time slots are invalid.' using errcode = '22023';
    end if;
  end loop;
  select array_agg(btrim(value->>'bookingRef') order by btrim(value->>'bookingRef'))
  into selected_refs from jsonb_array_elements(p_changes);
  if (select count(distinct ref) from unnest(selected_refs) ref) <> cardinality(selected_refs) then
    raise exception 'A booking item can be selected only once.' using errcode = '22023';
  end if;

  select b.* into anchor from public.bookings b where b.ref = btrim(p_ref);
  if anchor.ref is null then
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;
  family_key := coalesce(nullif(btrim(anchor.booking_group_ref), ''), anchor.ref);
  -- Share the family lock with guest submissions, withdrawals, reviews and
  -- individual manual moves before taking booking-row locks in the same order.
  perform pg_advisory_xact_lock(hashtextextended('paddle-rage-reschedule-family|' || family_key, 0));
  select array_agg(b.ref order by b.ref) into family_refs
  from public.bookings b
  where (
    nullif(btrim(anchor.booking_group_ref), '') is null and b.ref = anchor.ref
  ) or (
    nullif(btrim(anchor.booking_group_ref), '') is not null
    and b.booking_group_ref = anchor.booking_group_ref
  );
  if coalesce(cardinality(family_refs), 0) not between 1 and 8
     or not (selected_refs <@ family_refs) then
    raise exception 'Select only items from this booking transaction, up to eight items.' using errcode = '22023';
  end if;
  perform b.ref from public.bookings b
  where b.ref = any(family_refs)
  order by b.ref for update;
  select b.* into locked_anchor from public.bookings b where b.ref = anchor.ref;
  if locked_anchor.ref is null
     or locked_anchor.booking_group_ref is distinct from anchor.booking_group_ref then
    raise exception 'The booking transaction changed. Reopen rescheduling.' using errcode = '40001';
  end if;

  for requested_change in
    select value from jsonb_array_elements(p_changes) order by btrim(value->>'bookingRef')
  loop
    -- This rechecks active account/status, valid paid duration and pending guest
    -- requests after the family and row locks have been acquired.
    booking := public.admin_reschedule_booking_context(btrim(requested_change->>'bookingRef'));
    if (nullif(btrim(anchor.booking_group_ref), '') is null and booking.ref <> anchor.ref)
       or (nullif(btrim(anchor.booking_group_ref), '') is not null
           and booking.booking_group_ref is distinct from anchor.booking_group_ref) then
      raise exception 'A selected item no longer belongs to this booking transaction.' using errcode = '40001';
    end if;
    select array_agg(s::integer order by s::integer) into original_slots from unnest(booking.slots) s;
    select array_agg(s::integer order by s::integer) into expected_slots
    from jsonb_array_elements_text(requested_change->'expectedSlots') s;
    if (requested_change->>'expectedDate')::date is distinct from booking.date
       or requested_change->>'expectedCourtId' is distinct from booking.court_id
       or expected_slots is distinct from original_slots then
      raise exception 'An original schedule changed. Reopen rescheduling. Nothing was moved.' using errcode = '40001';
    end if;
    move_reason := nullif(btrim(requested_change->>'reason'), '');
    if length(coalesce(move_reason,'')) > 1000 then
      raise exception 'Keep the reason within 1000 characters.' using errcode='22023';
    end if;
    if (booking.status='completed' or public.booking_start_at_ph(booking.date,booking.start_time,booking.slots)<=statement_timestamp())
       and length(coalesce(move_reason,''))<5 then
      raise exception 'A reason is required to move a started or finished booking.' using errcode='22023';
    end if;
    requested_date := (requested_change->>'date')::date;
    requested_start := (requested_change->>'startHour')::integer;
    duration_hours := cardinality(original_slots);
    if requested_date < greatest(public.court_opening_date(), timezone('Asia/Manila', statement_timestamp())::date)
       or requested_date > timezone('Asia/Manila', statement_timestamp())::date + 366
       or requested_start + duration_hours > 24 then
      raise exception 'Choose a complete available time slot within the booking calendar.' using errcode = '22023';
    end if;
    if requested_date = booking.date and requested_start = original_slots[1] then
      raise exception 'Choose a different schedule for every selected booking item.' using errcode = '22023';
    end if;
    select array_agg(h::text order by h) into candidate_slots
    from generate_series(requested_start, requested_start + duration_hours - 1) h;
    normalized_changes := normalized_changes || jsonb_build_array(jsonb_build_object(
      'bookingRef', booking.ref, 'courtId', booking.court_id,
      'date', requested_date, 'slots', candidate_slots,
      'startTime', public.booking_reschedule_hour_label(requested_start),
      'endTime', public.booking_reschedule_hour_label(requested_start + duration_hours),
      'duration', duration_hours, 'oldDate', booking.date, 'oldSlots', original_slots,
      'oldStartTime', booking.start_time, 'oldEndTime', booking.end_time,
      'reason', move_reason, 'oldStatus', booking.status
    ));
  end loop;

  if (select count(distinct value->>'date') from jsonb_array_elements(normalized_changes))>1 then
    raise exception 'Choose one shared date for all selected courts.' using errcode='22023';
  end if;
  if (select count(distinct value->>'duration') from jsonb_array_elements(normalized_changes))=1
     and (select count(distinct value->>'startTime') from jsonb_array_elements(normalized_changes))>1 then
    raise exception 'Choose one shared time for courts with matching durations.' using errcode='22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(normalized_changes) change(value)
    cross join lateral jsonb_array_elements_text(change.value->'slots') slot(value)
    group by change.value->>'courtId', change.value->>'date', slot.value
    having count(*) > 1
  ) then
    raise exception 'Selected booking items overlap on the same court. Nothing was moved.' using errcode = '23P01';
  end if;

  -- Acquire all destination keys globally, matching the existing occupancy
  -- trigger and guest approval order, before revalidating or updating any item.
  for lock_key in
    select distinct (change.value->>'courtId') || '|' || (change.value->>'date') || '|' || slot.value as key
    from jsonb_array_elements(normalized_changes) change(value)
    cross join lateral jsonb_array_elements_text(change.value->'slots') slot(value)
    order by key
  loop
    perform pg_advisory_xact_lock(hashtextextended('paddle-rage-booking-slot|' || lock_key, 0));
  end loop;
  for requested_change in select value from jsonb_array_elements(normalized_changes) loop
    select array_agg(value) into candidate_slots from jsonb_array_elements_text(requested_change->'slots');
    -- Keep availability identical to the per-item picker: another selected
    -- item's original reservation remains occupied. This intentionally excludes
    -- swaps and avoids intermediate conflicts without weakening the trigger.
    if not public.booking_reschedule_schedule_available(
      requested_change->>'courtId', (requested_change->>'date')::date,
      candidate_slots, array[requested_change->>'bookingRef']
    ) then
      raise exception 'A selected time is no longer available. Choose another slot. Nothing was moved.' using errcode = '23P01';
    end if;
  end loop;

  update public.bookings booking_row
  set date = (change.value->>'date')::date,
      slots = array(select value from jsonb_array_elements_text(change.value->'slots')),
      start_time = change.value->>'startTime',
      end_time = change.value->>'endTime',
      duration = (change.value->>'duration')::integer,
      status = case when booking_row.status='completed' then 'confirmed' else booking_row.status end
  from jsonb_array_elements(normalized_changes) change(value)
  where booking_row.ref = change.value->>'bookingRef';
  get diagnostics updated_count = row_count;
  if updated_count <> cardinality(selected_refs) then
    raise exception 'The complete selection could not be moved. Nothing was moved.' using errcode = '40001';
  end if;
  insert into public.admin_booking_reschedule_history(booking_ref,actor_id,reason,old_schedule,new_schedule)
  select value->>'bookingRef',auth.uid(),value->>'reason',
    jsonb_build_object('date',value->>'oldDate','slots',value->'oldSlots','status',value->>'oldStatus'),
    jsonb_build_object('date',value->>'date','slots',value->'slots')
  from jsonb_array_elements(normalized_changes);
  return jsonb_build_object('bookingRef', anchor.ref, 'items', normalized_changes);
end;
$$;

revoke all on function public.reschedule_bookings_transaction(text,jsonb) from public,anon;
grant execute on function public.reschedule_bookings_transaction(text,jsonb) to authenticated;
comment on function public.reschedule_bookings_transaction(text,jsonb) is
  'Atomically moves one to eight selected items from one genuine booking family, preserving each court, paid duration and payments; current sibling reservations remain occupied.';


create or replace function public.reschedule_booking_transaction(
  p_ref text,p_date date,p_start_hour integer,p_expected_date date,p_expected_slots integer[],p_expected_court_id text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
  result:=public.reschedule_bookings_transaction(p_ref,jsonb_build_array(jsonb_build_object(
    'bookingRef',p_ref,'date',p_date,'startHour',p_start_hour,
    'expectedDate',p_expected_date,'expectedSlots',p_expected_slots,'expectedCourtId',p_expected_court_id)));
  return result->'items'->0;
end;
$$;
revoke all on function public.reschedule_booking_transaction(text,date,integer,date,integer[],text) from public,anon;
grant execute on function public.reschedule_booking_transaction(text,date,integer,date,integer[],text) to authenticated;

commit;
