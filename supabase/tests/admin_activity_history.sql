-- Run after 20260909230000_admin_activity_history.sql. All fixtures, court changes,
-- promotion changes, auth events and history entries are rolled back.
begin;

create temporary table activity_test_context as
select
  (select id from public.accounts where role='owner' and status='active' order by created_at limit 1) owner_id,
  (select id from public.accounts where role='court_owner' and status='active' order by created_at limit 1) court_owner_id,
  (select min(id) from public.courts) court_id,
  gen_random_uuid() request_id;
grant select on activity_test_context to authenticated,anon,service_role;
do $$ begin
  if exists(select 1 from activity_test_context where owner_id is null or court_owner_id is null or court_id is null) then
    raise exception 'Regression test requires one active owner, one active court owner, and one court.';
  end if;
end $$;

create function pg_temp.activity_test_claims(p_role text,p_id uuid default null)
returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claim.role',p_role,true);
  perform set_config('request.jwt.claim.sub',coalesce(p_id::text,''),true);
  perform set_config('request.jwt.claims',jsonb_build_object('role',p_role,'sub',p_id)::text,true);
end $$;

-- A fresh business table also checks automatic registration when that capability exists.
create table public.activity_history_test_fixture (
  id text primary key,
  blocked boolean not null default false,
  payload jsonb,
  gcash_number text,
  valid_id_path text,
  valid_id_file_name text,
  account_number text,
  bank_account text,
  updated_at timestamptz not null default now()
);
grant select,insert,update,delete on public.activity_history_test_fixture to authenticated,service_role;
do $$ begin
  if (select automatic_table_coverage from public.admin_activity_state) and not exists (
    select 1 from pg_trigger where tgrelid='public.activity_history_test_fixture'::regclass and tgname='zzz_admin_activity_change'
  ) then raise exception 'New business table was not automatically covered'; end if;
  perform public.admin_activity_register_table('public.activity_history_test_fixture');
end $$;

select pg_temp.activity_test_claims('authenticated',court_owner_id) from activity_test_context;
select set_config('request.headers',jsonb_build_object('x-chino-audit-actor',owner_id,'x-chino-audit-request',request_id)::text,true) from activity_test_context;

-- A browser cannot spoof the owner through the service attribution headers.
set local role authenticated;
insert into public.activity_history_test_fixture(id,payload) values ('activity-test-human',
  '{"pricing":{"rate":265,"tiers":[{"from":17,"to":23,"rate":265}]},"maintenance":{"dates":["2026-09-09"],"hours":["18:00"]},"password":"DO-NOT-LOG-PASSWORD","receipt_url":"DO-NOT-LOG-RECEIPT","nested":{"access_token":"DO-NOT-LOG-TOKEN"}}');
update public.activity_history_test_fixture set blocked=true where id='activity-test-human';
reset role;
do $$ declare v_row public.admin_activity_log%rowtype; v_count integer; begin
  select * into v_row from public.admin_activity_log where entity_type='activity_history_test_fixture' and entity_id='activity-test-human' order by id desc limit 1;
  if v_row.source<>'database_change' or v_row.actor_id<>(select court_owner_id from activity_test_context)
    or v_row.actor_role<>'court_owner' or v_row.actor_kind<>'account' or v_row.action<>'update'
    or v_row.outcome<>'success' or v_row.changed_fields<>array['blocked']
    or v_row.before_data->>'blocked'<>'false' or v_row.after_data->>'blocked'<>'true'
    or v_row.metadata ? 'requestId' then raise exception 'Confirmed write attribution, diff, or spoofed-header guard failed'; end if;
  if v_row.after_data::text ~ 'DO-NOT-LOG-' or v_row.after_data#>>'{payload,pricing,rate}'<>'265'
    or v_row.after_data#>>'{payload,maintenance,dates,0}'<>'2026-09-09' then
    raise exception 'Nested secret redaction lost safe business details or leaked sensitive data'; end if;
  select count(*) into v_count from public.admin_activity_log where entity_type='activity_history_test_fixture' and entity_id='activity-test-human';
  update public.activity_history_test_fixture set blocked=blocked where id='activity-test-human';
  update public.activity_history_test_fixture set updated_at=clock_timestamp() where id='activity-test-human';
  if v_count<>(select count(*) from public.admin_activity_log where entity_type='activity_history_test_fixture' and entity_id='activity-test-human') then
    raise exception 'No-op or timestamp-only update created a false change'; end if;
