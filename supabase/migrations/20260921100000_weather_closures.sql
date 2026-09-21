-- Weather closures and single-use, payment-preserving replacement bookings.
begin;

alter table public.bookings add column if not exists weather_affected boolean not null default false;

create table public.weather_closures (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  reason text not null check (reason in ('rain','wet_court','unsafe_weather')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  reopened_at timestamptz,
  reopened_by uuid,
  request_key uuid not null unique
);
create table public.weather_closure_slots (
  closure_id uuid not null references public.weather_closures(id),
  court_id text not null,
  date date not null,
  hour integer not null check (hour between 0 and 23),
  active boolean not null default true,
  primary key (closure_id,court_id,hour)
);
create unique index weather_active_slot on public.weather_closure_slots(court_id,date,hour) where active;
create table public.weather_replacements (
  id uuid primary key default gen_random_uuid(),
  closure_id uuid not null references public.weather_closures(id),
  family_key text not null,
  customer_email text,
  customer_name text not null,
  access_token text not null default encode(extensions.gen_random_bytes(32),'hex'),
  created_at timestamptz not null default now(),
  unique (closure_id,family_key),
  unique (access_token)
);
create table public.weather_replacement_items (
  id uuid primary key default gen_random_uuid(),
  replacement_id uuid not null references public.weather_replacements(id),
  booking_ref text not null,
  court_id text not null,
  court_name text,
  old_date date not null,
  old_slots text[] not null,
  duration integer not null check (duration between 1 and 24),
  status text not null default 'pending' check (status in ('pending','completed','superseded')),
  new_date date,
  new_slots text[],
  completed_at timestamptz,
  applied_transaction bigint,
  unique (replacement_id,booking_ref)
);
create unique index weather_one_pending_replacement on public.weather_replacement_items(booking_ref) where status='pending';
create table public.weather_email_outbox (
  id uuid primary key default gen_random_uuid(),
  replacement_id uuid not null references public.weather_replacements(id),
  item_id uuid references public.weather_replacement_items(id),
  kind text not null check (kind in ('invitation','confirmation')),
  status text not null default 'pending' check (status in ('pending','sending','sent','failed')),
  attempts integer not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  available_at timestamptz not null default now(),
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
create unique index weather_invitation_once on public.weather_email_outbox(replacement_id) where kind='invitation';
create unique index weather_confirmation_once on public.weather_email_outbox(item_id) where kind='confirmation';

alter table public.weather_closures enable row level security;
alter table public.weather_closure_slots enable row level security;
alter table public.weather_replacements enable row level security;
alter table public.weather_replacement_items enable row level security;
alter table public.weather_email_outbox enable row level security;
revoke all on public.weather_closures,public.weather_closure_slots,public.weather_replacements,public.weather_replacement_items,public.weather_email_outbox from public,anon,authenticated;
grant select,update on public.weather_email_outbox to service_role;
grant select on public.weather_replacements,public.weather_replacement_items,public.weather_closures to service_role;

create function public.get_public_weather_closures()
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('courtId',s.court_id,'date',s.date,'hour',s.hour,'reason',c.reason) order by s.date,s.court_id,s.hour),'[]'::jsonb)
  from public.weather_closure_slots s join public.weather_closures c on c.id=s.closure_id
  where s.active and s.date>=timezone('Asia/Manila',now())::date and s.date<=timezone('Asia/Manila',now())::date+366;
$$;

