-- All fixtures, emails and closures are rolled back; no player is contacted.
begin;
do $$
declare actor uuid; target date:=timezone('Asia/Manila',now())::date+42; closure uuid; replacement uuid; item uuid; token text; result jsonb; options jsonb; before_payment jsonb; after_payment jsonb; repeat_key uuid:=gen_random_uuid();
begin
  select id into actor from public.accounts where role='owner' and status='active' limit 1;
  if actor is null then raise exception 'Owner prerequisite missing'; end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  insert into public.courts(id,name,rate) values('wx-test-court','Weather rollback court',300);
  insert into public.settings(key,value) values('open_hour','6'),('close_hour','24') on conflict(key) do update set value=excluded.value;
  insert into public.bookings(ref,booking_group_ref,full_name,email,court_id,court_name,date,slots,start_time,end_time,duration,rate,total,downpayment,status,payment_status,created_via)
    values('PB-WX-TEST-A','PB-WX-TEST-G','Weather fixture','weather@example.invalid','wx-test-court','Weather rollback court',target,array['8','9'],'8:00 AM','10:00 AM',2,300,600,600,'confirmed','paid','admin'),
          ('PB-WX-TEST-B','PB-WX-TEST-G','Weather fixture','weather@example.invalid','wx-test-court','Weather rollback court',target,array['11'],'11:00 AM','12:00 PM',1,300,300,300,'confirmed','paid','admin');
  select to_jsonb(b)-array['date','slots','start_time','end_time','weather_affected'] into before_payment from public.bookings b where ref='PB-WX-TEST-A';
  begin
    perform public.create_weather_closure(target,'[{"courtId":"wx-test-court","hour":8}]','rain',gen_random_uuid(),'{}');
    raise exception 'Stale review was accepted';
  exception when sqlstate '40001' then null; end;
  result:=public.create_weather_closure(target,'[{"courtId":"wx-test-court","hour":8},{"courtId":"wx-test-court","hour":11},{"courtId":"wx-test-court","hour":12}]','rain',repeat_key,array['PB-WX-TEST-A','PB-WX-TEST-B']);
  closure:=(result->>'id')::uuid;
  if result->>'affectedBookings'<>'2' then raise exception 'Incorrect affected count'; end if;
  result:=public.get_weather_desk(target);
  if not (result->'slots' @> '[{"courtId":"wx-test-court","hour":12}]'::jsonb) then raise exception 'Owner closure grid missing'; end if;
  if result::text like '%access_token%' then raise exception 'Private token in general owner list'; end if;
  if not (public.get_public_weather_closures() @> jsonb_build_array(jsonb_build_object('courtId','wx-test-court','date',target,'hour',12,'reason','rain'))) then raise exception 'Public weather label missing'; end if;
  if not (public.create_weather_closure(target,'[]','rain',repeat_key,'{}')->>'repeated')::boolean then raise exception 'Retry not idempotent'; end if;
  if (select count(*) from public.weather_email_outbox where replacement_id in(select id from public.weather_replacements where closure_id=closure))<>1 then raise exception 'Grouped email duplicated'; end if;
  if public.booking_reschedule_schedule_available('wx-test-court',target,array['12']) then raise exception 'Weather slot offered for reschedule'; end if;
  begin
    insert into public.bookings(ref,full_name,email,court_id,date,slots,duration,status,created_via) values('PB-WX-BLOCKED','Fixture','test@example.invalid','wx-test-court',target,array['12'],1,'confirmed','admin');
    raise exception 'Booking in closed slot was accepted';
  exception when sqlstate '23P01' then null; end;
  select id,access_token into replacement,token from public.weather_replacements where closure_id=closure;
  select id into item from public.weather_replacement_items where replacement_id=replacement and booking_ref='PB-WX-TEST-A';
  perform public.reopen_weather_closure(closure);
  if not exists(select 1 from public.weather_replacement_items where id=item and status='pending') then raise exception 'Reopening revoked player rights'; end if;
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000000',true);
  perform set_config('request.jwt.claim.role','anon',true);
  begin perform public.get_weather_desk(target); raise exception 'Anonymous owner access accepted'; exception when sqlstate '42501' then null; end;
  begin perform public.get_weather_replacement(repeat('0',64)); raise exception 'Invalid token accepted'; exception when sqlstate '42501' then null; end;
  begin perform public.confirm_weather_replacement(token,gen_random_uuid(),target+1,9); raise exception 'Wrong item accepted'; exception when sqlstate '42501' then null; end;
  options:=public.get_weather_replacement_options(token,item,target+1);
  if not (options->'starts' @> '[9]'::jsonb) then raise exception 'Expected replacement unavailable'; end if;
  result:=public.confirm_weather_replacement(token,item,target+1,9);
  if (select date from public.bookings where ref='PB-WX-TEST-A')<>target+1 then raise exception 'Date not moved'; end if;
  select to_jsonb(b)-array['date','slots','start_time','end_time','weather_affected'] into after_payment from public.bookings b where ref='PB-WX-TEST-A';
  if before_payment is distinct from after_payment then raise exception 'Payment or unrelated booking data changed: %', (select jsonb_object_agg(key,value) from jsonb_each(after_payment) where value is distinct from before_payment->key); end if;
  perform public.confirm_weather_replacement(token,item,target+2,12);
  if (select date from public.bookings where ref='PB-WX-TEST-A')<>target+1 then raise exception 'Replacement redeemed twice'; end if;
  if (select count(*) from public.weather_email_outbox where item_id=item and kind='confirmation')<>1 then raise exception 'Confirmation duplicated'; end if;
  if has_table_privilege('anon','public.weather_replacements','select') or has_table_privilege('authenticated','public.weather_replacements','select') then raise exception 'Private tokens exposed'; end if;
  if has_function_privilege('anon','public.claim_weather_emails()','execute') then raise exception 'Public notification worker access'; end if;
  -- Host balances pause while weather-affected, then use the new visit date.
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  insert into public.bookings(ref,full_name,email,court_id,date,slots,start_time,end_time,duration,rate,total,downpayment,status,payment_status,created_via,host_booking)
    values('PB-WX-HOST','Host fixture','host@example.invalid','wx-test-court',target,array['17'],'5:00 PM','6:00 PM',1,300,300,100,'confirmed','downpayment_paid','admin',true);
  result:=public.create_weather_closure(target,'[{"courtId":"wx-test-court","hour":17}]','wet_court',gen_random_uuid(),array['PB-WX-HOST']);
  if (select balance_due_at from public.bookings where ref='PB-WX-HOST') is not null then raise exception 'Weather host deadline not paused'; end if;
  select r.access_token,i.id into token,item from public.weather_replacements r join public.weather_replacement_items i on i.replacement_id=r.id where r.closure_id=(result->>'id')::uuid;
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000000',true);
  perform set_config('request.jwt.claim.role','anon',true);
  perform public.confirm_weather_replacement(token,item,target+2,18);
  if not exists(select 1 from public.bookings where ref='PB-WX-HOST' and total=300 and downpayment=100 and not weather_affected and balance_due_at=public.host_balance_deadline_at_ph(target+2)) then raise exception 'Host balance or deadline incorrect'; end if;
end;
$$;
select 'PASS: closure scope, stale review, booking guard, grouped email, authorization, availability, free replacement, retry, reopen, private tokens' as result;
rollback;
