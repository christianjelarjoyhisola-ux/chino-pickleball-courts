-- Starts a new, append-only management history. This does not reconstruct past actions.
begin;
do $$ begin
  if public.chino_project_url() is distinct from 'https://wskzptxekldhsxluhgos.supabase.co' then
    raise exception 'CHINO project guard failed';
  end if;
end $$;

create table public.admin_activity_state (
  singleton boolean primary key default true check (singleton),
  started_at timestamptz not null default clock_timestamp(),
  auth_audit_hook_installed boolean not null default false,
  automatic_table_coverage boolean not null default false
);
insert into public.admin_activity_state(singleton) values (true);

create table public.admin_activity_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default clock_timestamp(),
  actor_id uuid,
  actor_name text not null,
  actor_email text,
  actor_role text not null,
  actor_kind text not null check (actor_kind in ('account','service_account','system','anonymous')),
  source text not null check (source in ('database_change','client_reported','server_reported','auth_event')),
  category text not null,
  action text not null,
  entity_type text,
  entity_id text,
  summary text not null,
  outcome text not null,
  changed_fields text[] not null default '{}',
  before_data jsonb,
  after_data jsonb,
  metadata jsonb not null default '{}'
);
comment on table public.admin_activity_log is
  'Append-only history from installation onward. database_change confirms committed table writes; client_reported and server_reported describe separately reported actions and outcomes. No historical backfill.';
create index admin_activity_actor_time_idx on public.admin_activity_log(actor_id,id desc);
create index admin_activity_category_time_idx on public.admin_activity_log(category,id desc);
create index admin_activity_time_idx on public.admin_activity_log(occurred_at,id desc);

alter table public.admin_activity_log enable row level security;
alter table public.admin_activity_state enable row level security;
revoke all on public.admin_activity_log, public.admin_activity_state from public,anon,authenticated,service_role;
revoke all on sequence public.admin_activity_log_id_seq from public,anon,authenticated,service_role;
grant select on public.admin_activity_log to authenticated;

create function public.admin_activity_is_owner()
returns boolean language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select coalesce(auth.role()='authenticated',false) and exists (
    select 1 from public.accounts where id=auth.uid() and role='owner' and status='active'
  )
$$;
create policy admin_activity_owner_read on public.admin_activity_log for select to authenticated
  using (public.admin_activity_is_owner());

create function public.admin_activity_deny_mutation()
returns trigger language plpgsql set search_path=pg_catalog,public,pg_temp as $$
begin
  raise exception 'Activity history is append-only.' using errcode='42501';
end $$;
create trigger admin_activity_no_update_delete before update or delete on public.admin_activity_log
  for each row execute function public.admin_activity_deny_mutation();
create trigger admin_activity_no_truncate before truncate on public.admin_activity_log
  for each statement execute function public.admin_activity_deny_mutation();

