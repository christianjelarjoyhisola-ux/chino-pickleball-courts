-- Run after the promo migration, or append inside a trial migration transaction.
-- All settings, accounts, courts and bookings below disappear with ROLLBACK.
begin;

do $test$
declare
  day date := greatest(timezone('Asia/Manila', now())::date, public.court_opening_date()) + 2;
  rejected boolean;
  bad_rate numeric;
begin
  if exists(select 1 from public.courts where id like 'chino-promo-test-%') then
    raise exception 'Promo test identifiers already exist; refusing to reuse them.';
  end if;
  insert into public.accounts(id, username, full_name, email, role, status) values
    ('f0100000-0000-4000-8000-000000000001','chino_promo_test_owner','Promo test owner','promo-owner@example.invalid','owner','active'),
    ('f0100000-0000-4000-8000-000000000002','chino_promo_test_courtowner','Promo test court owner','promo-courtowner@example.invalid','court_owner','active'),
    ('f0100000-0000-4000-8000-000000000003','chino_promo_test_staff','Promo test staff','promo-staff@example.invalid','staff','active'),
    ('f0100000-0000-4000-8000-000000000004','chino_promo_test_host','Promo test host','promo-host@example.invalid','host','active');
  insert into public.settings(key,value) values ('pricing_tiers','[]'),('open_hour','6'),('close_hour','24'),('payment_method_cash','1')
    on conflict(key) do update set value=excluded.value;
  insert into public.courts(id,name,rate,rate_schedule,promo_enabled,promo_rate,promo_start_date,promo_end_date) values
    ('chino-promo-test-main','Promo test court',60,'[{"from":6,"to":18,"rate":300},{"from":18,"to":24,"rate":400}]',true,150,day,day+2),
    ('chino-promo-test-base','Promo base court',120,null,true,90,null,null);

  if public.calculate_booking_court_total('chino-promo-test-main',array['17','18'])
       + public.calculate_booking_service_fee(array['17','18']) <> 700 then
    raise exception 'The original two-argument normal calculator changed.';
  end if;
  if public.calculate_booking_court_total('chino-promo-test-main',array['17','18'],day)
       + public.calculate_booking_service_fee(array['17','18']) <> 300
     or public.calculate_booking_court_total('chino-promo-test-main',array['17','18'],day+2)
       + public.calculate_booking_service_fee(array['17','18']) <> 300 then
    raise exception 'Start/end play dates must both include the hourly promo.';
  end if;
  if public.calculate_booking_court_total('chino-promo-test-main',array['17','18'],day-1)
       + public.calculate_booking_service_fee(array['17','18']) <> 700
     or public.calculate_booking_court_total('chino-promo-test-main',array['17','18'],day+3)
       + public.calculate_booking_service_fee(array['17','18']) <> 700 then
    raise exception 'Out-of-range play dates must use normal tiers.';
  end if;
  if public.calculate_booking_court_total('chino-promo-test-base',array['8','9'],day)
       + public.calculate_booking_service_fee(array['8','9']) <> 180 then
    raise exception 'Open date bounds or simple court pricing failed.';
  end if;
  update public.courts set promo_start_date=day,promo_end_date=null where id='chino-promo-test-base';
  if public.court_promo_is_active('chino-promo-test-base',day-1)
     or not public.court_promo_is_active('chino-promo-test-base',day+100) then
    raise exception 'Start-only promo bounds failed.';
  end if;
  update public.courts set promo_start_date=null,promo_end_date=day where id='chino-promo-test-base';
  if not public.court_promo_is_active('chino-promo-test-base',day-1)
     or public.court_promo_is_active('chino-promo-test-base',day+1) then
    raise exception 'End-only promo bounds failed.';
  end if;

  foreach bad_rate in array array[0::numeric,-1,300,400,12.345,'NaN'::numeric,'Infinity'::numeric] loop
    rejected := false;
    begin
      update public.courts set promo_rate=bad_rate where id='chino-promo-test-main';
    exception when sqlstate '22023' or check_violation then rejected := true;
    end;
    if not rejected then raise exception 'An invalid promo rate was accepted.'; end if;
  end loop;
  rejected := false;
  begin
    update public.courts set promo_end_date=day-1 where id='chino-promo-test-main';
  exception when sqlstate '22023' or check_violation then rejected := true;
  end;
  if not rejected then raise exception 'A reversed promo window was accepted.'; end if;
  rejected := false;
  begin
    update public.courts set promo_rate=null where id='chino-promo-test-main';
  exception when sqlstate '22023' or check_violation then rejected := true;
  end;
  if not rejected then raise exception 'An enabled promo without a rate was accepted.'; end if;

  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  perform public.submit_public_booking_holds(jsonb_build_array(
    jsonb_build_object('ref','CHINO-PROMO-TEST-PUBLIC','full_name','Promo test','email','promo@example.invalid','court_id','chino-promo-test-main','date',day,'slots',jsonb_build_array('8','9'),'rate',1,'total',1,'payment_method','cash'),
    jsonb_build_object('ref','CHINO-PROMO-TEST-END','full_name','Promo test','email','promo@example.invalid','court_id','chino-promo-test-main','date',day+2,'slots',jsonb_build_array('8'),'rate',1,'total',1,'payment_method','cash'),
    jsonb_build_object('ref','CHINO-PROMO-TEST-BEFORE','full_name','Promo test','email','promo@example.invalid','court_id','chino-promo-test-main','date',day-1,'slots',jsonb_build_array('8'),'rate',1,'total',1,'payment_method','cash'),
    jsonb_build_object('ref','CHINO-PROMO-TEST-AFTER','full_name','Promo test','email','promo@example.invalid','court_id','chino-promo-test-main','date',day+3,'slots',jsonb_build_array('8'),'rate',1,'total',1,'payment_method','cash')
  ),repeat('a',64));
  perform set_config('paddle_rage.public_booking_submission','off',true);
  if not exists(select 1 from public.bookings where ref='CHINO-PROMO-TEST-PUBLIC' and total=300 and rate=150 and duration=2)
     or not exists(select 1 from public.bookings where ref='CHINO-PROMO-TEST-END' and total=150 and rate=150)
     or not exists(select 1 from public.bookings where ref='CHINO-PROMO-TEST-BEFORE' and total=300)
     or not exists(select 1 from public.bookings where ref='CHINO-PROMO-TEST-AFTER' and total=300) then
    raise exception 'Public holds trusted supplied prices or ignored play-date bounds.';
  end if;
  rejected := false;
  begin
    perform public.submit_public_booking_holds(jsonb_build_array(jsonb_build_object(
      'ref','CHINO-PROMO-TEST-TAMPER','full_name','Promo test','court_id','chino-promo-test-main','date',day,
      'slots',jsonb_build_array('12','13'),'rate',1,'total',1,'downpayment',1,'payment_method','cash'
    )),repeat('a',64));
  exception when sqlstate '22023' then rejected := true;
  end;
  perform set_config('paddle_rage.public_booking_submission','off',true);
  if not rejected then raise exception 'A tampered public payment amount was accepted.'; end if;