create function public.get_weather_desk(p_date date)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  if public.booking_reschedule_operator_role() is null then raise exception 'Only an active owner can manage weather closures.' using errcode='42501'; end if;
  if p_date is null or p_date<timezone('Asia/Manila',now())::date-30 or p_date>timezone('Asia/Manila',now())::date+366 then raise exception 'Choose a date within the booking calendar.'; end if;
  return jsonb_build_object(
    'date',p_date,
    'courts',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) order by name),'[]') from public.courts),
    'openHour',(select value::integer from public.settings where key='open_hour'),
    'closeHour',(select value::integer from public.settings where key='close_hour'),
    'bookings',(select coalesce(jsonb_agg(jsonb_build_object('ref',ref,'groupRef',booking_group_ref,'name',full_name,'email',email,'courtId',court_id,'slots',slots,'status',status,'weatherAffected',weather_affected)),'[]') from public.bookings where date=p_date and public.booking_occupies_slot(status,email,full_name,created_at)),
    'slots',(select coalesce(jsonb_agg(jsonb_build_object('courtId',court_id,'hour',hour,'closureId',closure_id)),'[]') from public.weather_closure_slots where date=p_date and active),
    'closures',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'reason',c.reason,'createdAt',c.created_at,'reopenedAt',c.reopened_at,'slots',(select count(*) from public.weather_closure_slots s where s.closure_id=c.id and active)) order by c.created_at desc),'[]') from public.weather_closures c where date=p_date),
    'replacements',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'name',r.customer_name,'email',r.customer_email,'family',r.family_key,'pending',(select count(*) from public.weather_replacement_items i where i.replacement_id=r.id and status='pending'),'emailStatus',(select status from public.weather_email_outbox o where o.replacement_id=r.id and kind='invitation'),'emailError',(select last_error from public.weather_email_outbox o where o.replacement_id=r.id and kind='invitation')) order by r.created_at desc),'[]') from public.weather_replacements r join public.weather_closures c on c.id=r.closure_id where c.date=p_date)
  );
end;
$$;

create function public.create_weather_closure(p_date date,p_slots jsonb,p_reason text,p_request_key uuid,p_expected_refs text[])
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare closure uuid; slot record; b public.bookings%rowtype; replacement uuid; refs text[]; expected text[]; family text; count_items integer:=0;
begin
  if public.booking_reschedule_operator_role() is null then raise exception 'Only an active owner can close courts.' using errcode='42501'; end if;
  if p_request_key is null then raise exception 'A request identifier is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('chino-weather-request|'||p_request_key::text,0));
  select id into closure from public.weather_closures where request_key=p_request_key;
  if closure is not null then return jsonb_build_object('id',closure,'repeated',true); end if;
  if p_date is null or p_date<timezone('Asia/Manila',now())::date or p_date>timezone('Asia/Manila',now())::date+366
    or p_reason is null or p_reason not in ('rain','wet_court','unsafe_weather')
    or jsonb_typeof(p_slots) is distinct from 'array' then raise exception 'Choose a valid date, reason and time slots.'; end if;
  if jsonb_array_length(p_slots) not between 1 and 240 or exists(select 1 from jsonb_array_elements(p_slots) s where coalesce(s->>'hour','') !~ '^(?:[0-9]|1[0-9]|2[0-3])$' or not exists(select 1 from public.courts c where c.id=s->>'courtId')) then raise exception 'Choose valid court time slots.'; end if;
  -- Row locks before slot locks match booking UPDATE ordering. New inserts
  -- serialize on the same slot locks; the affected list is re-read afterwards.
  perform pg_advisory_xact_lock_shared(hashtextextended('paddle-rage-pickleball-booking-fee-remittance',0));
  perform b0.ref from public.bookings b0 where b0.date=p_date order by b0.ref for update;
  for slot in select distinct s->>'courtId' court_id,s->>'hour' slot_hour from jsonb_array_elements(p_slots) s order by 1,2 loop
    perform pg_advisory_xact_lock(hashtextextended('paddle-rage-booking-slot|'||slot.court_id||'|'||p_date::text||'|'||slot.slot_hour,0));
  end loop;
  if exists(select 1 from public.weather_closure_slots w join jsonb_array_elements(p_slots) s on w.court_id=s->>'courtId' and w.hour=(s->>'hour')::integer where w.date=p_date and w.active) then raise exception 'A selected slot is already closed. Refresh the schedule.'; end if;
  select coalesce(array_agg(distinct b0.ref order by b0.ref),'{}') into refs from public.bookings b0
  where b0.date=p_date and b0.status in ('confirmed','pending','verifying')
    and public.booking_occupies_slot(b0.status,b0.email,b0.full_name,b0.created_at)
    and exists(select 1 from jsonb_array_elements(p_slots) s where s->>'courtId'=b0.court_id and (s->>'hour')=any(b0.slots));
  select coalesce(array_agg(distinct x order by x),'{}') into expected from unnest(coalesce(p_expected_refs,'{}')) x;
  if refs is distinct from expected then raise exception 'Bookings changed since your review. Refresh and review the affected bookings again.' using errcode='40001'; end if;
  insert into public.weather_closures(date,reason,created_by,request_key) values(p_date,p_reason,auth.uid(),p_request_key) returning id into closure;
  insert into public.weather_closure_slots(closure_id,court_id,date,hour) select distinct closure,s->>'courtId',p_date,(s->>'hour')::integer from jsonb_array_elements(p_slots) s;
  for b in select * from public.bookings where ref=any(refs) order by ref loop
    -- Temporary anonymous checkout holds have no player to notify.
    if lower(coalesce(b.email,''))='reserve@hold.internal' then continue; end if;
    if exists(select 1 from public.weather_replacement_items where booking_ref=b.ref and status='pending') then continue; end if;
    family:=coalesce(nullif(b.booking_group_ref,''),b.ref);
    insert into public.weather_replacements(closure_id,family_key,customer_email,customer_name)
      values(closure,family,lower(trim(coalesce(b.email,b.host_email,''))),b.full_name)
      on conflict(closure_id,family_key) do update set family_key=excluded.family_key returning id into replacement;
    if exists(select 1 from public.weather_replacements where id=replacement and customer_email is distinct from lower(trim(coalesce(b.email,b.host_email,'')))) then raise exception 'This booking group contains different player email addresses. Correct the group before applying a closure.'; end if;
    insert into public.weather_replacement_items(replacement_id,booking_ref,court_id,court_name,old_date,old_slots,duration)
      values(replacement,b.ref,b.court_id,b.court_name,b.date,b.slots,cardinality(b.slots));
    update public.bookings set weather_affected=true,balance_due_at=null where ref=b.ref;
    insert into public.weather_email_outbox(replacement_id,kind) values(replacement,'invitation') on conflict do nothing;
    count_items:=count_items+1;
  end loop;
  insert into public.settings(key,value) values('weather_closure_revision',clock_timestamp()::text) on conflict(key) do update set value=excluded.value;
  return jsonb_build_object('id',closure,'affectedBookings',count_items);
