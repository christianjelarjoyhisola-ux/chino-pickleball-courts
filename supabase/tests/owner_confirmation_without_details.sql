-- Run inside a transaction and roll back. Production tables are never mutated.
create temporary table owner_test_bookings as select * from public.bookings with no data;
create temporary table owner_test_audits (like public.booking_owner_payment_confirmations including defaults);
create temporary table owner_test_accounts (id uuid, role text, status text);
insert into owner_test_accounts values ('00000000-0000-4000-8000-000000001010','owner','active');
create function pg_temp.owner_test_role() returns text language sql stable as $$
  select role from pg_temp.owner_test_accounts where id=auth.uid() and status='active'
$$;
create function pg_temp.owner_test_allowed(roles text[]) returns boolean language sql stable as $$
  select coalesce(pg_temp.owner_test_role() = any(roles), false)
$$;
do $$
declare body text;
begin
  body := pg_get_functiondef('public.confirm_booking_transaction(text)'::regprocedure);
  body := replace(body, 'public.confirm_booking_transaction(', 'pg_temp.owner_test_confirm(');
  body := replace(body, 'public.bookings', 'pg_temp.owner_test_bookings');
  body := replace(body, 'public.booking_owner_payment_confirmations', 'pg_temp.owner_test_audits');
  body := replace(body, 'public.has_account_role', 'pg_temp.owner_test_allowed');
  body := replace(body, 'public.current_account_role', 'pg_temp.owner_test_role');
  execute body;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000001010',true);
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000001010","role":"authenticated"}',true);
do $$
declare actor text; result record; denied boolean;
begin
  foreach actor in array array['owner','court_owner','staff','host'] loop
    truncate owner_test_bookings, owner_test_audits;
    update owner_test_accounts set role=actor;
    insert into owner_test_bookings (ref,booking_group_ref,status,payment_status,payment_method,total,downpayment,email,host_booking)
      values ('TEST-OWNER-A','TEST-OWNER-G','pending','for_verification','maya',265,265,'test@example.invalid',false),
             ('TEST-OWNER-B','TEST-OWNER-G','pending','for_verification','maya',795,795,'test@example.invalid',false);
    denied := false;
    begin
      select * into result from pg_temp.owner_test_confirm('TEST-OWNER-A');
    exception when insufficient_privilege then denied := true;
    end;
    if actor in ('staff','host') then
      if not denied or exists(select 1 from owner_test_audits) then raise exception 'Unauthorized confirmation: %',actor; end if;
      continue;
    end if;
    if denied or not result.transitioned then raise exception 'Owner confirmation failed'; end if;
    if (select count(*) from owner_test_bookings where status='confirmed' and payment_status='paid' and paid_at is not null and gcash_ref is null) <> 2 then
      raise exception 'Group confirmation or reference preservation failed';
    end if;
    if (select count(*) from owner_test_audits where confirmed_by=auth.uid() and confirmed_role=actor and missing_reference and missing_receipt and confirmed_amount=1060) <> 1 then
      raise exception 'Owner confirmation audit missing';
    end if;
    select * into result from pg_temp.owner_test_confirm('TEST-OWNER-A');
    if result.transitioned or (select count(*) from owner_test_audits) <> 1 then raise exception 'Repeat click was not idempotent'; end if;
  end loop;
  update owner_test_accounts set role='owner',status='inactive';
  denied:=false;
  begin perform pg_temp.owner_test_confirm('TEST-OWNER-A'); exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'Inactive owner accepted'; end if;
  update owner_test_accounts set status='active';
  update owner_test_bookings set gcash_ref='B6DCF633F08C';
  insert into owner_test_bookings (ref,payment_method,gcash_ref) values ('TEST-OTHER','maya','B6DCF633F08C');
  denied:=false;
  begin perform pg_temp.owner_test_confirm('TEST-OWNER-A'); exception when unique_violation then denied:=true; end;
  if not denied then raise exception 'Known duplicate reference accepted'; end if;
  delete from owner_test_bookings where ref='TEST-OTHER';
  update owner_test_bookings set gcash_ref=null,status='cancelled';
  denied:=false;
  begin perform pg_temp.owner_test_confirm('TEST-OWNER-A'); exception when invalid_parameter_value then denied:=true; end;
  if not denied then raise exception 'Cancelled booking accepted'; end if;
  update owner_test_bookings set status='pending',total=null;
  denied:=false;
  begin perform pg_temp.owner_test_confirm('TEST-OWNER-A'); exception when invalid_parameter_value then denied:=true; end;
  if not denied then raise exception 'Unknown booking amount accepted'; end if;
end $$;