end;
$test$;

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"f0100000-0000-4000-8000-000000000004","role":"authenticated"}',true);
insert into public.bookings(ref,full_name,email,court_id,court_name,date,slots,start_time,end_time,duration,rate,total,payment_method,payment_status,status,host_booking)
values('CHINO-PROMO-TEST-HOST','Promo host','promo-host@example.invalid','chino-promo-test-main','Untrusted court name',
  greatest(timezone('Asia/Manila',now())::date,public.court_opening_date())+2,array['10','11'],'10:00 AM','12:00 PM',2,1,1,'cash','unpaid','verifying',true);
do $test$
begin
  if not exists(select 1 from public.bookings where ref='CHINO-PROMO-TEST-HOST' and total=300 and rate=150
    and host_booking and host_user_id=auth.uid() and created_via='host') then
    raise exception 'Authenticated host holds did not snapshot the authoritative promo.';
  end if;
end;
$test$;

select set_config('request.jwt.claims','{"sub":"f0100000-0000-4000-8000-000000000003","role":"authenticated"}',true);
do $test$
declare changed integer; rejected boolean := false;
begin
  update public.courts set promo_enabled=false where id='chino-promo-test-main';
  get diagnostics changed=row_count;
  if changed<>0 then raise exception 'Staff changed a court promo through RLS.'; end if;
  begin
    insert into public.courts(id,name,rate,promo_enabled,promo_rate) values('chino-promo-test-staff','Forbidden',300,true,150);
  exception when insufficient_privilege then rejected := true;
  end;
  if not rejected then raise exception 'Staff inserted a court promo through RLS.'; end if;