end $$;

-- Real schema field names for wallet numbers and identity uploads must be hidden,
-- while changed_fields continues to explain which sensitive fields were replaced.
update public.activity_history_test_fixture set gcash_number='09123456789',valid_id_path='identity/private-id.pdf',
  valid_id_file_name='private-passport.pdf',account_number='123456789012',bank_account='987654321098'
  where id='activity-test-human';
do $$ declare v_event public.admin_activity_log%rowtype; v_field text; begin
  select * into v_event from public.admin_activity_log where entity_type='activity_history_test_fixture'
    and entity_id='activity-test-human' order by id desc limit 1;
  if v_event.changed_fields<>array['account_number','bank_account','gcash_number','valid_id_file_name','valid_id_path'] then
    raise exception 'Sensitive field change names were lost'; end if;
  foreach v_field in array v_event.changed_fields loop
    if v_event.before_data->>v_field<>'[REDACTED]' or v_event.after_data->>v_field<>'[REDACTED]' then
      raise exception 'Sensitive field value leaked: %',v_field;
    end if;
  end loop;
  if v_event.after_data::text ~ '(09123456789|private-id|private-passport|123456789012|987654321098)' then
    raise exception 'Wallet/account number or identity upload leaked'; end if;
  if public.admin_activity_snapshot('{"key":"gcash_number","value":"09123456789"}','settings')->>'value'<>'[REDACTED]' then
    raise exception 'Wallet number setting leaked'; end if;
end $$;

-- Actual court toggles and an existing management RPC are captured without instrumenting callers.
do $$ declare v_court text; v_previous boolean; v_last bigint; v_actor uuid; begin
  select court_id,court_owner_id into v_court,v_actor from activity_test_context;
  select blocked into v_previous from public.courts where id=v_court;
  update public.courts set blocked=not v_previous where id=v_court;
  if not exists(select 1 from public.admin_activity_log where entity_type='courts' and entity_id=v_court
    and actor_id=v_actor and changed_fields @> array['blocked'] and after_data->>'blocked'=(not v_previous)::text) then
    raise exception 'Actual court pause/resume was not recorded'; end if;
  update public.courts set blocked=v_previous where id=v_court;
  select coalesce(max(id),0) into v_last from public.admin_activity_log;
  perform public.set_all_courts_promo(true,0.01,current_date,current_date+1);
  if not exists(select 1 from public.admin_activity_log where id>v_last and entity_type='courts'
    and actor_id=v_actor and source='database_change' and 'promo_rate'=any(changed_fields)) then
    raise exception 'RPC-triggered court writes were not recorded'; end if;
end $$;

-- Settings values may themselves be serialized JSON; secret setting keys must hide their values.
insert into public.settings(key,value) values ('admin_activity_test_api_secret','HIDE-ME-INSERT');
update public.settings set value='HIDE-ME-UPDATE' where key='admin_activity_test_api_secret';
do $$ declare v_clean jsonb; begin
  if not exists(select 1 from public.admin_activity_log where entity_type='settings' and entity_id='admin_activity_test_api_secret'
    and action='update' and changed_fields=array['value'] and before_data->>'value'='[REDACTED]' and after_data->>'value'='[REDACTED]')
    or exists(select 1 from public.admin_activity_log where entity_id='admin_activity_test_api_secret'
      and (coalesce(before_data::text,'')||coalesce(after_data::text,'')) like '%HIDE-ME%') then
    raise exception 'Stored settings mutation leaked sensitive values or lost the changed field'; end if;
  v_clean:=public.admin_activity_snapshot('{"key":"maintenance_config","value":"{\"dates\":[\"2026-09-09\"],\"token\":\"HIDE-ME\"}"}','settings');
  if v_clean#>>'{value,dates,0}'<>'2026-09-09' or v_clean::text like '%HIDE-ME%' then raise exception 'Serialized settings redaction failed'; end if;
  v_clean:=public.admin_activity_snapshot('{"key":"telegram_bot_token","value":"HIDE-ME"}','settings');
  if v_clean->>'value'<>'[REDACTED]' then raise exception 'Secret setting value leaked'; end if;
  v_clean:=public.admin_activity_redact('{"note":"https://example.test/?access_token=HIDE-ME","receipt":"base64-HIDE-ME","email":"private@example.test"}');
  if v_clean::text ~ '(HIDE-ME|private@example)' then raise exception 'Sensitive content leaked'; end if;
