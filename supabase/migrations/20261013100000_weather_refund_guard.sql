begin;
-- Permanent, per-redemption exception. A cancellation never removes usage.
create table public.weather_refund_overrides (
  item_id uuid primary key references public.weather_replacement_items(id) on delete restrict,
  booking_ref text not null,
  reason text not null check(length(btrim(reason)) between 10 and 1000),
  authorized_by uuid not null,
  authorized_at timestamptz not null default now()
);
alter table public.weather_refund_overrides enable row level security;
revoke all on public.weather_refund_overrides from anon,authenticated;

create function public.get_weather_refund_status(p_refs text[])
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  if not exists(select 1 from accounts where id=auth.uid() and status='active' and role in ('owner','court_owner','staff')) then
    raise exception 'Active staff access required.' using errcode='42501';
  end if;
  if cardinality(p_refs)>100 then raise exception 'Too many bookings.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id',i.id,'ref',i.booking_ref,'court',i.court_name,'oldDate',i.old_date,'oldSlots',i.old_slots,
    'newDate',i.new_date,'newSlots',i.new_slots,'usedAt',i.completed_at,
    'overrideReason',o.reason,'overrideAt',o.authorized_at,'overrideBy',a.full_name
  ) order by i.completed_at) from weather_replacement_items i
  left join weather_refund_overrides o on o.item_id=i.id
  left join accounts a on a.id=o.authorized_by
  where i.booking_ref=any(p_refs) and i.status='completed'),'[]'::jsonb);
end $$;

create function public.authorize_weather_refund_override(p_item_id uuid,p_reason text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare item public.weather_replacement_items;
begin
  if public.booking_reschedule_operator_role() is distinct from 'owner' then
    raise exception 'Only the system owner can override this refund block.' using errcode='42501';
  end if;
  if length(btrim(coalesce(p_reason,''))) not between 10 and 1000 then
    raise exception 'Enter a refund exception reason (10–1000 characters).';
  end if;
  select * into item from weather_replacement_items where id=p_item_id;
  if item.id is null or item.status<>'completed' then raise exception 'A used weather reschedule is required.'; end if;
  perform 1 from bookings where ref=item.booking_ref for update;
  insert into weather_refund_overrides(item_id,booking_ref,reason,authorized_by)
    values(item.id,item.booking_ref,btrim(p_reason),auth.uid()) on conflict(item_id) do nothing;
end $$;

create function public.assert_weather_refund_allowed(p_ref text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if exists(select 1 from weather_replacement_items where booking_ref=p_ref and status='completed') then
    if public.booking_reschedule_operator_role() is distinct from 'owner' or exists(
      select 1 from weather_replacement_items i left join weather_refund_overrides o on o.item_id=i.id
      where i.booking_ref=p_ref and i.status='completed' and o.item_id is null
    ) then raise exception 'Weather reschedule used — refund blocked. A system-owner override with a recorded reason is required.' using errcode='42501'; end if;
  end if;
end $$;

create function public.guard_weather_refund()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_table_name='booking_fee_adjustments' then
    if new.adjustment_type='refund_credit' then
      perform 1 from bookings where ref=new.booking_ref for update;
      perform public.assert_weather_refund_allowed(new.booking_ref);
    end if;
  else
    if coalesce(new.downpayment,0)<coalesce(old.downpayment,0)
      or (old.payment_status='paid' and coalesce(new.total,0)<coalesce(old.total,0))
      or (old.payment_status='paid' and new.payment_status is distinct from old.payment_status and coalesce(new.payment_status,'') not in ('paid','deposit_retained'))
      or (new.payment_status is distinct from old.payment_status and new.payment_status in ('unpaid','refunded','partially_refunded'))
      or (new.status is distinct from old.status and new.status='refunded') then
      perform public.assert_weather_refund_allowed(old.ref);
    end if;
    if new.ref is distinct from old.ref and exists(select 1 from weather_replacement_items where booking_ref=old.ref and status='completed') then
      raise exception 'A used weather booking reference cannot be changed.' using errcode='42501';
    end if;
  end if;
  return new;
end $$;
create trigger a00_weather_refund_guard before update on public.bookings for each row execute function public.guard_weather_refund();
create trigger a00_weather_refund_guard before insert on public.booking_fee_adjustments for each row execute function public.guard_weather_refund();

-- Keep completed redemption evidence and exception authorizations immutable.
create function public.guard_weather_used_audit()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if tg_table_name='weather_refund_overrides' then
    raise exception 'Refund exception history is permanent.' using errcode='42501';
  end if;
  if old.status='completed' then
    raise exception 'Weather reschedule and refund exception history is permanent.' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger weather_used_audit before update or delete on public.weather_replacement_items for each row execute function public.guard_weather_used_audit();
create trigger weather_override_audit before update or delete on public.weather_refund_overrides for each row execute function public.guard_weather_used_audit();

-- Add explicit usage records to the existing date-scoped desk response.
alter function public.get_weather_desk(date) rename to get_weather_desk_base;
create function public.get_weather_desk(p_date date)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
  result:=public.get_weather_desk_base(p_date);
  return result || jsonb_build_object('usedReschedules',public.get_weather_refund_status(array(
    select distinct i.booking_ref from weather_replacement_items i join weather_replacements r on r.id=i.replacement_id
    join weather_closures c on c.id=r.closure_id where c.date=p_date and i.status='completed'
  )));
end $$;
revoke all on function public.get_weather_desk_base(date) from public,anon,authenticated;
revoke all on function public.get_weather_refund_status(text[]),public.authorize_weather_refund_override(uuid,text),public.get_weather_desk(date) from public,anon;
grant execute on function public.get_weather_refund_status(text[]),public.authorize_weather_refund_override(uuid,text),public.get_weather_desk(date) to authenticated;
revoke all on function public.assert_weather_refund_allowed(text),public.guard_weather_refund(),public.guard_weather_used_audit() from public,anon,authenticated;
commit;