end;
$test$;

select set_config('request.jwt.claims','{"sub":"f0100000-0000-4000-8000-000000000001","role":"authenticated"}',true);
do $test$
declare
  changed integer;
  day date := greatest(timezone('Asia/Manila',now())::date,public.court_opening_date())+2;
  previous_fee numeric;
begin
  select booking_fee_amount_snapshot into previous_fee from public.bookings where ref='CHINO-PROMO-TEST-PUBLIC';
  update public.courts set promo_enabled=false where id='chino-promo-test-main';
  get diagnostics changed=row_count;
  if changed<>1 then raise exception 'Owner could not disable the court promo.'; end if;
  update public.bookings set status='confirmed' where ref='CHINO-PROMO-TEST-PUBLIC';
  perform public.reschedule_bookings_transaction('CHINO-PROMO-TEST-PUBLIC',jsonb_build_array(jsonb_build_object(
    'bookingRef','CHINO-PROMO-TEST-PUBLIC','date',(day+5)::text,'startHour',17,
    'expectedDate',day::text,'expectedCourtId','chino-promo-test-main','expectedSlots',jsonb_build_array(8,9)
  )));
  if not exists(select 1 from public.bookings where ref='CHINO-PROMO-TEST-PUBLIC' and total=300 and rate=150
    and duration=2 and slots=array['17','18'] and date=day+5
    and booking_fee_amount_snapshot is not distinct from previous_fee) then
    raise exception 'Disabling/rescheduling repriced an existing booking or its fee snapshot.';
  end if;
end;
$test$;

select set_config('request.jwt.claims','{"sub":"f0100000-0000-4000-8000-000000000002","role":"authenticated"}',true);
do $test$
declare changed integer;
begin
  update public.courts set promo_enabled=true where id='chino-promo-test-main';
  get diagnostics changed=row_count;
  if changed<>1 then raise exception 'Court owner could not re-enable the promo.'; end if;
end;
$test$;
reset role;
select set_config('request.jwt.claims','{}',true);

do $test$
declare day date := greatest(timezone('Asia/Manila',now())::date,public.court_opening_date())+2;
begin
  update public.settings set value='[{"from":6,"to":18,"rate":200},{"from":18,"to":24,"rate":250}]' where key='pricing_tiers';
  insert into public.courts(id,name,rate,promo_enabled,promo_rate)
    values('chino-promo-test-global','Global fallback promo',60,true,150);
  if public.calculate_booking_court_total('chino-promo-test-global',array['8','19'],day)
    +public.calculate_booking_service_fee(array['8','19'])<>300 then
    raise exception 'The global fallback incorrectly used the inactive base rate.';
  end if;
  update public.settings set value='[{"from":6,"to":18,"rate":100},{"from":18,"to":24,"rate":250}]' where key='pricing_tiers';
  if public.calculate_booking_court_total('chino-promo-test-global',array['8','19'],day)
    +public.calculate_booking_service_fee(array['8','19'])<>250 then
    raise exception 'A changed global tier let a promo increase a normal slot price.';
  end if;
  update public.courts set promo_enabled=false where id='chino-promo-test-global';
  if public.calculate_booking_court_total('chino-promo-test-global',array['8','19'],day)
    +public.calculate_booking_service_fee(array['8','19'])<>350 then
    raise exception 'A disabled promo failed to restore normal hourly tiers.';
  end if;
end;
$test$;

select 'PASS: promo bounds, normal tiers, public/host canonical prices, RLS, toggles, immutable reschedule and global-tier safety' as validation;
rollback;
