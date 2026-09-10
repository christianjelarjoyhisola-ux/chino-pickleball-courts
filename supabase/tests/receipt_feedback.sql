-- Run only inside a transaction that the caller always rolls back.
-- Synthetic audit rows use negative IDs and never settle a booking/payment.
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);

do $test$
declare
  evidence jsonb;
  altered jsonb;
  preference jsonb;
  event public.receipt_feedback_events%rowtype;
  report jsonb;
  i integer;
  count_value integer;
  blocked boolean;
  revision text := 'receipt_feedback_rollback_test_v1';
begin
  -- RLS and grants: even service clients cannot submit their own training rows.
  if has_table_privilege('anon','public.receipt_feedback_events','SELECT')
    or has_table_privilege('authenticated','public.receipt_feedback_events','SELECT')
    or has_table_privilege('authenticated','public.receipt_feedback_events','INSERT')
    or has_table_privilege('service_role','public.receipt_feedback_events','INSERT')
    or has_table_privilege('service_role','public.receipt_feedback_events','UPDATE')
    or has_table_privilege('service_role','public.receipt_feedback_events','DELETE')
    or has_function_privilege('authenticated','public.receipt_preferred_reading_strategy(text,text)','EXECUTE')
    or has_function_privilege('anon','public.receipt_feedback_report(integer)','EXECUTE') then
    raise exception 'Feedback permissions are too broad';
  end if;
  if not (select relrowsecurity from pg_class where oid='public.receipt_feedback_events'::regclass) then
    raise exception 'Feedback table RLS missing';
  end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
  blocked := false;
  begin perform public.receipt_preferred_reading_strategy('gcash_express_send',revision);
  exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'Browser caller accessed strategy selection'; end if;
  blocked := false;
  begin perform public.receipt_feedback_report(30);
  exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'Nonowner accessed aggregate report'; end if;

  evidence := jsonb_build_object(
    'provider','gcash','parserVersion','gcash_v1','verifierRevision',revision,
    'ocrConfidence',.94,'originalOcrConfidence',.88,'approvalConfidence',.95,'gcash',jsonb_build_object('indicators',jsonb_build_object('classification','gcash')),
    'verification',jsonb_build_object('decision','valid','sourceProviderMatch',true,'referenceMatch',true,
      'amountMatch',true,'timestampValid',true,'recipientMatch',true,'duplicateClear',true,'destinationProvider','gcash'),
    'feedback',jsonb_build_object('version','receipt_feedback_v1','parserRevision',revision,'layout','gcash_express_send',
      'durationMs',420,'ocrCalls',3,'strategies',jsonb_build_array(
        jsonb_build_object('id','gcash_full_contrast_v1','attempted',true,'hardChecksClean',true,'outcome','clean','durationMs',100,'ocrCalls',1,'confidence',.95),
        jsonb_build_object('id','gcash_full_enlarged_v1','attempted',true,'hardChecksClean',true,'outcome','clean','durationMs',200,'ocrCalls',1,'confidence',.95)
      )));
  -- A browser-authored audit cannot populate any feedback despite its claims.
  insert into public.receipt_verifications(id,booking_ref,result,flags,confidence,image_hash,extracted)
    values(-913000000,'FEEDBACK-ROLLBACK-NO-BOOKING','auto_approved','{}',.95,repeat(md5('feedback-browser'),2),evidence);
  if exists(select 1 from public.receipt_feedback_events where receipt_verification_id=-913000000) then
    raise exception 'Untrusted browser audit populated feedback';
  end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);

  for i in 1..4 loop
    insert into public.receipt_verifications(id,booking_ref,result,flags,confidence,image_hash,extracted)
      values(-913000000-i,'FEEDBACK-ROLLBACK-NO-BOOKING','auto_approved','{}',.95,repeat(md5('feedback-clean-'||i),2),evidence);
  end loop;
  preference := public.receipt_preferred_reading_strategy('gcash_express_send',revision);
  if preference->>'strategy' is not null or (preference->>'minimumSamples')::integer<>5 then
    raise exception 'Preference activated before five distinct clean receipts';
  end if;
  -- Re-reading a single image, or repeating an audit, cannot inflate samples.
  for i in 10..13 loop
    insert into public.receipt_verifications(id,booking_ref,result,flags,confidence,image_hash,extracted)
      values(-913000000-i,'FEEDBACK-ROLLBACK-NO-BOOKING','auto_approved','{}',.95,repeat(md5('feedback-clean-1'),2),evidence);
  end loop;
  preference := public.receipt_preferred_reading_strategy('gcash_express_send',revision);
  if preference->>'strategy' is not null or (preference#>>'{stats,0,samples}')::integer<>4 then
    raise exception 'Repeated image inflated preference samples';
  end if;
  insert into public.receipt_verifications(id,booking_ref,result,flags,confidence,image_hash,extracted)
    values(-913000020,'FEEDBACK-ROLLBACK-NO-BOOKING','auto_approved','{}',.95,repeat(md5('feedback-clean-5'),2),evidence);
  preference := public.receipt_preferred_reading_strategy('gcash_express_send',revision);
  if preference->>'strategy'<>'gcash_full_contrast_v1' or (preference->>'eligibleSamples')::integer<>5 then
    raise exception 'Fixed successful strategy not ranked by measured time';
  end if;
  if (select original_confidence from public.receipt_feedback_events where receipt_verification_id=-913000020)<>.88 then
    raise exception 'Original native OCR confidence replaced with recovery score';
  end if;
  if (public.receipt_preferred_reading_strategy('gcash_express_send',revision||'-new'))->>'strategy' is not null
    or (public.receipt_preferred_reading_strategy('unknown',revision))->>'strategy' is not null then
    raise exception 'Strategies leaked between revision/layout';
  end if;

  -- A high confidence, valid-looking read with any hard-check failure is not a
  -- clean sample, even when the strategy itself claims success.
  altered := jsonb_set(evidence,'{verification,duplicateClear}','false');
  insert into public.receipt_verifications(id,booking_ref,result,flags,confidence,image_hash,extracted)
    values(-913000021,'FEEDBACK-ROLLBACK-NO-BOOKING','auto_approved','{}',.95,repeat(md5('feedback-invalid'),2),altered);
  select * into event from public.receipt_feedback_events where receipt_verification_id=-913000021;
  if event.outcome is distinct from 'pending' or event.strategies#>>'{0,clean}' is distinct from 'false' then
    raise exception 'Failed database evidence counted as successful OCR';
  end if;
  if (public.receipt_preferred_reading_strategy('gcash_express_send',revision)->>'eligibleSamples')::integer<>5 then
    raise exception 'Bad read changed clean sample total';
  end if;
  -- Wrong feedback revision, unknown strategy, omitted ID, invalid timing, and
  -- externally supplied merchant/threshold data are never learned.
  altered := jsonb_set(evidence,'{feedback,parserRevision}','"poison"');
  insert into public.receipt_verifications(id,booking_ref,result,flags,confidence,image_hash,extracted)
    values(-913000022,'FEEDBACK-ROLLBACK-NO-BOOKING','auto_approved','{}',.95,repeat(md5('feedback-wrong-revision'),2),altered);
  select * into event from public.receipt_feedback_events where receipt_verification_id=-913000022;
  if event.layout<>'unknown' or event.strategies<>'[]'::jsonb then raise exception 'Wrong revision trained strategy'; end if;
  altered := jsonb_set(evidence,'{feedback,strategies}',jsonb_build_array(
    jsonb_build_object('id','attacker_strategy','attempted',true,'outcome','clean','hardChecksClean',true),
    jsonb_build_object('attempted',true,'outcome','clean','hardChecksClean',true),
    jsonb_build_object('id','gcash_full_contrast_v1','attempted',true,'outcome','clean','hardChecksClean',false,
      'durationMs','-10','ocrCalls',999,'confidence',5,'merchant','POISON','threshold',.1)
  ));
  insert into public.receipt_verifications(id,booking_ref,result,flags,confidence,image_hash,extracted)
    values(-913000023,'FEEDBACK-ROLLBACK-NO-BOOKING','manual_review',array['BLURRY'],.88,repeat(md5('feedback-poison'),2),altered);
  select * into event from public.receipt_feedback_events where receipt_verification_id=-913000023;
  if jsonb_array_length(event.strategies)<>1 or event.strategies#>>'{0,id}'<>'gcash_full_contrast_v1'
    or event.strategies#>>'{0,clean}'<>'false' or event.strategies#>'{0,durationMs}'<>'null'::jsonb
    or event.strategies#>'{0,ocrCalls}'<>'null'::jsonb or event.strategies#>'{0,confidence}'<>'null'::jsonb
    or event.strategies::text like '%POISON%' then raise exception 'Untrusted feedback fields leaked into preference'; end if;
  altered := jsonb_set(evidence,'{feedback,strategies,0,confidence}','0.89');
  altered := jsonb_set(altered,'{feedback,strategies,1,confidence}','null');
  insert into public.receipt_verifications(id,booking_ref,result,flags,confidence,image_hash,extracted)
    values(-913000024,'FEEDBACK-ROLLBACK-NO-BOOKING','auto_approved','{}',.95,repeat(md5('feedback-low-confidence'),2),altered);
  select * into event from public.receipt_feedback_events where receipt_verification_id=-913000024;
  if event.strategies#>>'{0,clean}' is distinct from 'false' or event.strategies#>>'{1,clean}' is distinct from 'false' then
    raise exception 'Low or missing strategy confidence counted as clean';
  end if;
  altered := jsonb_set(evidence,'{gcash,indicators,classification}','"unknown"');
  insert into public.receipt_verifications(id,booking_ref,result,flags,confidence,image_hash,extracted)
    values(-913000025,'FEEDBACK-ROLLBACK-NO-BOOKING','manual_review',array['BLURRY'],.88,repeat(md5('feedback-unknown-layout'),2),altered);
  select * into event from public.receipt_feedback_events where receipt_verification_id=-913000025;
  if event.layout<>'unknown' or event.strategies#>>'{0,clean}' is distinct from 'false' or event.ocr_calls<>3 then
    raise exception 'Unknown layouts must retain attempt metrics without training recognized layouts';
  end if;

  -- Owner approval describes a workflow decision, never native OCR success.
  if public.receipt_feedback_decision_outcome('{"status":"pending","payment_status":"for_verification"}',
    '{"status":"confirmed","payment_status":"paid","receipt_status":"manual_review"}')<>'manual_confirmed'
    or public.receipt_feedback_decision_outcome('{"status":"pending","payment_status":"for_verification"}',
    '{"status":"pending","payment_status":"rejected"}')<>'rejected'
    or public.receipt_feedback_decision_outcome('{"status":"confirmed","payment_status":"paid"}',
    '{"status":"confirmed","payment_status":"paid","receipt_status":"auto_approved"}') is not null then
    raise exception 'Manual decision classification incorrect';
  end if;
  insert into public.receipt_feedback_events(event_key,event_type,booking_ref,receipt_image_hash,provider,parser_revision,layout,outcome)
    values('rollback-manual','decision','FEEDBACK-ROLLBACK-NO-BOOKING',repeat(md5('feedback-poison'),2),'gcash',revision,'gcash_express_send','manual_confirmed');
  if (public.receipt_preferred_reading_strategy('gcash_express_send',revision)->>'eligibleSamples')::integer<>5 then
    raise exception 'Owner confirmation trained OCR correctness';
  end if;
  report := public.receipt_feedback_report(30);
  if report->>'correctnessAvailable' is distinct from 'false' or report->'falseApprovalRate'<>'null'::jsonb
    or (report#>>'{outcomes,manual_confirmed}')::integer<1
    or report->'averageDurationMs'='null'::jsonb then raise exception 'Aggregate report omitted outcome/latency/unknown-correctness'; end if;
  -- Existing analysis remains append-only when a subsequent outcome is recorded.
  if (select outcome from public.receipt_feedback_events where receipt_verification_id=-913000023)<>'pending' then
    raise exception 'Later outcome rewrote original feedback';
  end if;
end $test$;

-- Prove unavailable telemetry storage cannot prevent the underlying audit.
create function pg_temp.feedback_fail_storage() returns trigger language plpgsql as $$ begin raise exception 'synthetic feedback outage'; end $$;
create trigger rollback_feedback_outage before insert on public.receipt_feedback_events
for each row execute function pg_temp.feedback_fail_storage();
insert into public.receipt_verifications(id,booking_ref,result,flags,confidence,image_hash,extracted)
values(-913000099,'FEEDBACK-ROLLBACK-NO-BOOKING','manual_review',array['BLURRY'],.5,repeat(md5('feedback-storage-outage'),2),'{}');
do $$ begin
  if not exists(select 1 from public.receipt_verifications where id=-913000099) then raise exception 'Telemetry failure blocked receipt audit'; end if;
  if exists(select 1 from public.receipt_feedback_events where receipt_verification_id=-913000099) then raise exception 'Synthetic outage not exercised'; end if;
end $$;
drop trigger rollback_feedback_outage on public.receipt_feedback_events;
