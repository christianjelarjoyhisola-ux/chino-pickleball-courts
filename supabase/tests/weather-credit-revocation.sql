-- All fixtures, emails and closures are rolled back; no player is contacted.
begin;
do $$
declare actor uuid; target date:=timezone('Asia/Manila',now())::date+43; closure uuid; replacement uuid; item_a uuid; item_b uuid; token text; result jsonb;
begin
  select id into actor from public.accounts where role='owner' and status='active' limit 1;
  if actor is null then raise exception 'Owner prerequisite missing'; end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  insert into public.courts(id,name,rate) values('wx-revoke-court','Weather revoke rollback court',300);
  insert into public.settings(key,value) values('open_hour','6'),('close_hour','24') on conflict(key) do update set value=excluded.value;
  insert into public.bookings(ref,booking_group_ref,full_name,email,court_id,court_name,date,slots,start_time,end_time,duration,rate,total,downpayment,status,payment_status,created_via)
    values('PB-WX-REVOKE-A','PB-WX-REVOKE-G','Weather revoke fixture','weather@example.invalid','wx-revoke-court','Weather revoke rollback court',target,array['8'],'8:00 AM','9:00 AM',1,300,300,300,'confirmed','paid','admin'),
          ('PB-WX-REVOKE-B','PB-WX-REVOKE-G','Weather revoke fixture','weather@example.invalid','wx-revoke-court','Weather revoke rollback court',target,array['11'],'11:00 AM','12:00 PM',1,300,300,300,'confirmed','paid','admin');
  result:=public.create_weather_closure(target,'[{"courtId":"wx-revoke-court","hour":8},{"courtId":"wx-revoke-court","hour":11}]','rain',gen_random_uuid(),array['PB-WX-REVOKE-A','PB-WX-REVOKE-B']);
  closure:=(result->>'id')::uuid;
  select id,access_token into replacement,token from public.weather_replacements where closure_id=closure;
  select id into item_a from public.weather_replacement_items where replacement_id=replacement and booking_ref='PB-WX-REVOKE-A';
  select id into item_b from public.weather_replacement_items where replacement_id=replacement and booking_ref='PB-WX-REVOKE-B';

  -- A refund cannot be recorded while the credit is still available.
  begin update public.bookings set downpayment=0,payment_status='unpaid' where ref='PB-WX-REVOKE-A'; raise exception 'Refund accepted with an available credit'; exception when sqlstate '42501' then null; end;

  -- Validation and access control.
  begin perform public.revoke_weather_credit(item_a,'short'); raise exception 'Short reason accepted'; exception when others then if sqlerrm not like 'Enter a reason%' then raise; end if; end;
  begin perform public.revoke_weather_credit(item_a,'Player requested refund',null,0); raise exception 'Zero refund accepted'; exception when others then if sqlerrm not like 'Enter a refund amount%' then raise; end if; end;
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000000',true);
  begin perform public.revoke_weather_credit(item_a,'Player requested refund via GCash'); raise exception 'Unauthorized revoke accepted'; exception when sqlstate '42501' then null; end;
  begin perform public.get_weather_open_credits(array['PB-WX-REVOKE-A']); raise exception 'Unauthorized credit read accepted'; exception when sqlstate '42501' then null; end;
  if has_function_privilege('anon','public.revoke_weather_credit(uuid,text,text,numeric)','execute') then raise exception 'Anonymous revoke granted'; end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);

  if not (public.get_weather_open_credits(array['PB-WX-REVOKE-A']) @> '[{"ref":"PB-WX-REVOKE-A","status":"available"}]'::jsonb) then raise exception 'Available credit missing from booking details'; end if;
  result:=public.revoke_weather_credit(item_a,'  Player requested refund via GCash  ',' GC-123 ',450);
  if result->>'status'<>'revoked' then raise exception 'Revoke result wrong'; end if;
  if not exists(select 1 from public.weather_replacement_items where id=item_a and status='revoked' and revoked_by=actor and revoke_reason='Player requested refund via GCash' and refund_reference='GC-123' and refund_amount=450) then raise exception 'Revocation record incomplete'; end if;
  if (select count(*) from public.weather_email_outbox where item_id=item_a and kind='revoked')<>1 then raise exception 'Player email not queued'; end if;
  if not exists(select 1 from public.weather_replacement_items where id=item_b and status='pending') then raise exception 'Other group credit was affected'; end if;
  begin perform public.revoke_weather_credit(item_a,'Player requested refund again'); raise exception 'Double revoke accepted'; exception when others then if sqlerrm not like '%already cancelled%' then raise; end if; end;

  -- The player can no longer redeem it, and the record cannot be edited.
  begin perform public.confirm_weather_replacement(token,item_a,target+1,9); raise exception 'Revoked credit redeemed'; exception when others then if sqlerrm not like '%booking changed%' then raise; end if; end;
  if not (public.get_weather_replacement(token)->'items' @> jsonb_build_array(jsonb_build_object('id',item_a,'status','revoked'))) then raise exception 'Player page missing revoked status'; end if;
  begin update public.weather_replacement_items set revoke_reason='Edited reason text' where id=item_a; raise exception 'Revocation edited'; exception when sqlstate '42501' then null; end;
  begin delete from public.weather_replacement_items where id=item_a; raise exception 'Revocation deleted'; exception when sqlstate '42501' then null; end;

  -- After revocation, refunds and cancellation proceed normally.
  update public.bookings set downpayment=0,payment_status='unpaid' where ref='PB-WX-REVOKE-A';
  if public.get_weather_credits('PB-WX-REVOKE-A','revoked',0)->'items'->0->>'refundStatus'<>'credit_revoked' then raise exception 'History filter or refund status wrong'; end if;
  if (public.get_weather_credits('PB-WX-REVOKE-A','available',0)->>'total')<>'0' then raise exception 'Revoked credit still listed as available'; end if;
  update public.bookings set status='cancelled' where ref='PB-WX-REVOKE-A';
  if not exists(select 1 from public.weather_replacement_items where id=item_a and status='revoked') then raise exception 'Cancellation overwrote the revocation'; end if;

  -- Used credits keep the existing system-owner exception path.
  perform public.confirm_weather_replacement(token,item_b,target+1,11);
  begin perform public.revoke_weather_credit(item_b,'Player requested refund via GCash'); raise exception 'Used credit revoked'; exception when others then if sqlerrm not like '%already used%' then raise; end if; end;
end $$;
select 'PASS: refund-first block, validation, access control, audited revocation, player email, redemption block, immutability, history filter, used-credit path' as result;
rollback;