end $$;

-- Client records can report an attempt/result, but cannot choose identity/source/before/after.
set local role authenticated;
select public.record_admin_activity('action_result','courts',
  '{"action":"saveCourt","entityType":"courts","entityId":"activity-test-target","outcome":"success","actor_id":"00000000-0000-0000-0000-000000000001","source":"database_change","password":"HIDE-ME","before_data":{"blocked":false}}');
select public.record_admin_activity('page_view','insights','{"outcome":"view"}');
reset role;
do $$ declare v_event public.admin_activity_log%rowtype; v_denied boolean:=false; begin
  select * into v_event from public.admin_activity_log where entity_id='activity-test-target' order by id desc limit 1;
  if v_event.actor_id<>(select court_owner_id from activity_test_context) or v_event.source<>'client_reported'
    or v_event.before_data is not null or v_event.after_data is not null or v_event.metadata ? 'actor_id'
    or v_event.metadata ? 'source' or v_event.metadata::text like '%HIDE-ME%' then
    raise exception 'Client reporting can spoof confirmed data or leaked extra metadata'; end if;
  begin perform public.record_admin_activity('database_change','courts','{}'); exception when invalid_parameter_value then v_denied:=true; end;
  if not v_denied then raise exception 'Client could claim a database change'; end if;
end $$;

-- Court owner has zero history rows and cannot call owner RPCs or any privileged writer.
set local role authenticated;
do $$ declare v_denied boolean; begin
  if (select count(*) from public.admin_activity_log)<>0 then raise exception 'Court owner can read history'; end if;
  v_denied:=false;
  begin perform public.owner_activity_log_list(); exception when insufficient_privilege then v_denied:=true; end;
  if not v_denied then raise exception 'Court owner list RPC allowed'; end if;
  v_denied:=false;
  begin perform public.owner_activity_log_detail(1); exception when insufficient_privilege then v_denied:=true; end;
  if not v_denied then raise exception 'Court owner detail RPC allowed'; end if;
  v_denied:=false;
  begin perform public.record_admin_server_activity((select owner_id from activity_test_context),'edge_request','edge_function','test','success','{}');
  exception when insufficient_privilege then v_denied:=true; end;
  if not v_denied then raise exception 'Court owner can spoof server reports'; end if;
  v_denied:=false;
  begin insert into public.admin_activity_log(actor_name,actor_role,actor_kind,source,category,action,summary,outcome)
    values('Forged','owner','account','database_change','courts','update','Forged','success');
  exception when insufficient_privilege then v_denied:=true; end;
  if not v_denied then raise exception 'Court owner direct history insert allowed'; end if;
  v_denied:=false;
  begin perform public.admin_activity_write('{}','database_change','courts','update',null,null,'Forged','success');
  exception when insufficient_privilege then v_denied:=true; end;
  if not v_denied then raise exception 'Internal writer is callable'; end if;
end $$;
reset role;

-- A missing JWT role must be false, not SQL NULL that bypasses an IF NOT guard.
select pg_temp.activity_test_claims('',owner_id) from activity_test_context;
do $$ declare v_denied boolean:=false; begin
  if public.admin_activity_is_owner() is distinct from false then raise exception 'Missing role did not fail closed'; end if;
  begin perform public.owner_activity_log_list(); exception when insufficient_privilege then v_denied:=true; end;
  if not v_denied then raise exception 'Missing role bypassed owner list guard'; end if;
