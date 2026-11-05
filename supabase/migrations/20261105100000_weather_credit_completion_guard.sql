-- A booking with an unused weather credit is not over: the player still has
-- to choose a new time. Marking it completed would close the credit through
-- guard_booking_weather, so refuse that transition for every writer.
begin;

create function public.guard_weather_pending_credit_completion()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.status='completed' and old.status is distinct from 'completed'
     and exists(select 1 from weather_replacement_items where booking_ref=old.ref and status='pending') then
    raise exception 'This booking still has an unused weather credit. It completes after the player plays the new time.' using errcode='42501';
  end if;
  return new;
end $$;
-- Runs before a05_guard_booking_weather, which supersedes pending credits.
create trigger a04_weather_pending_credit_completion before update on public.bookings for each row execute function public.guard_weather_pending_credit_completion();

revoke all on function public.guard_weather_pending_credit_completion() from public,anon,authenticated;
commit;