end;
$$;

create function public.reopen_weather_closure(p_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if public.booking_reschedule_operator_role() is null then raise exception 'Only an active owner can reopen courts.' using errcode='42501'; end if;
  update public.weather_closures set reopened_at=now(),reopened_by=auth.uid() where id=p_id and reopened_at is null;
  update public.weather_closure_slots set active=false where closure_id=p_id;
  insert into public.settings(key,value) values('weather_closure_revision',clock_timestamp()::text) on conflict(key) do update set value=excluded.value;
  -- Replacement rights survive reopening; existing reservations stay protected.
end;
$$;

create function public.weather_replacement_context(p_token text)
returns uuid language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result uuid;
begin
  if coalesce(p_token,'') !~ '^[0-9a-f]{64}$' then raise exception 'This rescheduling link is invalid. Please contact CHINO.' using errcode='42501'; end if;
  select id into result from public.weather_replacements where access_token=p_token;
  if result is null then raise exception 'This rescheduling link is invalid. Please contact CHINO.' using errcode='42501'; end if;
  return result;
end;
$$;

create function public.get_weather_replacement(p_token text)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare replacement uuid;
begin
  replacement:=public.weather_replacement_context(p_token);
  return (select jsonb_build_object('name',r.customer_name,'reference',r.family_key,'reason',c.reason,
    'items',(select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'ref',i.booking_ref,'court',i.court_name,'oldDate',i.old_date,'oldSlots',i.old_slots,'duration',i.duration,'status',i.status,'newDate',i.new_date,'newSlots',i.new_slots,'balance',greatest(coalesce(b.total,0)-coalesce(b.downpayment,0),0)) order by i.booking_ref),'[]') from public.weather_replacement_items i left join public.bookings b on b.ref=i.booking_ref where i.replacement_id=r.id))
    from public.weather_replacements r join public.weather_closures c on c.id=r.closure_id where r.id=replacement);