end $$;

select pg_temp.activity_test_claims('anon');
set local role anon;
do $$ declare v_denied boolean; begin
  v_denied:=false;
  begin perform count(*) from public.admin_activity_log; exception when insufficient_privilege then v_denied:=true; end;
  if not v_denied then raise exception 'Anonymous history read allowed'; end if;
  v_denied:=false;
  begin perform public.owner_activity_log_list(); exception when insufficient_privilege then v_denied:=true; end;
  if not v_denied then raise exception 'Anonymous list RPC allowed'; end if;
  v_denied:=false;
  begin perform public.record_admin_activity('page_view','courts','{}'); exception when insufficient_privilege then v_denied:=true; end;
  if not v_denied then raise exception 'Anonymous reporting allowed'; end if;
end $$;
reset role;

-- Service context without a verified actor is a system job, never guessed from row data.
select pg_temp.activity_test_claims('service_role');
select set_config('request.headers','{}',true);
set local role service_role;
insert into public.activity_history_test_fixture(id) values ('activity-test-system');
reset role;
do $$ begin
  if not exists(select 1 from public.admin_activity_log where entity_id='activity-test-system' and actor_id is null
    and actor_kind='system' and actor_role='service_role') then raise exception 'System write misattributed'; end if;
end $$;

select set_config('request.headers',jsonb_build_object('x-chino-audit-actor',court_owner_id,'x-chino-audit-request',request_id)::text,true) from activity_test_context;
set local role service_role;
insert into public.activity_history_test_fixture(id) values ('activity-test-server-human');
select public.record_admin_server_activity(court_owner_id,'edge_request','edge_function','activity-test-endpoint','success',
  jsonb_build_object('endpoint','activity-test-endpoint','status',200,'requestId',request_id,'receipt','HIDE-ME')) from activity_test_context;
reset role;
do $$ begin
  if not exists(select 1 from public.admin_activity_log where entity_id='activity-test-server-human'
    and actor_id=(select court_owner_id from activity_test_context) and actor_kind='service_account'
    and metadata->>'requestId'=(select request_id::text from activity_test_context)) then raise exception 'Verified service actor or correlation missing'; end if;
  if not exists(select 1 from public.admin_activity_log where entity_id='activity-test-endpoint' and source='server_reported'
    and metadata->>'requestId'=(select request_id::text from activity_test_context) and not metadata ? 'receipt') then
    raise exception 'Service event did not retain its honest source or safe correlation'; end if;
end $$;

