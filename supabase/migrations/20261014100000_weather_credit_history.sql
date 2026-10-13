begin;
create function public.get_weather_credits(p_search text default '',p_status text default 'used',p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
  if public.booking_reschedule_operator_role() is null then raise exception 'Only active owners can view weather credits.' using errcode='42501'; end if;
  if p_status is null or p_status not in ('all','used','available','cancelled','changed') or p_offset is null or p_offset<0 or length(coalesce(p_search,''))>200 then raise exception 'Invalid weather credit filter.'; end if;
  with credits as (
    select i.*,r.customer_name,r.family_key,r.created_at,
      case when i.status='completed' then 'used' when i.status='pending' then 'available' when b.status='cancelled' then 'cancelled' else 'changed' end as credit_status,
      exists(select 1 from weather_replacement_items u where u.booking_ref=i.booking_ref and u.status='completed') as ever_used,
      exists(select 1 from weather_replacement_items u left join weather_refund_overrides o on o.item_id=u.id where u.booking_ref=i.booking_ref and u.status='completed' and o.item_id is null) as refund_blocked
    from weather_replacement_items i join weather_replacements r on r.id=i.replacement_id
    left join bookings b on b.ref=i.booking_ref
  ), filtered as (
    select * from credits where (p_status='all' or credit_status=p_status)
      and (coalesce(btrim(p_search),'')='' or strpos(lower(customer_name||' '||booking_ref||' '||family_key),lower(btrim(p_search)))>0)
  ), page as (
    select * from filtered order by (credit_status='used') desc,case when credit_status='used' then completed_at else created_at end desc,id desc limit 50 offset p_offset
  ) select jsonb_build_object('total',(select count(*) from filtered),'items',coalesce((select jsonb_agg(jsonb_build_object(
    'id',id,'ref',booking_ref,'groupRef',family_key,'name',customer_name,'court',court_name,'status',credit_status,
    'oldDate',old_date,'oldSlots',old_slots,'newDate',new_date,'newSlots',new_slots,'usedAt',case when credit_status='used' then completed_at else null end,
    'refundStatus',case when refund_blocked then 'blocked' when ever_used then 'exception' else 'normal_policy' end
  ) order by (credit_status='used') desc,case when credit_status='used' then completed_at else created_at end desc,id desc) from page),'[]'::jsonb)) into result;
  return result;
end $$;
revoke all on function public.get_weather_credits(text,text,integer) from public,anon;
grant execute on function public.get_weather_credits(text,text,integer) to authenticated;
commit;