end;
$$;

create function public.get_weather_replacement_options(p_token text,p_item_id uuid,p_date date)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare replacement uuid; item public.weather_replacement_items%rowtype; h integer; slots text[]; starts integer[]:='{}';
begin
  replacement:=public.weather_replacement_context(p_token);
  select * into item from public.weather_replacement_items where id=p_item_id and replacement_id=replacement and status='pending';
  if item.id is null then raise exception 'This booking has already been handled. Refresh this page.'; end if;
  if p_date is null or p_date<greatest(public.court_opening_date(),timezone('Asia/Manila',now())::date) or p_date>timezone('Asia/Manila',now())::date+366 then raise exception 'Choose a date within the next year.'; end if;
  if not exists(select 1 from public.bookings b where b.ref=item.booking_ref and b.date=item.old_date and b.slots=item.old_slots and b.court_id=item.court_id and b.weather_affected and b.status in ('confirmed','pending','verifying')) then raise exception 'Your booking changed. Contact CHINO for help with your replacement.'; end if;
  for h in 0..24-item.duration loop
    select array_agg(v::text order by v) into slots from generate_series(h,h+item.duration-1) v;
    if not (p_date=item.old_date and slots=item.old_slots) and public.booking_reschedule_schedule_available(item.court_id,p_date,slots,array[item.booking_ref]) then starts:=array_append(starts,h); end if;
  end loop;
  return jsonb_build_object('date',p_date,'starts',starts,'duration',item.duration);
end;
$$;

create function public.confirm_weather_replacement(p_token text,p_item_id uuid,p_date date,p_start integer)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare replacement uuid; item public.weather_replacement_items%rowtype; b public.bookings%rowtype; candidate_slots text[]; h text; family text;
begin
  replacement:=public.weather_replacement_context(p_token);
  select family_key into family from public.weather_replacements where id=replacement;
  perform pg_advisory_xact_lock_shared(hashtextextended('paddle-rage-pickleball-booking-fee-remittance',0));
  perform pg_advisory_xact_lock(hashtextextended('paddle-rage-reschedule-family|'||family,0));
  select * into item from public.weather_replacement_items where id=p_item_id and replacement_id=replacement;
  if item.id is null then raise exception 'This booking is not part of your weather replacement.' using errcode='42501'; end if;
  select * into b from public.bookings where ref=item.booking_ref for update;
  select * into item from public.weather_replacement_items where id=p_item_id for update;
  if item.status='completed' then return public.get_weather_replacement(p_token); end if;
  if item.status<>'pending' or b.ref is null or b.date is distinct from item.old_date or b.slots is distinct from item.old_slots or b.court_id is distinct from item.court_id or not b.weather_affected or b.status not in ('confirmed','pending','verifying') then raise exception 'Your booking changed. Contact CHINO for help.'; end if;
  if p_start is null or p_start<0 or p_start+item.duration>24 then raise exception 'Choose a complete available time slot.'; end if;
  select array_agg(v::text order by v) into candidate_slots from generate_series(p_start,p_start+item.duration-1) v;
  for h in select v from unnest(candidate_slots) v order by v loop
    perform pg_advisory_xact_lock(hashtextextended('paddle-rage-booking-slot|'||item.court_id||'|'||p_date::text||'|'||h,0));
  end loop;
  if (p_date=item.old_date and candidate_slots=item.old_slots) or not public.booking_reschedule_schedule_available(item.court_id,p_date,candidate_slots,array[item.booking_ref]) then raise exception 'That time is no longer available. Please choose another slot.' using errcode='23P01'; end if;
  -- Complete the entitlement before the booking update, within one transaction.
  -- Other schedule edits supersede pending entitlements in the guard below.
  update public.weather_replacement_items set status='completed',new_date=p_date,new_slots=candidate_slots,completed_at=now(),applied_transaction=txid_current() where id=item.id;
  update public.bookings set date=p_date,slots=candidate_slots,start_time=public.booking_reschedule_hour_label(p_start),end_time=public.booking_reschedule_hour_label(p_start+item.duration),weather_affected=false where ref=b.ref;
  insert into public.weather_email_outbox(replacement_id,item_id,kind) values(replacement,item.id,'confirmation') on conflict do nothing;
  return public.get_weather_replacement(p_token);
