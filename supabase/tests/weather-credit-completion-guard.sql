-- All fixtures, emails and closures are rolled back; no player is contacted.
begin;
do $$
declare actor uuid; target date:=timezone('Asia/Manila',now())::date+44; closure uuid; replacement uuid; item_a uuid; item_b uuid; token text;
begin
  select id into actor from public.accounts where role='owner' and status='active' limit 1;
  if actor is null then raise exception 'Owner prerequisite missing'; end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  insert into public.courts(id,name,rate) values('wx-complete-a','Weather complete court A',300),('wx-complete-b','Weather complete court B',300);
  insert into public.settings(key,value) values('open_hour','6'),('close_hour','24') on conflict(key) do update set value=excluded.value;
  insert into public.bookings(ref,booking_group_ref,full_name,email,court_id,court_name,date,slots,start_time,end_time,duration,rate,total,downpayment,status,payment_status,created_via)
    values('PB-WX-COMPLETE-A','PB-WX-COMPLETE-G','Weather complete fixture','weather@example.invalid','wx-complete-a','Weather complete court A',target,array['19'],'7:00 PM','8:00 PM',1,300,300,300,'confirmed','paid','admin'),
          ('PB-WX-COMPLETE-B','PB-WX-COMPLETE-G','Weather complete fixture','weather@example.invalid','wx-complete-b','Weather complete court B',target,array['19'],'7:00 PM','8:00 PM',1,300,300,300,'confirmed','paid','admin');
  closure:=(public.create_weather_closure(target,'[{"courtId":"wx-complete-a","hour":19},{"courtId":"wx-complete-b","hour":19}]','rain',gen_random_uuid(),array['PB-WX-COMPLETE-A','PB-WX-COMPLETE-B'])->>'id')::uuid;
  select id,access_token into replacement,token from public.weather_replacements where closure_id=closure;
  select id into item_a from public.weather_replacement_items where replacement_id=replacement and booking_ref='PB-WX-COMPLETE-A';
  select id into item_b from public.weather_replacement_items where replacement_id=replacement and booking_ref='PB-WX-COMPLETE-B';

  -- The player moves court B only; court A keeps its unused credit.
  perform public.confirm_weather_replacement(token,item_b,target+1,19);
  begin update public.bookings set status='completed' where ref='PB-WX-COMPLETE-A'; raise exception 'Booking with unused credit was completed'; exception when sqlstate '42501' then null; end;
  if not exists(select 1 from public.weather_replacement_items where id=item_a and status='pending') then raise exception 'Unused credit was closed'; end if;
  -- The used credit's booking still completes normally.
  update public.bookings set status='completed' where ref='PB-WX-COMPLETE-B';
  -- Court A can still be rebooked later, after the other court was completed.
  perform public.confirm_weather_replacement(token,item_a,target+2,19);
  if (select date from public.bookings where ref='PB-WX-COMPLETE-A')<>target+2 then raise exception 'Remaining credit not redeemable'; end if;
  update public.bookings set status='completed' where ref='PB-WX-COMPLETE-A';
end $$;
select 'PASS: unused weather credit blocks completion, used credit completes, remaining credit stays redeemable' as result;
rollback;
