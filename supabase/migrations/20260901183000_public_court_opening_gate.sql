-- A venue may set opening_date after its opening schedule is confirmed.
create or replace function public.court_opening_date()
returns date
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $opening$
declare
  configured_date text;
begin
  select nullif(trim(value), '') into configured_date
  from public.settings where key = 'opening_date';
  if configured_date is null then return date '2026-01-01'; end if;
  begin
    return configured_date::date;
  exception when invalid_datetime_format or datetime_field_overflow then
    return date '2026-01-01';
  end;
end;
$opening$;
revoke all on function public.court_opening_date() from public;
grant execute on function public.court_opening_date() to anon, authenticated, service_role;

-- Use CHINO’s configurable opening date. Keep this rule in
-- the database so public Edge requests, authenticated host holds, and owner
-- tools cannot create a court reservation before the venue is open.

create or replace function public.enforce_public_court_opening_date()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  minimum_date date := greatest(
    public.court_opening_date(),
    timezone('Asia/Manila', now())::date
  );
begin
  if new.date is null or new.date < minimum_date then
    raise exception 'Advance booking is available from %.', minimum_date
      using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists z10_enforce_public_court_opening_date on public.bookings;
create trigger z10_enforce_public_court_opening_date
before insert or update of date on public.bookings
for each row execute function public.enforce_public_court_opening_date();

-- Open Play uses the same physical courts, so its public date-bearing rows
-- follow the same opening boundary.
drop trigger if exists z10_enforce_public_court_opening_date on public.open_play_registrations;
create trigger z10_enforce_public_court_opening_date
before insert or update of date on public.open_play_registrations
for each row execute function public.enforce_public_court_opening_date();

drop trigger if exists z10_enforce_public_court_opening_date on public.open_play_host_sessions;
create trigger z10_enforce_public_court_opening_date
before insert or update of date on public.open_play_host_sessions
for each row execute function public.enforce_public_court_opening_date();

create or replace function public.enforce_host_session_registration_opening_date()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  session_date date;
  minimum_date date := greatest(
    public.court_opening_date(),
    timezone('Asia/Manila', now())::date
  );
begin
  select s.date
    into session_date
    from public.open_play_host_sessions s
   where s.id = new.session_id;

  if session_date is null then
    raise exception 'Open Play host session was not found.'
      using errcode = '23503';
  end if;
  if session_date < minimum_date then
    raise exception 'Advance booking is available from %.', minimum_date
      using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists z10_enforce_host_session_registration_opening_date
  on public.open_play_host_session_registrations;
create trigger z10_enforce_host_session_registration_opening_date
before insert or update of session_id on public.open_play_host_session_registrations
for each row execute function public.enforce_host_session_registration_opening_date();
