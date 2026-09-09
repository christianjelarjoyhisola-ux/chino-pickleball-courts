-- Keep human actions and background work readable without rewriting historical records.
begin;
do $$ begin
 if public.chino_project_url() is distinct from 'https://wskzptxekldhsxluhgos.supabase.co' then raise exception 'CHINO project guard failed'; end if;
end $$;
create or replace function public.admin_activity_clean_metadata(p_metadata jsonb,p_server boolean default false)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public,pg_temp as $$
declare v_item record; v_out jsonb:='{}'; v_text text;
begin
  if p_metadata is null then return '{}'; end if;
  if jsonb_typeof(p_metadata)<>'object' or octet_length(p_metadata::text)>4096 then
    raise exception 'Activity metadata must be a small object.' using errcode='22023';
  end if;
  for v_item in select key,value from jsonb_each(p_metadata) loop
    if not (v_item.key=any(case when p_server then array['action','endpoint','status','reasonCode','count','requestId']
      else array['action','entityType','entityId','format','fromDate','toDate','count','outcome','controlEvent','uiResult'] end)) then continue; end if;
    if jsonb_typeof(v_item.value) not in ('string','number','boolean','null') then
      raise exception 'Activity metadata values must be scalar.' using errcode='22023';
    end if;
    v_text:=v_item.value#>>'{}';
    if length(v_text)>180 or v_text ~ '[[:cntrl:]]' then
      raise exception 'Activity metadata value is too long or invalid.' using errcode='22023';
    end if;
    if v_item.key='requestId' and v_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Activity request ID must be a UUID.' using errcode='22023';
    end if;
    if v_item.key='controlEvent' and v_text not in ('click','change','submit') then raise exception 'Invalid control event.' using errcode='22023'; end if;
    if v_item.key='uiResult' and v_text not in ('opened','closed','expanded','collapsed','cancelled','copied','shared','validation_failed') then raise exception 'Invalid control result.' using errcode='22023'; end if;
    v_out:=v_out||jsonb_build_object(v_item.key,public.admin_activity_redact(v_item.value));
  end loop;
  return v_out;
end $$;


create or replace function public.owner_activity_log_list(
  p_from timestamptz default null,p_to timestamptz default null,p_category text default null,
  p_actor_id uuid default null,p_before_id bigint default null,p_limit integer default 50,
  p_page text default null,p_view text default 'all'
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
  if p_view is null or p_view not in ('people','services','all') then
    raise exception 'Invalid activity view.' using errcode='22023';
  end if;
  if p_page is not null and p_page not in ('dash','insights','bookings','deleted','activity','payreview','reports','courts','gamemgr','accounts','remittances','hosts','maintenance','payments','login') then
    raise exception 'Invalid activity page.' using errcode='22023';
  end if;
  with matches as (
    select l.* from public.admin_activity_log l where (p_from is null or l.occurred_at>=p_from)
      and (p_to is null or l.occurred_at<p_to) and (p_category is null or l.category=p_category)
      and (p_actor_id is null or l.actor_id=p_actor_id) and (p_before_id is null or l.id<p_before_id)
      -- Navigation's destination is canonical, including older rows with a stale metadata.page.
      -- Database/server events lack an origin page; never guess one from the affected table.
      and (p_page is null or (case when l.action='page_view' then l.entity_id
        when l.source='client_reported' then l.metadata->>'page' else null end)=p_page)
      and (p_view='all' or (l.source='server_reported' or
        (l.source='client_reported' and l.action in ('dispatchBookingRescheduleNotifications','dispatchOpenPlayHostReviewNotifications','syncOpenPlayGameQueueWaitTimes','processHostBalanceDeadlines')))=(p_view='services'))
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

-- Existing clients can omit the new parameters and still receive all records.
-- Keep access owner-only; no audit rows are rewritten or removed.
revoke all on function public.owner_activity_log_list(timestamptz,timestamptz,text,uuid,bigint,integer,text,text) from public,anon,service_role;
grant execute on function public.owner_activity_log_list(timestamptz,timestamptz,text,uuid,bigint,integer,text,text) to authenticated;


notify pgrst, 'reload schema';
commit;
