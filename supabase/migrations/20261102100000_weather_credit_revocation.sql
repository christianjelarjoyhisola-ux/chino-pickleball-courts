-- An unused weather credit can be cancelled when the player chooses a manual
-- refund instead. Revocation is permanent, audited and emails the player.
begin;

do $migration$
declare constraint_name text;
begin
  select conname into constraint_name from pg_constraint
    where conrelid='public.weather_replacement_items'::regclass and contype='c' and pg_get_constraintdef(oid) like '%superseded%';
  if constraint_name is null then raise exception 'Weather credit status constraint not found.'; end if;
  execute format('alter table public.weather_replacement_items drop constraint %I',constraint_name);
  select conname into constraint_name from pg_constraint
    where conrelid='public.weather_email_outbox'::regclass and contype='c' and pg_get_constraintdef(oid) like '%invitation%';
  if constraint_name is null then raise exception 'Weather email kind constraint not found.'; end if;
  execute format('alter table public.weather_email_outbox drop constraint %I',constraint_name);
end;
$migration$;

alter table public.weather_replacement_items
  add column revoked_at timestamptz,
  add column revoked_by uuid,
  add column revoke_reason text,
  add column refund_reference text,
  add column refund_amount numeric(12,2),
  add constraint weather_replacement_items_status_check check (status in ('pending','completed','superseded','revoked')),
  add constraint weather_credit_revocation_record check (
    status<>'revoked' or (revoked_at is not null and revoked_by is not null and length(btrim(revoke_reason)) between 10 and 1000)),
  add constraint weather_credit_refund_reference check (refund_reference is null or length(refund_reference) between 1 and 120),
  add constraint weather_credit_refund_amount check (refund_amount is null or refund_amount>0);
alter table public.weather_email_outbox
  add constraint weather_email_outbox_kind_check check (kind in ('invitation','confirmation','revoked'));
create unique index weather_revoked_once on public.weather_email_outbox(item_id) where kind='revoked';

-- Revocation records are as permanent as used credits.
create function public.guard_weather_revoked_audit()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if old.status='revoked' then raise exception 'A cancelled weather credit is permanent.' using errcode='42501'; end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger weather_revoked_audit before update or delete on public.weather_replacement_items for each row execute function public.guard_weather_revoked_audit();

create function public.revoke_weather_credit(p_item_id uuid,p_reason text,p_refund_reference text default null,p_refund_amount numeric default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare item public.weather_replacement_items; family text;
begin
  if public.booking_reschedule_operator_role() is null then
    raise exception 'Only an active owner or court owner can cancel a weather credit.' using errcode='42501';
  end if;
  if length(btrim(coalesce(p_reason,''))) not between 10 and 1000 then raise exception 'Enter a reason (10–1000 characters).'; end if;
  if length(btrim(coalesce(p_refund_reference,'')))>120 then raise exception 'Refund reference must be 120 characters or fewer.'; end if;
  if p_refund_amount is not null and (p_refund_amount<=0 or p_refund_amount>9999999999) then raise exception 'Enter a refund amount greater than zero.'; end if;
  select r.family_key into family from weather_replacement_items i join weather_replacements r on r.id=i.replacement_id where i.id=p_item_id;
  if family is null then raise exception 'Weather credit not found.'; end if;
  -- Same lock order as confirm_weather_replacement, so a player redeeming at
  -- the same moment either finishes first or sees the credit cancelled.
  perform pg_advisory_xact_lock(hashtextextended('paddle-rage-reschedule-family|'||family,0));
  select * into item from weather_replacement_items where id=p_item_id;
  perform 1 from bookings where ref=item.booking_ref for update;
  select * into item from weather_replacement_items where id=p_item_id for update;
  if item.status='revoked' then raise exception 'This weather credit was already cancelled.'; end if;
  if item.status='completed' then raise exception 'This weather credit was already used. A refund needs a system-owner exception.'; end if;
  if item.status<>'pending' then raise exception 'This weather credit is no longer available.'; end if;
  update weather_replacement_items set status='revoked',revoked_at=now(),revoked_by=auth.uid(),revoke_reason=btrim(p_reason),
    refund_reference=nullif(btrim(coalesce(p_refund_reference,'')),''),refund_amount=round(p_refund_amount,2)
    where id=item.id;
  insert into weather_email_outbox(replacement_id,item_id,kind) values(item.replacement_id,item.id,'revoked') on conflict do nothing;
  return jsonb_build_object('id',item.id,'ref',item.booking_ref,'status','revoked');
end $$;

-- Money returned on a still-active booking must come after the available
-- credit is cancelled. Cancelling the booking itself already supersedes it.
create function public.guard_weather_pending_credit_refund()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare ref text;
begin
  if tg_table_name='booking_fee_adjustments' then
    if new.adjustment_type is distinct from 'refund_credit' then return new; end if;
    ref:=new.booking_ref;
  elsif new.status not in ('cancelled','forfeited','completed') and (
      coalesce(new.downpayment,0)<coalesce(old.downpayment,0)
      or (old.payment_status in ('paid','downpayment_paid') and coalesce(new.payment_status,'') not in ('paid','downpayment_paid','deposit_retained'))) then
    ref:=old.ref;
  else
    return new;
  end if;
  if exists(select 1 from weather_replacement_items where booking_ref=ref and status='pending') then
    raise exception 'This booking has an available weather credit. Cancel the weather credit before recording a refund.' using errcode='42501';
  end if;
  return new;
end $$;
create trigger a01_weather_pending_credit_refund before update on public.bookings for each row execute function public.guard_weather_pending_credit_refund();
create trigger a01_weather_pending_credit_refund before insert on public.booking_fee_adjustments for each row execute function public.guard_weather_pending_credit_refund();

-- Booking details: available and cancelled credits for the open booking group.
create function public.get_weather_open_credits(p_refs text[])
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  if not exists(select 1 from accounts where id=auth.uid() and status='active' and role in ('owner','court_owner','staff')) then
    raise exception 'Active staff access required.' using errcode='42501';
  end if;
  if cardinality(p_refs)>100 then raise exception 'Too many bookings.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id',i.id,'ref',i.booking_ref,'court',i.court_name,'status',case when i.status='revoked' then 'revoked' else 'available' end,
    'oldDate',i.old_date,'oldSlots',i.old_slots,'revokedAt',i.revoked_at,'revokeReason',i.revoke_reason,
    'refundReference',i.refund_reference,'refundAmount',i.refund_amount,'revokedBy',a.full_name
  ) order by i.booking_ref,i.revoked_at) from weather_replacement_items i
  left join accounts a on a.id=i.revoked_by
  where i.booking_ref=any(p_refs) and i.status in ('pending','revoked')),'[]'::jsonb);