end;
$$;

-- Enforce weather blocks for every booking writer, including stale public pages.
create function public.guard_booking_weather()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare h text;
begin
  if tg_op='UPDATE' then
    if old.weather_affected and new.status='forfeited' then raise exception 'Resolve the weather replacement before forfeiting this booking.' using errcode='40001'; end if;
    if new.date is distinct from old.date or new.slots is distinct from old.slots or new.court_id is distinct from old.court_id or new.status in ('cancelled','forfeited','completed') then
      update public.weather_replacement_items set status='superseded',completed_at=now() where booking_ref=old.ref and status='pending';
      new.weather_affected:=false;
    end if;
    if (old.weather_affected or (new.weather_affected and exists(select 1 from public.weather_replacement_items where booking_ref=new.ref and status='pending' and old_date=new.date and old_slots=new.slots))) and new.date is not distinct from old.date and new.slots is not distinct from old.slots and new.court_id is not distinct from old.court_id and public.booking_occupies_slot(old.status,old.email,old.full_name,old.created_at) then return new; end if;
  end if;
  if not public.booking_occupies_slot(new.status,new.email,new.full_name,new.created_at) then return new; end if;
  for h in select v from unnest(new.slots) v order by v loop
    perform pg_advisory_xact_lock(hashtextextended('paddle-rage-booking-slot|'||new.court_id||'|'||new.date::text||'|'||h,0));
  end loop;
  if exists(select 1 from public.weather_closure_slots where active and court_id=new.court_id and date=new.date and hour::text=any(new.slots)) then raise exception 'This court is closed due to weather. Please choose another time.' using errcode='23P01'; end if;
  return new;
end;
$$;
create trigger a05_guard_booking_weather before insert or update on public.bookings for each row execute function public.guard_booking_weather();

-- A player may change only the exact schedule redeemed by the private RPC in
-- this transaction. Payment, identity, status and ownership remain immutable.
create function public.weather_authorized_booking_move(p_old public.bookings,p_new public.bookings)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select (to_jsonb(p_old)-array['date','slots','start_time','end_time','weather_affected'])
       = (to_jsonb(p_new)-array['date','slots','start_time','end_time','weather_affected'])
    and (p_old).weather_affected and not (p_new).weather_affected
    and exists(select 1 from public.weather_replacement_items i where i.booking_ref=(p_old).ref and i.status='completed'
      and i.applied_transaction=txid_current() and i.old_date=(p_old).date and i.old_slots=(p_old).slots
      and i.new_date=(p_new).date and i.new_slots=(p_new).slots and i.court_id=(p_new).court_id);
$$;
revoke all on function public.weather_authorized_booking_move(public.bookings,public.bookings) from public,anon,authenticated;
do $migration$
declare definition text;
begin
  definition:=pg_get_functiondef('public.guard_public_booking_hold_update()'::regprocedure);
  definition:=regexp_replace(definition,'(?i)\mbegin\M',E'begin\n  if public.weather_authorized_booking_move(old,new) then return new; end if;\n');
  if position('weather_authorized_booking_move' in definition)=0 then raise exception 'Booking guard patch did not apply.'; end if;
  execute definition;
end;
$migration$;

-- Existing availability checks retain their operating-hours, maintenance,
-- occupancy and Open Play rules, with weather checked first.
do $migration$
declare definition text;
begin
  definition:=pg_get_functiondef('public.booking_reschedule_schedule_available(text,date,text[],text[])'::regprocedure);
  definition:=regexp_replace(definition,'(?i)\mbegin\M',E'begin\n  if exists(select 1 from public.weather_closure_slots where active and court_id=p_court_id and date=p_date and hour::text=any(p_slots)) then return false; end if;\n');
  if position('public.weather_closure_slots' in definition)=0 then raise exception 'Availability function patch did not apply.'; end if;
  execute definition;
