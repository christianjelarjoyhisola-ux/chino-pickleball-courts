-- Run after 20260909233000_activity_operator_directory.sql as the migration role.
-- Every account and history fixture is rolled back. Never remove the final ROLLBACK.
begin;

create temporary table activity_directory_fixture (
  label text primary key,
  id uuid not null default gen_random_uuid(),
  account_role text not null,
  account_status text not null default 'active',
  display_name text,
  login_name text
);
insert into activity_directory_fixture(label,account_role,account_status,display_name,login_name) values
  ('owner','owner','active','Directory test owner',null),
  ('court_owner','court_owner','active','  Directory test court owner  ',null),
  ('suspended','court_owner','suspended','Directory test suspended operator',null),
  ('pending','staff','pending','Directory test pending staff',null),
  ('staff','staff','active','Directory test staff',null),
  ('host','host','active','Directory test unused host',null),
  ('inactive_owner','owner','suspended','Directory test inactive owner',null),
  ('canonical','staff','active','  Current operator name  ',null),
  ('demoted','host','active','Current host name',null),
  ('deleted','court_owner','active','Deleted account old name',null),
  ('username','court_owner','active','   ','  activity_directory_username_fallback  '),
  ('history_name','court_owner','active','   ','   '),
  ('generic_name','staff','active','   ','    ');
update activity_directory_fixture set login_name='activity_directory_'||id::text where login_name is null;
grant select on activity_directory_fixture to authenticated,anon;

create function pg_temp.activity_directory_claims(p_role text,p_id uuid default null)
returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claim.role',p_role,true);
  perform set_config('request.jwt.claim.sub',coalesce(p_id::text,''),true);
  perform set_config('request.jwt.claims',jsonb_build_object('role',p_role,'sub',p_id)::text,true);
end $$;

-- Service fixtures create system-attributed account changes, never an action by the new account.
select pg_temp.activity_directory_claims('service_role');
select set_config('request.headers','{}',true);
insert into public.accounts(id,username,full_name,email,role,status)
select id,login_name,display_name,'directory-'||id::text||'@example.invalid',account_role,account_status
from activity_directory_fixture;

-- Historical rows are synthetic test evidence only and disappear with this transaction.
insert into public.admin_activity_log(actor_id,actor_name,actor_role,actor_kind,source,category,action,summary,outcome)
select id,'Older historical name','court_owner','account','client_reported','interaction','directory_fixture','Directory fixture','attempted'
from activity_directory_fixture where label in ('canonical','deleted');
insert into public.admin_activity_log(actor_id,actor_name,actor_role,actor_kind,source,category,action,summary,outcome)
select id,case label when 'deleted' then '  Latest deleted operator  '
    when 'history_name' then '  Historical name fallback  ' else 'Historical operator name' end,
  'court_owner','account','client_reported','interaction','directory_fixture','Directory fixture','attempted'
from activity_directory_fixture where label in ('canonical','deleted','demoted','history_name');
delete from public.accounts where id=(select id from activity_directory_fixture where label='deleted');

do $$ begin
  if exists(select 1 from public.admin_activity_log l join activity_directory_fixture f on f.id=l.actor_id
      where f.label in ('court_owner','suspended','pending','staff','host','inactive_owner','username','generic_name')) then
    raise exception 'Zero-history operator fixtures unexpectedly have actor activity';
  end if;
end $$;

