-- Synthetic receipt audit only; no booking, payment, or message is created. Everything rolls back.
begin;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
update public.settings set value=case key when 'payment_method_securitybank' then '1' when 'securitybank_merchant_number' then '000012342980' when 'securitybank_merchant_name' then 'CHINO TEST OWNER' end where key in ('payment_method_securitybank','securitybank_merchant_number','securitybank_merchant_name');
do $test$
declare evidence jsonb; variation jsonb; row_id bigint := -90912001; blocked boolean; keys text[];
begin
 evidence := jsonb_build_object('provider','securitybank','route','gcash_to_securitybank','parserVersion','gcash_to_securitybank_v1','verifierVersion','receipt_evidence_v1','verificationContext','host_session','ref','9900000000001','amount',1,'expectedAmount',1,'receiptAgeMinutes',2,
  'subject',jsonb_build_object('fullName','SECURITY BANK TEST','bookingDate',current_date::text,'sessionId','SECURITYBANK-TEST'),
  'dedupeKeys',jsonb_build_array(jsonb_build_object('key','securitybank:9900000000001','providerKey','securitybank'),jsonb_build_object('key','9900000000001','providerKey','gcash'),jsonb_build_object('key','gcash_instapay_invoice:TEST90912','providerKey','gcash_instapay_invoice')),
  'verification',jsonb_build_object('decision','valid','sourceProviderMatch',true,'referenceMatch',true,'amountMatch',true,'timestampValid',true,'recipientMatch',true,'duplicateClear',true,'destinationProvider','securitybank'));
 insert into public.receipt_verifications(id,booking_ref,result,flags,confidence,image_hash,extracted) values(row_id,'SECURITYBANK-PARSER-ROLLBACK','auto_approved','{}',0.99,repeat('a',64),evidence);
 perform public.assert_clean_registration_receipt(row_id,'securitybank','9900000000001','host_session',1,'https://test.invalid/'||repeat('a',64)||'.png','SECURITY BANK TEST',current_date,'SECURITYBANK-TEST',null);
 select array_agg(ledger_key order by ledger_key) into keys from public.payment_review_ledger_keys(evidence,'securitybank','9900000000001');
 if cardinality(keys)<>3 or not ('9900000000001'=any(keys)) then raise exception 'Cross-provider ledger keys lost'; end if;
 for variation in select value from jsonb_array_elements(jsonb_build_array(
   jsonb_set(evidence,'{verification,destinationProvider}','"gcash"'),
   jsonb_set(evidence,'{verification,duplicateClear}','false'),
   jsonb_set(evidence,'{verification,recipientMatch}','false'),
   jsonb_set(evidence,'{amount}','11'),
   jsonb_set(evidence,'{parserVersion}','"legacy"'),
   jsonb_set(evidence,'{receiptAgeMinutes}','16')
 )) loop
  update public.receipt_verifications set extracted=variation where id=row_id;
  blocked:=false;
  begin
   perform public.assert_clean_registration_receipt(row_id,'securitybank','9900000000001','host_session',1,'https://test.invalid/'||repeat('a',64)||'.png','SECURITY BANK TEST',current_date,'SECURITYBANK-TEST',null);
  exception when sqlstate '22023' then blocked:=true;
  end;
  if not blocked then raise exception 'Unsafe evidence accepted: %',variation; end if;
 end loop;
 update public.receipt_verifications set extracted=evidence,flags=array['AMOUNT_MISMATCH'],result='manual_review' where id=row_id;
 blocked:=false;
 begin
  perform public.assert_clean_registration_receipt(row_id,'securitybank','9900000000001','host_session',1,'https://test.invalid/'||repeat('a',64)||'.png','SECURITY BANK TEST',current_date,'SECURITYBANK-TEST',null);
 exception when sqlstate '22023' then blocked:=true;
 end;
 if not blocked then raise exception 'Pending evidence auto-approved'; end if;
end $test$;
rollback;
select 'Clean Security Bank evidence accepted; wrong destination, duplicates, recipient, amount, parser, time and pending evidence blocked; fixtures rolled back' as result;