end;
$migration$;

-- Pause host balance deadlines while a weather replacement is outstanding.
do $migration$
declare definition text;
begin
  definition:=pg_get_functiondef('public.set_host_balance_deadline()'::regprocedure);
  definition:=regexp_replace(definition,'(?i)\mbegin\M',E'begin\n  if new.weather_affected then new.balance_due_at:=null; return new; end if;\n');
  if position('new.weather_affected' in definition)=0 then raise exception 'Balance deadline patch did not apply.'; end if;
  execute definition;
end;
$migration$;
drop trigger if exists trg_set_host_balance_deadline on public.bookings;
create trigger trg_set_host_balance_deadline before insert or update of date,start_time,slots,host_booking,weather_affected on public.bookings for each row execute function public.set_host_balance_deadline();
do $migration$
declare definition text;
begin
  definition:=pg_get_functiondef('public.forfeit_overdue_host_booking(text)'::regprocedure);
  definition:=replace(definition,'or inconsistent.status', 'or inconsistent.weather_affected or inconsistent.status');
  if position('inconsistent.weather_affected' in definition)=0 then raise exception 'Group balance protection patch did not apply.'; end if;
  execute definition;
end;
$migration$;

create function public.retry_weather_email(p_replacement_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if public.booking_reschedule_operator_role() is null then raise exception 'Only an owner can resend a notification.' using errcode='42501'; end if;
  update public.weather_email_outbox set status='pending',attempts=0,available_at=now(),last_error=null
    where replacement_id=p_replacement_id and kind='invitation' and status in ('failed','sent') and (sent_at is null or sent_at<now()-interval '1 minute');
end;
$$;
create function public.get_weather_owner_link(p_replacement_id uuid)
returns text language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  if public.booking_reschedule_operator_role() is null then raise exception 'Only an owner can access a private player link.' using errcode='42501'; end if;
  return (select access_token from public.weather_replacements where id=p_replacement_id);
end;
$$;
create function public.claim_weather_emails()
returns setof public.weather_email_outbox language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Notification worker only.' using errcode='42501'; end if;
  return query update public.weather_email_outbox o set status='sending',attempts=o.attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes'
    where o.id in (select id from public.weather_email_outbox where attempts<10 and ((status in ('pending','failed') and available_at<=now()) or (status='sending' and lease_until<now())) order by created_at for update skip locked limit 4) returning o.*;
end;
$$;

revoke all on function public.get_public_weather_closures(),public.get_weather_desk(date),public.create_weather_closure(date,jsonb,text,uuid,text[]),public.reopen_weather_closure(uuid),public.weather_replacement_context(text),public.get_weather_replacement(text),public.get_weather_replacement_options(text,uuid,date),public.confirm_weather_replacement(text,uuid,date,integer),public.guard_booking_weather(),public.retry_weather_email(uuid),public.claim_weather_emails() from public,anon,authenticated;
grant execute on function public.get_public_weather_closures(),public.get_weather_replacement(text),public.get_weather_replacement_options(text,uuid,date),public.confirm_weather_replacement(text,uuid,date,integer) to anon,authenticated;
grant execute on function public.get_weather_desk(date),public.create_weather_closure(date,jsonb,text,uuid,text[]),public.reopen_weather_closure(uuid),public.retry_weather_email(uuid) to authenticated;
grant execute on function public.claim_weather_emails() to service_role;
revoke all on function public.get_weather_owner_link(uuid) from public,anon;
grant execute on function public.get_weather_owner_link(uuid) to authenticated;

-- Use the existing Vault-backed worker secret; no credentials in source.
select cron.schedule('chino-weather-emails','* * * * *',$job$
  select net.http_post(url:=public.chino_project_url()||'/functions/v1/weather-notifications',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name='paddle_rage_balance_cron_secret' limit 1)),body:='{}'::jsonb)
  where public.chino_project_url() is not null;
$job$);
notify pgrst,'reload schema';
commit;