select pg_temp.activity_directory_claims('authenticated',id) from activity_directory_fixture where label='owner';
set local role authenticated;
do $$
declare v_page jsonb; v_empty jsonb; v_actors jsonb; v_entry jsonb; v_fixture record; v_count bigint;
begin
  select count(*) into v_count from public.admin_activity_log;
  v_page:=public.owner_activity_log_list(p_limit=>1);
  v_actors:=v_page->'actors';
  if jsonb_typeof(v_actors) is distinct from 'array' then raise exception 'Operator directory is not an array'; end if;

  for v_fixture in select * from activity_directory_fixture where label<>'host' loop
    if (select count(*) from jsonb_array_elements(v_actors) a where a->>'id'=v_fixture.id::text)<>1 then
      raise exception 'Operator must appear exactly once: %',v_fixture.label;
    end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(v_actors) a
      where a->>'id'=(select id::text from activity_directory_fixture where label='host')) then
    raise exception 'Host without operator history should not populate the operator directory';
  end if;
  if exists(select 1 from jsonb_array_elements(v_actors) a where a->>'id' is null
      or a ? 'email' or a ? 'actor_email' or a ? 'password') then
    raise exception 'Operator directory exposed extra fields or a system pseudo-account';
  end if;

  for v_fixture in select * from activity_directory_fixture where label not in ('host','deleted','history_name','generic_name') loop
    select a into v_entry from jsonb_array_elements(v_actors) a where a->>'id'=v_fixture.id::text;
    if v_entry->>'name' is distinct from coalesce(nullif(btrim(v_fixture.display_name),''),btrim(v_fixture.login_name))
      or v_entry->>'role' is distinct from v_fixture.account_role then
      raise exception 'Canonical operator name or role not used: %',v_fixture.label;
    end if;
  end loop;
  select a into v_entry from jsonb_array_elements(v_actors) a
    where a->>'id'=(select id::text from activity_directory_fixture where label='deleted');
  if v_entry->>'name' is distinct from 'Latest deleted operator' or v_entry->>'role' is distinct from 'court_owner' then
    raise exception 'Deleted operator latest historical identity was lost';
  end if;
  select a into v_entry from jsonb_array_elements(v_actors) a
    where a->>'id'=(select id::text from activity_directory_fixture where label='history_name');
  if v_entry->>'name' is distinct from 'Historical name fallback' then raise exception 'Historical name fallback failed'; end if;
  select a into v_entry from jsonb_array_elements(v_actors) a
    where a->>'id'=(select id::text from activity_directory_fixture where label='generic_name');
  if v_entry->>'name' is distinct from 'Account' then raise exception 'Generic account name fallback failed'; end if;

  -- A court owner with no activity must remain selectable when their filter produces no rows.
  v_empty:=public.owner_activity_log_list(p_actor_id=>(select id from activity_directory_fixture where label='court_owner'));
  if v_empty->'items' is distinct from '[]'::jsonb or v_empty->'actors' is distinct from v_actors then
    raise exception 'Zero-activity operator filter lost directory entries or invented activity';
  end if;
  v_empty:=public.owner_activity_log_list(p_from=>clock_timestamp()+interval '100 years',
    p_to=>clock_timestamp()+interval '101 years',p_category=>'courts',
    p_actor_id=>(select id from activity_directory_fixture where label='court_owner'),p_before_id=>0,p_limit=>1);
  if v_empty->'items' is distinct from '[]'::jsonb or v_empty->'actors' is distinct from v_actors then
    raise exception 'Operator directory incorrectly depends on date, category, actor, cursor or page size';
  end if;
  if v_count<>(select count(*) from public.admin_activity_log) then raise exception 'Reading the directory created fake activity'; end if;
end $$;
reset role;

-- Canonical active system-owner authorization remains mandatory for the entire response.
set local role authenticated;
do $$ declare v_fixture record; v_denied boolean; begin
  for v_fixture in select * from activity_directory_fixture where label in ('court_owner','staff','host','inactive_owner') loop
    perform pg_temp.activity_directory_claims('authenticated',v_fixture.id);
    v_denied:=false;
    begin perform public.owner_activity_log_list(); exception when insufficient_privilege then v_denied:=true; end;
    if not v_denied then raise exception 'Unauthorized operator directory access: %',v_fixture.label; end if;
    if exists(select 1 from public.admin_activity_log) then raise exception 'Unauthorized direct activity access: %',v_fixture.label; end if;
  end loop;
end $$;
reset role;

select pg_temp.activity_directory_claims('anon');
set local role anon;
do $$ declare v_denied boolean:=false; begin
  begin perform public.owner_activity_log_list(); exception when insufficient_privilege then v_denied:=true; end;
  if not v_denied then raise exception 'Anonymous operator directory access allowed'; end if;
end $$;
reset role;

select 'passed' as activity_operator_directory_regression;
rollback;