end $$;

create or replace function public.get_weather_credits(p_search text default '',p_status text default 'used',p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
  if public.booking_reschedule_operator_role() is null then raise exception 'Only active owners can view weather credits.' using errcode='42501'; end if;
  if p_status is null or p_status not in ('all','used','available','cancelled','changed','revoked') or p_offset is null or p_offset<0 or length(coalesce(p_search,''))>200 then raise exception 'Invalid weather credit filter.'; end if;
  with credits as (
    select i.*,r.customer_name,r.family_key,r.created_at,a.full_name as revoked_by_name,
      case when i.status='completed' then 'used' when i.status='pending' then 'available' when i.status='revoked' then 'revoked' when b.status='cancelled' then 'cancelled' else 'changed' end as credit_status,
      exists(select 1 from weather_replacement_items u where u.booking_ref=i.booking_ref and u.status='completed') as ever_used,
      exists(select 1 from weather_replacement_items u left join weather_refund_overrides o on o.item_id=u.id where u.booking_ref=i.booking_ref and u.status='completed' and o.item_id is null) as refund_blocked
    from weather_replacement_items i join weather_replacements r on r.id=i.replacement_id
    left join bookings b on b.ref=i.booking_ref
    left join accounts a on a.id=i.revoked_by
  ), filtered as (
    select * from credits where (p_status='all' or credit_status=p_status)
      and (coalesce(btrim(p_search),'')='' or strpos(lower(customer_name||' '||booking_ref||' '||family_key),lower(btrim(p_search)))>0)
  ), page as (
    select * from filtered order by (credit_status='used') desc,case when credit_status='used' then completed_at when credit_status='revoked' then revoked_at else created_at end desc,id desc limit 50 offset p_offset
  ) select jsonb_build_object('total',(select count(*) from filtered),'items',coalesce((select jsonb_agg(jsonb_build_object(
    'id',id,'ref',booking_ref,'groupRef',family_key,'name',customer_name,'court',court_name,'status',credit_status,
    'oldDate',old_date,'oldSlots',old_slots,'newDate',new_date,'newSlots',new_slots,'usedAt',case when credit_status='used' then completed_at else null end,
    'revokedAt',revoked_at,'revokeReason',revoke_reason,'refundReference',refund_reference,'refundAmount',refund_amount,'revokedBy',revoked_by_name,
    'refundStatus',case when refund_blocked then 'blocked' when ever_used then 'exception' when credit_status='revoked' then 'credit_revoked' else 'normal_policy' end
  ) order by (credit_status='used') desc,case when credit_status='used' then completed_at when credit_status='revoked' then revoked_at else created_at end desc,id desc) from page),'[]'::jsonb)) into result;
  return result;
end $$;

revoke all on function public.guard_weather_revoked_audit(),public.guard_weather_pending_credit_refund() from public,anon,authenticated;
revoke all on function public.revoke_weather_credit(uuid,text,text,numeric),public.get_weather_open_credits(text[]),public.get_weather_credits(text,text,integer) from public,anon;
grant execute on function public.revoke_weather_credit(uuid,text,text,numeric),public.get_weather_open_credits(text[]),public.get_weather_credits(text,text,integer) to authenticated;
commit;
