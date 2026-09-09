-- Include management accounts in the owner-only operator filter before their first activity.
begin;
do $$ begin
  if public.chino_project_url() is distinct from 'https://wskzptxekldhsxluhgos.supabase.co' then
    raise exception 'CHINO project guard failed';
  end if;
end $$;

create or replace function public.owner_activity_log_list(
  p_from timestamptz default null,p_to timestamptz default null,p_category text default null,
  p_actor_id uuid default null,p_before_id bigint default null,p_limit integer default 50
) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare v_items jsonb; v_next text; v_actors jsonb; v_state public.admin_activity_state%rowtype; v_tables jsonb; v_limit integer:=coalesce(p_limit,50);
begin
  if not public.admin_activity_is_owner() then raise exception 'Only the system owner can read activity history.' using errcode='42501'; end if;
  if v_limit<1 or v_limit>100 or (p_from is not null and p_to is not null and p_from>=p_to) then
    raise exception 'Invalid activity range or page size.' using errcode='22023';
  end if;
  if p_category is not null and p_category not in ('courts','bookings','payments','finance','settings','maintenance','accounts','open_play','hosts','access','navigation','interaction','export','other') then
    raise exception 'Invalid activity category.' using errcode='22023';
  end if;
  with matches as (
    select l.* from public.admin_activity_log l where (p_from is null or l.occurred_at>=p_from)
      and (p_to is null or l.occurred_at<p_to) and (p_category is null or l.category=p_category)
      and (p_actor_id is null or l.actor_id=p_actor_id) and (p_before_id is null or l.id<p_before_id)
    order by l.id desc limit v_limit+1
  ), page as (select * from matches order by id desc limit v_limit)
  select coalesce(jsonb_agg((to_jsonb(page)-'before_data'-'after_data'-'actor_email')||jsonb_build_object('id',page.id::text) order by page.id desc),'[]'),
    case when (select count(*) from matches)>v_limit then min(page.id)::text else null end into v_items,v_next from page;
  -- The operator directory must not depend on whether an account has acted yet,
  -- or on the current result filters. Retain historical actors after account removal.
  with historical as (
    select distinct on (actor_id) actor_id,actor_name,actor_role
    from public.admin_activity_log where actor_id is not null order by actor_id,id desc
  ), operators as (
    select coalesce(a.id,h.actor_id) actor_id,
      coalesce(nullif(btrim(a.full_name),''),nullif(btrim(a.username),''),nullif(btrim(h.actor_name),''),'Account') actor_name,
      coalesce(a.role,h.actor_role) actor_role
    from public.accounts a full join historical h on h.actor_id=a.id
    where a.role in ('owner','court_owner','staff') or h.actor_id is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',x.actor_id,'name',x.actor_name,'role',x.actor_role)
    order by lower(x.actor_name),x.actor_id),'[]') into v_actors from operators x;
  select * into v_state from public.admin_activity_state where singleton;
  select coalesce(jsonb_agg(c.relname order by c.relname),'[]') into v_tables from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and t.tgname='zzz_admin_activity_change' and not c.relispartition;
  return jsonb_build_object('startedAt',v_state.started_at,'items',v_items,'nextCursor',v_next,'actors',v_actors,
    'capabilities',jsonb_build_object('authAuditCaptured',v_state.auth_audit_hook_installed,
      'authAuditHookInstalled',v_state.auth_audit_hook_installed,'authEventsObserved',exists(select 1 from public.admin_activity_log where source='auth_event'),
      'automaticTableCoverage',v_state.automatic_table_coverage,'trackedTables',v_tables));
end $$;

-- Replacing the function preserves grants; explicitly retain the owner-only RPC boundary.
revoke all on function public.owner_activity_log_list(timestamptz,timestamptz,text,uuid,bigint,integer) from public,anon,service_role;
grant execute on function public.owner_activity_log_list(timestamptz,timestamptz,text,uuid,bigint,integer) to authenticated;

commit;
