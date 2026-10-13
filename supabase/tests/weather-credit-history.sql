begin;
do $$
declare actor uuid; c uuid; r uuid; result jsonb; next_page jsonb;
begin
  select id into actor from accounts where role='owner' and status='active' limit 1;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  insert into weather_closures(date,reason,created_by,request_key) values(current_date,'rain',actor,gen_random_uuid()) returning id into c;
  insert into weather_replacements(closure_id,family_key,customer_name) values(c,'CREDIT-ROLLBACK-GROUP','Weather history rollback fixture') returning id into r;
  insert into weather_replacement_items(replacement_id,booking_ref,court_id,old_date,old_slots,duration,status,new_date,new_slots,completed_at)
  select r,'CREDIT-ROLLBACK-'||n,'fixture-court',current_date-n,array['18'],1,case when n<=55 then 'completed' else 'pending' end,current_date,array['19'],now()-n*interval '1 minute' from generate_series(1,60) n;
  result:=get_weather_credits('Weather history rollback fixture','used',0);
  if result->>'total'<>'55' or jsonb_array_length(result->'items')<>50 or result->'items'->0->>'ref'<>'CREDIT-ROLLBACK-1' then raise exception 'All-date used ordering/pagination failed'; end if;
  next_page:=get_weather_credits('Weather history rollback fixture','used',50);
  if jsonb_array_length(next_page->'items')<>5 or next_page->'items'->0->>'ref'<>'CREDIT-ROLLBACK-51' then raise exception 'Next page failed'; end if;
  if get_weather_credits('CREDIT-ROLLBACK-GROUP','all',0)->>'total'<>'60' then raise exception 'Group search failed'; end if;
  if get_weather_credits('Weather history rollback fixture','available',0)->>'total'<>'5' then raise exception 'Available filter failed'; end if;
  if result->'items'->0->>'refundStatus'<>'blocked' then raise exception 'Refund block missing'; end if;
  if get_weather_credits('%','used',0)->>'total'<>'0' then raise exception 'Search wildcard treated as all'; end if;
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000000',true);
  begin perform get_weather_credits();raise exception 'Unauthorized credit access accepted';exception when sqlstate '42501' then null;end;
  if has_function_privilege('anon','public.get_weather_credits(text,text,integer)','execute') then raise exception 'Anonymous access granted';end if;
end $$;
select 'PASS: all-date history, newest used first, player/group search, filters, pagination, refund block, access control' as result;
rollback;