-- Request claims are populated by PostgREST after JWT verification. A browser header
-- is never accepted as an actor. Only an authenticated service-role request may relay
-- a separately verified account, and that account is resolved again here.
create function public.admin_activity_actor(p_service_actor uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare
  v_id uuid; v_account public.accounts%rowtype; v_role text:=coalesce(auth.role(),'');
  v_headers jsonb:='{}'; v_kind text:='account';
begin
  if v_role='service_role' then
    v_kind:='service_account';
    v_id:=p_service_actor;
    if v_id is null then
      begin v_headers:=coalesce(nullif(current_setting('request.headers',true),'')::jsonb,'{}');
      exception when others then v_headers:='{}'; end;
      if coalesce(v_headers->>'x-chino-audit-actor','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        v_id:=(v_headers->>'x-chino-audit-actor')::uuid;
      end if;
    end if;
  elsif v_role='authenticated' then
    v_id:=auth.uid();
  end if;
  if v_id is not null then
    select * into v_account from public.accounts where id=v_id and status='active';
    if found and (v_role<>'service_role' or v_account.role in ('owner','court_owner','staff')) then
      return jsonb_build_object('id',v_account.id,'name',coalesce(nullif(v_account.full_name,''),v_account.username,'Account'),
        'email',v_account.email,'role',v_account.role,'kind',v_kind);
    end if;
  end if;
  if v_role='authenticated' then
    return jsonb_build_object('id',auth.uid(),'name','Authenticated account','role','unknown','kind','account');
  elsif v_role='anon' then
    return jsonb_build_object('id',null,'name','Public visitor','role','anon','kind','anonymous');
  end if;
  return jsonb_build_object('id',null,'name','System / service job','role',case when v_role='service_role' then v_role else 'system' end,'kind','system');
end $$;

create function public.admin_activity_sensitive_key(p_key text)
returns boolean language sql immutable set search_path=pg_catalog,pg_temp as $$
  select coalesce(p_key,'') ~* '(password|passwd|secret|token|authorization|cookie|credential|api.?key|private.?key|service.?key|salt|(^|_)otp($|_)|totp|mfa|jwt|refresh|receipt|ocr|image|photo|attachment|document|signature|(^|_)qr($|_)|qr.?code|qr.?data|phone|contact|mobile|email|gcash.?number|valid.?id|account.?number|bank.?account|acct.?no|ip.?address|session.*(id|key)|access.*(key|code))'
$$;

-- Snapshot values are bounded and recursively scrubbed. Pricing and maintenance JSON
-- stored as settings text is parsed first, preserving useful structured differences.
create function public.admin_activity_redact(p_value jsonb,p_key text default '',p_depth integer default 0)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public,pg_temp as $$
declare v_type text:=jsonb_typeof(p_value); v_text text; v_out jsonb; v_item record; v_n integer:=0;
begin
  if public.admin_activity_sensitive_key(p_key) then return '"[REDACTED]"'::jsonb; end if;
  if p_value is null or v_type='null' then return p_value; end if;
  if p_depth>7 then return '"[DEPTH LIMITED]"'::jsonb; end if;
  if v_type='object' then
    v_out:='{}';
    for v_item in select key,value from jsonb_each(p_value) order by key loop
      v_n:=v_n+1;
      if v_n>100 then v_out:=v_out||'{"_truncated":true}'; exit; end if;
      v_out:=v_out||jsonb_build_object(v_item.key,public.admin_activity_redact(v_item.value,v_item.key,p_depth+1));
    end loop;
    return v_out;
  elsif v_type='array' then
    v_out:='[]';
    for v_item in select value from jsonb_array_elements(p_value) loop
      v_n:=v_n+1;
      if v_n>50 then v_out:=v_out||'["[TRUNCATED]"]'; exit; end if;
      v_out:=v_out||jsonb_build_array(public.admin_activity_redact(v_item.value,'',p_depth+1));
    end loop;
    return v_out;
  elsif v_type='string' then
    v_text:=p_value#>>'{}';
    if left(ltrim(v_text),1) in ('{','[') and octet_length(v_text)<=32768 then
      begin return public.admin_activity_redact(v_text::jsonb,'',p_depth+1);
      exception when invalid_text_representation then null; end;
    end if;
    if v_text ~* '(data:|https?://|bearer[[:space:]]|password[[:space:]]*[:=]|secret[[:space:]]*[:=]|token[[:space:]]*[:=]|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.)'
      or (length(v_text)>128 and v_text ~ '^[A-Za-z0-9+/=_-]+$') then
      return '"[REDACTED CONTENT]"'::jsonb;
    end if;
    return to_jsonb(case when length(v_text)>1000 then left(v_text,1000)||' [TRUNCATED]' else v_text end);
  end if;
  return p_value;
end $$;

create function public.admin_activity_snapshot(p_row jsonb,p_table text)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public,pg_temp as $$
declare v_row jsonb:=p_row;
begin
  if p_table='settings' and public.admin_activity_sensitive_key(p_row->>'key') then
    v_row:=jsonb_set(v_row,'{value}','"[REDACTED]"');
  end if;
  return public.admin_activity_redact(v_row);
end $$;

create function public.admin_activity_category(p_table text,p_row jsonb default '{}')
returns text language sql immutable set search_path=pg_catalog,pg_temp as $$
  select case
    when p_table='courts' then 'courts'
    when p_table='blocked_dates' or (p_table='settings' and coalesce(p_row->>'key','') in ('maintenance_config','blocked_dates')) then 'maintenance'
    when p_table='settings' then 'settings'
    when p_table='accounts' then 'accounts'
    when p_table ~ '(booking_fee|weekly_fee|remittance|billing)' then 'finance'
    when p_table ~ '(payment|paid)' then 'payments'
    when p_table ~ '(booking|reschedule)' then 'bookings'
    when p_table ~ '(host)' then 'hosts'
    when p_table ~ '^open_play' then 'open_play'
    else 'other' end
$$;

create function public.admin_activity_write(
  p_actor jsonb,p_source text,p_category text,p_action text,p_entity_type text,p_entity_id text,
  p_summary text,p_outcome text,p_changed_fields text[] default '{}',p_before jsonb default null,
  p_after jsonb default null,p_metadata jsonb default '{}'
) returns bigint language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v_id bigint;
begin
  insert into public.admin_activity_log(actor_id,actor_name,actor_email,actor_role,actor_kind,source,category,action,
    entity_type,entity_id,summary,outcome,changed_fields,before_data,after_data,metadata)
  values ((p_actor->>'id')::uuid,left(p_actor->>'name',200),left(p_actor->>'email',254),p_actor->>'role',p_actor->>'kind',
    p_source,p_category,left(p_action,100),left(p_entity_type,100),left(p_entity_id,180),left(p_summary,500),p_outcome,
    coalesce(p_changed_fields,'{}'),p_before,p_after,coalesce(p_metadata,'{}')) returning id into v_id;
  return v_id;
end $$;

create function public.admin_activity_capture_change()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare
  v_old jsonb; v_new jsonb; v_row jsonb; v_fields text[]; v_actor jsonb;
  v_entity text; v_summary text; v_metadata jsonb:='{}'; v_headers jsonb:='{}'; v_key text; v_court_name text; v_category text;
begin
  if tg_op='UPDATE' then
    v_old:=to_jsonb(old); v_new:=to_jsonb(new);
    select coalesce(array_agg(k order by k),'{}') into v_fields
    from (select jsonb_object_keys(v_old||v_new) k) q
    where v_old->k is distinct from v_new->k and k not in ('updated_at','touched_at','last_seen_at');
    if cardinality(v_fields)=0 then return new; end if;
  elsif tg_op='DELETE' then v_old:=to_jsonb(old);
  elsif tg_op='INSERT' then v_new:=to_jsonb(new);
  end if;
  v_actor:=public.admin_activity_actor();
  v_row:=coalesce(v_new,v_old,'{}');
  -- Self-demotion/deletion is attributed to the account identity before the write.
  if tg_table_name='accounts' and tg_op in ('UPDATE','DELETE') and auth.role()='authenticated'
    and v_old->>'id'=auth.uid()::text and v_old->>'status'='active' then
    v_actor:=jsonb_build_object('id',v_old->>'id','name',coalesce(nullif(v_old->>'full_name',''),v_old->>'username','Account'),
      'email',v_old->>'email','role',v_old->>'role','kind','account');
  end if;
  if tg_nargs>0 and tg_argv[0]<>'' then
    foreach v_key in array string_to_array(tg_argv[0],',') loop
      v_entity:=concat_ws(' / ',v_entity,case when public.admin_activity_sensitive_key(v_key) then '[REDACTED]' else v_row->>v_key end);
    end loop;
  end if;
  v_entity:=coalesce(nullif(v_entity,''),v_row->>'ref',v_row->>'id',v_row->>'key',v_row->>'date');
  v_summary:=case tg_op when 'INSERT' then 'Created ' when 'UPDATE' then 'Updated ' when 'DELETE' then 'Deleted ' else 'Cleared ' end
    ||replace(tg_table_name,'_',' ');
  if tg_table_name='courts' and tg_op<>'TRUNCATE' then
    v_court_name:=left(coalesce(nullif(public.admin_activity_redact(v_row->'name')#>>'{}',''),'court'),100);
    v_summary:=case tg_op when 'INSERT' then 'Created ' when 'UPDATE' then 'Updated ' else 'Deleted ' end||v_court_name;
  end if;
  if tg_table_name='courts' and tg_op='UPDATE' and 'blocked'=any(v_fields) then
    v_summary:=case when (v_new->>'blocked')::boolean then 'Paused '||v_court_name||' for all dates' else 'Resumed '||v_court_name||' bookings' end;
  end if;
  if auth.role()='service_role' then
    begin v_headers:=coalesce(nullif(current_setting('request.headers',true),'')::jsonb,'{}'); exception when others then null; end;
    if coalesce(v_headers->>'x-chino-audit-request','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_metadata:=jsonb_build_object('requestId',v_headers->>'x-chino-audit-request');
    end if;
  end if;
  v_category:=public.admin_activity_category(tg_table_name,v_row);
  if tg_table_name='bookings' and tg_op='UPDATE' and coalesce(v_fields,'{}') &&
    array['payment_status','payment_method','payment_ref','gcash_ref','receipt_status','amount_paid','balance_due'] then
    v_category:='payments';
    v_summary:='Updated booking payment';
  end if;
  perform public.admin_activity_write(v_actor,'database_change',v_category,
    lower(tg_op),tg_table_name,v_entity,v_summary,'success',coalesce(v_fields,'{}'),
    public.admin_activity_snapshot(v_old,tg_table_name),public.admin_activity_snapshot(v_new,tg_table_name),v_metadata);
  if tg_op='DELETE' then return old; elsif tg_op='TRUNCATE' then return null; else return new; end if;
end $$;

-- Internal lock/cache/delivery/receipt-evidence and existing audit tables are excluded;
-- their resulting business changes (booking status, balances, settings, etc.) are logged.
create function public.admin_activity_table_is_business(p_name text)
returns boolean language sql immutable set search_path=pg_catalog,pg_temp as $$
  select p_name !~ '^(admin_activity_|pg_|sql_)'
    and p_name !~ '(_leases?$|_claims?$|_outbox$|_notification_recipients$|_events$|_history$|_archive$)'
    and p_name not in ('chino_backend_config','receipt_verifications','used_gcash_refs','payment_sessions',
      'payment_review_decisions','booking_balance_notifications','open_play_game_session_shares',
      'booking_reschedule_active_items','spatial_ref_sys')
$$;

create function public.admin_activity_register_table(p_table regclass)
returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v_schema text; v_table text; v_pk text;
begin
  select n.nspname,c.relname into v_schema,v_table from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.oid=p_table and c.relkind in ('r','p') and not c.relispartition;
  if v_schema is distinct from 'public' or not public.admin_activity_table_is_business(v_table) then return; end if;
  if exists(select 1 from pg_depend where classid='pg_class'::regclass and objid=p_table and deptype='e') then return; end if;
  select string_agg(a.attname,',' order by k.ord) into v_pk
    from pg_index i cross join lateral unnest(i.indkey) with ordinality k(attnum,ord)
    join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum where i.indrelid=p_table and i.indisprimary;
  if not exists(select 1 from pg_trigger where tgrelid=p_table and tgname='zzz_admin_activity_change') then
    execute format('create trigger zzz_admin_activity_change after insert or update or delete on %I.%I for each row execute function public.admin_activity_capture_change(%L)',v_schema,v_table,coalesce(v_pk,''));
  end if;
  if not exists(select 1 from pg_trigger where tgrelid=p_table and tgname='zzz_admin_activity_truncate') then
    execute format('create trigger zzz_admin_activity_truncate after truncate on %I.%I for each statement execute function public.admin_activity_capture_change()',v_schema,v_table);
  end if;
end $$;

do $$ declare v_table regclass; begin
  for v_table in select c.oid::regclass from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p') and not c.relispartition loop
    perform public.admin_activity_register_table(v_table);
  end loop;
end $$;

create function public.admin_activity_capture_new_tables()
returns event_trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v_command record;
begin
  for v_command in select * from pg_event_trigger_ddl_commands() where object_type in ('table','table column') loop
    if v_command.schema_name='public' and not v_command.in_extension then
      perform public.admin_activity_register_table(v_command.objid::regclass);
    end if;
  end loop;
end $$;
do $$ begin
  begin
    execute 'create event trigger chino_admin_activity_new_tables on ddl_command_end when tag in (''CREATE TABLE'',''CREATE TABLE AS'',''SELECT INTO'') execute function public.admin_activity_capture_new_tables()';
    update public.admin_activity_state set automatic_table_coverage=true where singleton;
  exception when insufficient_privilege then
    raise notice 'Automatic future-table registration unavailable; call admin_activity_register_table in future migrations.';
  end;
end $$;

-- Auth payloads/IPs are never copied. This optional hook records only an existing
-- operator's canonical account identity and the action named by Supabase Auth itself.
create function public.admin_activity_capture_auth()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v_payload jsonb; v_id uuid; v_account public.accounts%rowtype; v_action text; v_actor jsonb;
begin
  v_payload:=new.payload::jsonb; v_action:=v_payload->>'action';
  if coalesce(v_payload->>'actor_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(v_action,'') !~ '^[a-z][a-z0-9_]{0,79}$' then return new; end if;
  v_id:=(v_payload->>'actor_id')::uuid;
  select * into v_account from public.accounts where id=v_id and role in ('owner','court_owner','staff');
  if not found then return new; end if;
  v_actor:=jsonb_build_object('id',v_id,'name',coalesce(nullif(v_account.full_name,''),v_account.username,'Account'),
    'email',v_account.email,'role',v_account.role,'kind','account');
  perform public.admin_activity_write(v_actor,'auth_event','access',v_action,'account',v_id::text,
    'Authentication: '||replace(v_action,'_',' '),'recorded','{}',null,null,jsonb_build_object('authEventId',new.id));
  return new;
end $$;
do $$ begin
  if to_regclass('auth.audit_log_entries') is not null then
    begin
      execute 'create trigger chino_admin_activity_auth after insert on auth.audit_log_entries for each row execute function public.admin_activity_capture_auth()';
      update public.admin_activity_state set auth_audit_hook_installed=true where singleton;
    exception when insufficient_privilege then
      raise notice 'Auth audit hook unavailable; browser access reports remain labelled client_reported.';
    end;
  end if;
end $$;

create function public.admin_activity_clean_metadata(p_metadata jsonb,p_server boolean default false)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public,pg_temp as $$
declare v_item record; v_out jsonb:='{}'; v_text text;
begin
  if p_metadata is null then return '{}'; end if;
  if jsonb_typeof(p_metadata)<>'object' or octet_length(p_metadata::text)>4096 then
    raise exception 'Activity metadata must be a small object.' using errcode='22023';
  end if;
  for v_item in select key,value from jsonb_each(p_metadata) loop
    if not (v_item.key=any(case when p_server then array['action','endpoint','status','reasonCode','count','requestId']
      else array['action','entityType','entityId','format','fromDate','toDate','count','outcome'] end)) then continue; end if;
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
    v_out:=v_out||jsonb_build_object(v_item.key,public.admin_activity_redact(v_item.value));
  end loop;
  return v_out;
end $$;

create function public.record_admin_activity(p_event text,p_page text default null,p_metadata jsonb default '{}')
returns bigint language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v_actor jsonb; v_metadata jsonb; v_category text; v_outcome text; v_action text; v_summary text;
begin
  if auth.role() is distinct from 'authenticated' or not exists(select 1 from public.accounts
    where id=auth.uid() and role in ('owner','court_owner','staff') and status='active') then
    raise exception 'An active management account is required.' using errcode='42501';
  end if;
  if p_event not in ('page_view','export','action_attempt','action_result','sign_in','sign_out') or p_event is null then
    raise exception 'Unsupported activity event.' using errcode='22023';
  end if;
  if p_page is not null and p_page !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$' then
    raise exception 'Invalid activity page.' using errcode='22023';
  end if;
  v_metadata:=public.admin_activity_clean_metadata(p_metadata,false);
  v_outcome:=case coalesce(v_metadata->>'outcome','') when 'attempt' then 'attempted' when 'view' then 'viewed'
    when '' then case when p_event='page_view' then 'viewed' else 'attempted' end else v_metadata->>'outcome' end;
  if v_outcome not in ('attempted','viewed','success','failed','skipped','denied') then
    raise exception 'Unsupported reported outcome.' using errcode='22023';
  end if;
  v_actor:=public.admin_activity_actor();
  -- Bounds storage abuse without suppressing saved database changes.
  perform pg_advisory_xact_lock(hashtextextended('admin-activity-client:'||auth.uid()::text,0));
  if (select count(*) from public.admin_activity_log where actor_id=auth.uid() and source='client_reported'
      and occurred_at>clock_timestamp()-interval '1 minute')>=120 then
    raise exception 'Too many reported activity events. Please try again shortly.' using errcode='54000';
  end if;
  v_category:=case p_event when 'page_view' then 'navigation' when 'export' then 'export'
    when 'sign_in' then 'access' when 'sign_out' then 'access' else 'interaction' end;
  v_action:=coalesce(nullif(v_metadata->>'action',''),p_event);
  v_summary:=case p_event when 'page_view' then 'Viewed '||coalesce(p_page,'admin')
    when 'export' then 'Reported export' when 'sign_in' then 'Reported sign in' when 'sign_out' then 'Reported sign out'
    when 'action_attempt' then 'Attempted '||v_action else 'Reported result: '||v_action end;
  v_metadata:=(v_metadata-'outcome')||jsonb_build_object('page',p_page,'event',p_event);
  return public.admin_activity_write(v_actor,'client_reported',v_category,v_action,
    coalesce(v_metadata->>'entityType','admin_page'),coalesce(v_metadata->>'entityId',p_page),v_summary,v_outcome,
    '{}',null,null,v_metadata);
end $$;

create function public.record_admin_server_activity(
  p_actor_id uuid,p_event text,p_target_type text,p_target_id text,p_outcome text,p_details jsonb default '{}'
) returns bigint language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v_actor jsonb; v_outcome text; v_details jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service authentication is required.' using errcode='42501';
  end if;
  v_actor:=public.admin_activity_actor(p_actor_id);
  if p_actor_id is null or v_actor->>'kind'<>'service_account' or v_actor->>'id' is distinct from p_actor_id::text then
    raise exception 'A verified active management account is required.' using errcode='42501';
  end if;
  if p_event is null or p_event not in ('edge_request','action_attempt','action_result','sign_in','sign_out') then
    raise exception 'Unsupported server activity event.' using errcode='22023';
  end if;
  v_outcome:=case p_outcome when 'started' then 'attempted' when 'succeeded' then 'success' else p_outcome end;
  if v_outcome is null or v_outcome not in ('attempted','success','failed','denied','skipped') then
    raise exception 'Unsupported server activity outcome.' using errcode='22023';
  end if;
  if coalesce(p_target_type,'') !~ '^[A-Za-z][A-Za-z0-9_-]{0,99}$' or length(p_target_id)>180 or p_target_id ~ '[[:cntrl:]]' then
    raise exception 'Invalid server activity target.' using errcode='22023';
  end if;
  v_details:=public.admin_activity_clean_metadata(p_details,true);
  return public.admin_activity_write(v_actor,'server_reported',case when p_event in ('sign_in','sign_out') then 'access' else 'interaction' end,
    coalesce(nullif(v_details->>'action',''),p_event),p_target_type,p_target_id,'Server reported '||replace(p_event,'_',' '),v_outcome,
    '{}',null,null,v_details||jsonb_build_object('event',p_event));
end $$;

create function public.owner_activity_log_list(
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
  select coalesce(jsonb_agg(jsonb_build_object('id',x.actor_id,'name',x.actor_name,'role',x.actor_role) order by x.actor_name),'[]') into v_actors
    from (select distinct on (actor_id) actor_id,actor_name,actor_role from public.admin_activity_log where actor_id is not null order by actor_id,id desc) x;
  select * into v_state from public.admin_activity_state where singleton;
  select coalesce(jsonb_agg(c.relname order by c.relname),'[]') into v_tables from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and t.tgname='zzz_admin_activity_change' and not c.relispartition;
  return jsonb_build_object('startedAt',v_state.started_at,'items',v_items,'nextCursor',v_next,'actors',v_actors,
    'capabilities',jsonb_build_object('authAuditCaptured',v_state.auth_audit_hook_installed,
      'authAuditHookInstalled',v_state.auth_audit_hook_installed,'authEventsObserved',exists(select 1 from public.admin_activity_log where source='auth_event'),
      'automaticTableCoverage',v_state.automatic_table_coverage,'trackedTables',v_tables));
end $$;

create function public.owner_activity_log_detail(p_id bigint)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare v_event jsonb;
begin
  if not public.admin_activity_is_owner() then raise exception 'Only the system owner can read activity history.' using errcode='42501'; end if;
  select to_jsonb(l)||jsonb_build_object('id',l.id::text) into v_event from public.admin_activity_log l where l.id=p_id;
  if v_event is null then raise exception 'Activity entry not found.' using errcode='P0002'; end if;
  return v_event;
end $$;

-- Definer helpers never become public RPC write/read backdoors.
do $$ declare v_proc regprocedure; begin
  for v_proc in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and (p.proname like 'admin_activity_%' or p.proname in
      ('record_admin_activity','record_admin_server_activity','owner_activity_log_list','owner_activity_log_detail')) loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',v_proc);
  end loop;
end $$;
grant execute on function public.admin_activity_is_owner() to authenticated;
grant execute on function public.record_admin_activity(text,text,jsonb) to authenticated;
grant execute on function public.record_admin_server_activity(uuid,text,text,text,text,jsonb) to service_role;
grant execute on function public.owner_activity_log_list(timestamptz,timestamptz,text,uuid,bigint,integer),
  public.owner_activity_log_detail(bigint) to authenticated;

commit;