-- Owner access, actor/category/date filters, stable ID cursor, and redacted detail.
select pg_temp.activity_test_claims('authenticated',owner_id) from activity_test_context;
set local role authenticated;
do $$ declare v_page jsonb; v_next jsonb; v_detail jsonb; v_first bigint; v_denied boolean; begin
  v_page:=public.owner_activity_log_list(p_actor_id=>(select court_owner_id from activity_test_context),p_category=>'other',p_limit=>1);
  if jsonb_array_length(v_page->'items')<>1 or v_page->>'startedAt' is null or v_page->>'nextCursor' is null then
    raise exception 'Owner list or pagination metadata missing'; end if;
  v_first:=(v_page#>>'{items,0,id}')::bigint;
  if jsonb_typeof(v_page#>'{items,0,id}')<>'string' or v_page#>'{items,0,actor_email}' is not null
    or v_page#>'{items,0,before_data}' is not null then raise exception 'List fields are unsafe or bigint precision is lost'; end if;
  v_next:=public.owner_activity_log_list(p_actor_id=>(select court_owner_id from activity_test_context),p_category=>'other',p_before_id=>(v_page->>'nextCursor')::bigint,p_limit=>1);
  if (v_next#>>'{items,0,id}')::bigint>=v_first then raise exception 'Cursor repeated a row'; end if;
  v_detail:=public.owner_activity_log_detail(v_first);
  if v_detail->>'id'<>v_first::text or not (v_detail ? 'before_data') then raise exception 'Owner detail missing'; end if;
  v_page:=public.owner_activity_log_list(p_from=>clock_timestamp()+interval '1 day',p_to=>clock_timestamp()+interval '2 days');
  if jsonb_array_length(v_page->'items')<>0 then raise exception 'Date bounds ignored'; end if;
  if (select count(*) from public.admin_activity_log)=0 then raise exception 'Owner direct safe RLS read unavailable'; end if;
  v_denied:=false;
  begin update public.admin_activity_log set summary='Tampered' where id=v_first; exception when insufficient_privilege then v_denied:=true; end;
  if not v_denied then raise exception 'Owner modified history'; end if;
  v_denied:=false;
  begin delete from public.admin_activity_log where id=v_first; exception when insufficient_privilege then v_denied:=true; end;
  if not v_denied then raise exception 'Owner deleted history'; end if;
end $$;
reset role;

-- Even privileged accidental mutation/truncation is rejected by append-only triggers.
do $$ declare v_denied boolean; begin
  v_denied:=false;
  begin update public.admin_activity_log set summary='Tampered' where entity_id='activity-test-human'; exception when insufficient_privilege then v_denied:=true; end;
  if not v_denied then raise exception 'Privileged UPDATE bypassed append-only protection'; end if;
  v_denied:=false;
  begin delete from public.admin_activity_log where entity_id='activity-test-human'; exception when insufficient_privilege then v_denied:=true; end;
  if not v_denied then raise exception 'Privileged DELETE bypassed append-only protection'; end if;
  v_denied:=false;
  begin truncate public.admin_activity_log; exception when insufficient_privilege then v_denied:=true; end;
  if not v_denied then raise exception 'TRUNCATE bypassed append-only protection'; end if;
end $$;

-- DELETE snapshots and rolled-back operations retain truthful transaction semantics.
do $$ declare v_count integer; begin
  delete from public.activity_history_test_fixture where id='activity-test-human';
  if not exists(select 1 from public.admin_activity_log where entity_id='activity-test-human' and action='delete'
    and before_data is not null and after_data is null) then raise exception 'Delete snapshot missing'; end if;
  select count(*) into v_count from public.admin_activity_log where entity_id='activity-test-rollback';
  begin
    insert into public.activity_history_test_fixture(id) values ('activity-test-rollback');
    raise exception 'Intentional rollback' using errcode='P0099';
  exception when sqlstate 'P0099' then null; end;
  if v_count<>(select count(*) from public.admin_activity_log where entity_id='activity-test-rollback') then
    raise exception 'Rolled-back change left a false confirmed event'; end if;
end $$;

-- Optional Auth hook copies no auth payload, email/IP, token, or user-metadata claims.
do $$ declare v_auth_id uuid:=gen_random_uuid(); v_actor uuid; begin
  if (select auth_audit_hook_installed from public.admin_activity_state) then
    select court_owner_id into v_actor from activity_test_context;
    insert into auth.audit_log_entries(instance_id,id,payload,created_at,ip_address)
      values('00000000-0000-0000-0000-000000000000',v_auth_id,
        json_build_object('action','login','actor_id',v_actor,'actor_username','FORGED-NAME','secret','HIDE-ME'),now(),'192.0.2.1');
    if not exists(select 1 from public.admin_activity_log where source='auth_event' and metadata->>'authEventId'=v_auth_id::text
      and actor_id=v_actor and actor_name<>'FORGED-NAME' and metadata::text not like '%HIDE-ME%') then
      raise exception 'Auth hook canonical identity or payload minimization failed'; end if;
  end if;
end $$;

select jsonb_build_object('result','passed','coverage',jsonb_build_array(
  'confirmed direct and RPC changes','canonical identity and browser spoof denial','nested redaction',
  'client versus server source separation','owner-only read and append-only writes','cursor and date filters',
  'service correlation and system attribution','no-op and rollback semantics','future table registration','auth hook')) as activity_history_regression;
rollback;
