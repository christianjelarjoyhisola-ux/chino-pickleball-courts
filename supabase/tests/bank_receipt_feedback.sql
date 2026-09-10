-- Synthetic contracts only. Caller MUST roll back the enclosing transaction.
-- No bookings, financial ledgers, or real receipt records are updated.
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);

create function pg_temp.bank_feedback_fixture(p_provider text,p_layout text,p_revision text)
returns jsonb language sql as $$
  select jsonb_build_object(
    'provider',p_provider,'destinationProvider',case when p_provider='securitybank' then 'securitybank' else 'gcash' end,
    'route',case when p_provider='securitybank' then 'gcash_to_securitybank' else p_provider||'_to_gcash' end,
    'parserVersion',case when p_provider='securitybank' then 'gcash_to_securitybank_v1' else p_provider||'_to_gcash_v1' end,
    'verifierRevision',p_revision,'ocrConfidenceSource','native','ocrConfidence',.86,
    'originalOcrConfidence',.84,'approvalConfidence',.95,'approvalConfidenceSource','bank_payment_fields',
    'verification',jsonb_build_object('decision','valid','sourceProviderMatch',true,'referenceMatch',true,
      'amountMatch',true,'timestampValid',true,'recipientMatch',true,'duplicateClear',true,
      'destinationProvider',case when p_provider='securitybank' then 'securitybank' else 'gcash' end),
    'feedback',jsonb_build_object('version','receipt_feedback_v1','parserRevision',p_revision,'layout',p_layout,
      'durationMs',420,'ocrCalls',3,'strategies',jsonb_build_array(
        jsonb_build_object('id','bank_original_v1','attempted',true,'hardChecksClean',false,'outcome','uncertain','durationMs',80,'ocrCalls',1,'confidence',.84),
        jsonb_build_object('id','bank_full_contrast_v1','attempted',true,'hardChecksClean',true,'outcome','clean','durationMs',100,'ocrCalls',1,'confidence',.95),
        jsonb_build_object('id','bank_full_enlarged_v1','attempted',true,'hardChecksClean',true,'outcome','clean','durationMs',200,'ocrCalls',1,'confidence',.96)
      )));
$$;

do $test$
declare
  revision text:='bank_feedback_rollback_test_v1';
  fixture record; evidence jsonb; altered jsonb; preference jsonb; report jsonb;
  event public.receipt_feedback_events%rowtype;
  next_id bigint:=-914000000; i integer; kind text; blocked boolean;
  before_count bigint; before_bookings bigint; legacy_revision text:='bank_feedback_legacy_gcash_rollback_v1';
begin
  select count(*) into before_bookings from public.bookings;
  if has_function_privilege('anon','public.receipt_preferred_provider_reading_strategy(text,text,text,text)','EXECUTE')
    or has_function_privilege('authenticated','public.receipt_preferred_provider_reading_strategy(text,text,text,text)','EXECUTE')
    or not has_function_privilege('service_role','public.receipt_preferred_provider_reading_strategy(text,text,text,text)','EXECUTE')
    or has_function_privilege('service_role','public.receipt_feedback_destination(jsonb)','EXECUTE')
    or has_table_privilege('service_role','public.receipt_feedback_events','INSERT') then
    raise exception 'Bank feedback privileges are too broad';
  end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
  blocked:=false;
  begin perform public.receipt_preferred_provider_reading_strategy('maya','gcash','maya_sent_money_v1',revision);
  exception when insufficient_privilege then blocked:=true; end;
  if not blocked then raise exception 'Browser accessed bank reading preference'; end if;
  evidence:=pg_temp.bank_feedback_fixture('maya','maya_sent_money_v1',revision);
  insert into public.receipt_verifications(id,booking_ref,result,flags,confidence,image_hash,extracted)
    values(next_id,'BANK-FEEDBACK-ROLLBACK-NO-BOOKING','auto_approved','{}',.95,repeat(md5('bank-feedback-browser'),2),evidence);
  if exists(select 1 from public.receipt_feedback_events where receipt_verification_id=next_id) then
    raise exception 'Browser-created bank audit trained feedback'; end if;
  next_id:=next_id-1;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);

  -- Every fixed provider/route/layout needs its own five clean distinct images.
  for fixture in select * from (values
    ('maya','gcash','maya_sent_money_v1'),('bdopay','gcash','bdopay_sent_instapay_v1'),
    ('bpi','gcash','bpi_transfer_success_v1'),('gotyme','gcash','gotyme_transferred_v1'),
    ('gotyme','gcash','gotyme_transfer_success_v1'),('maribank','gcash','maribank_money_sent_v1'),
    ('securitybank','securitybank','securitybank_gcash_transfer_v1')
  ) f(provider,destination,layout) loop
    evidence:=pg_temp.bank_feedback_fixture(fixture.provider,fixture.layout,revision);
    for i in 1..4 loop
      insert into public.receipt_verifications(id,booking_ref,result,flags,confidence,image_hash,extracted)
        values(next_id,'BANK-FEEDBACK-ROLLBACK-NO-BOOKING','auto_approved','{}',.95,
          repeat(md5('bank-feedback-'||fixture.layout||i),2),evidence);
      next_id:=next_id-1;
    end loop;
    preference:=public.receipt_preferred_provider_reading_strategy(fixture.provider,fixture.destination,fixture.layout,revision);
    if preference->>'strategy' is not null or (preference#>>'{stats,0,samples}')::integer<>4 then
      raise exception 'Bank strategy enabled before five distinct receipts: %',fixture.layout; end if;
    for i in 1..3 loop
      insert into public.receipt_verifications(id,booking_ref,result,flags,confidence,image_hash,extracted)
        values(next_id,'BANK-FEEDBACK-ROLLBACK-NO-BOOKING','auto_approved','{}',.95,
          repeat(md5('bank-feedback-'||fixture.layout||1),2),evidence);
      next_id:=next_id-1;
    end loop;
    preference:=public.receipt_preferred_provider_reading_strategy(fixture.provider,fixture.destination,fixture.layout,revision);
    if preference->>'strategy' is not null or (preference#>>'{stats,0,samples}')::integer<>4 then
      raise exception 'Repeated bank image inflated sample count'; end if;
    insert into public.receipt_verifications(id,booking_ref,result,flags,confidence,image_hash,extracted)
      values(next_id,'BANK-FEEDBACK-ROLLBACK-NO-BOOKING','auto_approved','{}',.95,
        repeat(md5('bank-feedback-'||fixture.layout||5),2),evidence);
    select * into event from public.receipt_feedback_events where receipt_verification_id=next_id;
    next_id:=next_id-1;
    if event.destination_provider is distinct from fixture.destination or event.layout is distinct from fixture.layout
      or event.strategies#>>'{1,clean}' is distinct from 'true' or event.original_confidence is distinct from .84 then
      raise exception 'Bank scope/native field evidence not captured correctly: %',fixture.layout; end if;
    preference:=public.receipt_preferred_provider_reading_strategy(fixture.provider,fixture.destination,fixture.layout,revision);
    if preference->>'strategy' is distinct from 'bank_full_contrast_v1' or (preference->>'eligibleSamples')::integer<>5 then
      raise exception 'Bank strategy did not rank five independent clean images: %',fixture.layout; end if;
    if (public.receipt_preferred_provider_reading_strategy(fixture.provider,fixture.destination,fixture.layout,revision||'-other')->>'strategy') is not null
      or (public.receipt_preferred_provider_reading_strategy(fixture.provider,'wrong-route',fixture.layout,revision)->>'strategy') is not null
      or (public.receipt_preferred_provider_reading_strategy('gcash',fixture.destination,fixture.layout,revision)->>'strategy') is not null then
      raise exception 'Bank samples crossed provider/route/revision boundaries'; end if;
  end loop;

  -- GoTyme recipient crops are observed, never ranked as full-image strategies.
  -- The same crop identifier is rejected for every other provider.
  for fixture in select * from (values('gotyme','gotyme_transferred_v1'),('maya','maya_sent_money_v1')) f(provider,layout) loop
    evidence:=jsonb_set(pg_temp.bank_feedback_fixture(fixture.provider,fixture.layout,revision||'-crop'),'{feedback,strategies}',
      '[{"id":"bank_gotyme_recipient_pair_v1","attempted":true,"hardChecksClean":true,"outcome":"clean","confidence":0.95,"durationMs":100,"ocrCalls":2}]');
    for i in 1..5 loop
      insert into public.receipt_verifications(id,booking_ref,result,flags,confidence,image_hash,extracted)
        values(next_id,'BANK-FEEDBACK-ROLLBACK-NO-BOOKING','auto_approved','{}',.95,
          repeat(md5('bank-feedback-crop-'||fixture.provider||i),2),evidence);
      select * into event from public.receipt_feedback_events where receipt_verification_id=next_id;
      next_id:=next_id-1;
      if (fixture.provider='gotyme' and (jsonb_array_length(event.strategies)<>1 or event.strategies#>>'{0,clean}' is distinct from 'true'))
        or (fixture.provider='maya' and event.strategies<>'[]'::jsonb) then
        raise exception 'GoTyme recipient pair strategy escaped its provider scope'; end if;
    end loop;
    if (public.receipt_preferred_provider_reading_strategy(fixture.provider,'gcash',fixture.layout,revision||'-crop')->>'strategy') is not null then
      raise exception 'Recipient-only observations became a full-reading preference'; end if;
  end loop;

  -- GoTyme's two recognized layouts never pool into five samples in a new revision.
  for fixture in select * from (values('gotyme_transferred_v1',3),('gotyme_transfer_success_v1',2)) f(layout,samples) loop
    evidence:=pg_temp.bank_feedback_fixture('gotyme',fixture.layout,revision||'-split');
    for i in 1..fixture.samples loop
      insert into public.receipt_verifications(id,booking_ref,result,flags,confidence,image_hash,extracted)
        values(next_id,'BANK-FEEDBACK-ROLLBACK-NO-BOOKING','auto_approved','{}',.95,
          repeat(md5('bank-feedback-split-'||fixture.layout||i),2),evidence);
      next_id:=next_id-1;
    end loop;
    if (public.receipt_preferred_provider_reading_strategy('gotyme','gcash',fixture.layout,revision||'-split')->>'strategy') is not null then
      raise exception 'Separate layouts pooled evidence'; end if;
  end loop;

  evidence:=pg_temp.bank_feedback_fixture('maya','maya_sent_money_v1',revision||'-invalid');
  foreach kind in array array['missing_native','derived_confidence','low_confidence','missing_confidence','duplicate',
    'wrong_destination','contradictory_destination','wrong_route','wrong_parser','foreign_layout','unknown_layout','wrong_revision','unknown_strategy','pnb'] loop
    altered:=case kind
      when 'missing_native' then evidence-'ocrConfidenceSource'
      when 'derived_confidence' then jsonb_set(evidence,'{ocrConfidenceSource}','"derived"')
      when 'low_confidence' then jsonb_set(jsonb_set(evidence,'{feedback,strategies,1,confidence}','0.89'),'{feedback,strategies,2,confidence}','0.89')
      when 'missing_confidence' then jsonb_set(jsonb_set(evidence,'{feedback,strategies,1,confidence}','null'),'{feedback,strategies,2,confidence}','null')
      when 'duplicate' then jsonb_set(evidence,'{verification,duplicateClear}','false')
      when 'wrong_destination' then jsonb_set(evidence,'{verification,destinationProvider}','"securitybank"')
      when 'contradictory_destination' then jsonb_set(evidence,'{destinationProvider}','"securitybank"')
      when 'wrong_route' then jsonb_set(evidence,'{route}','"maya_to_securitybank"')
      when 'wrong_parser' then jsonb_set(evidence,'{parserVersion}','"bpi_to_gcash_v1"')
      when 'foreign_layout' then jsonb_set(evidence,'{feedback,layout}','"bpi_transfer_success_v1"')
      when 'unknown_layout' then jsonb_set(evidence,'{feedback,layout}','"new_layout"')
      when 'wrong_revision' then jsonb_set(evidence,'{feedback,parserRevision}','"poison"')
      when 'unknown_strategy' then jsonb_set(evidence,'{feedback,strategies}','[{"id":"gcash_full_contrast_v1","attempted":true,"hardChecksClean":true,"outcome":"clean","confidence":0.99},{"id":"arbitrary_model","attempted":true,"hardChecksClean":true,"outcome":"clean","confidence":0.99}]')
      when 'pnb' then evidence||'{"provider":"pnb","parserVersion":"pnb_to_gcash_v1","route":"pnb_to_gcash"}'::jsonb
    end;
    insert into public.receipt_verifications(id,booking_ref,result,flags,confidence,image_hash,extracted)
      values(next_id,'BANK-FEEDBACK-ROLLBACK-NO-BOOKING','auto_approved','{}',.95,repeat(md5('bank-feedback-invalid-'||kind),2),altered);
    select * into event from public.receipt_feedback_events where receipt_verification_id=next_id;
    next_id:=next_id-1;
    if event.id is null or exists(select 1 from jsonb_array_elements(event.strategies) s where s->>'clean'='true') then
      raise exception 'Invalid bank feedback trained a strategy: %',kind; end if;
    if kind in ('unknown_strategy','pnb','wrong_revision') and event.strategies<>'[]'::jsonb then
      raise exception 'Unsupported feedback strategy/provider accepted: %',kind; end if;
  end loop;
  if (public.receipt_preferred_provider_reading_strategy('maya','gcash','maya_sent_money_v1',revision||'-invalid')->>'strategy') is not null then
    raise exception 'Unclean bank samples activated learning'; end if;

  -- Five manual confirmations are outcomes only. They cannot train reading.
  for i in 1..5 loop
    insert into public.receipt_feedback_events(event_key,event_type,booking_ref,receipt_image_hash,provider,destination_provider,parser_revision,layout,outcome)
      values('bank-rollback-manual-'||i,'decision','BANK-FEEDBACK-ROLLBACK-NO-BOOKING',repeat(md5('bank-feedback-manual-'||i),2),
        'maya','gcash',revision||'-manual','maya_sent_money_v1','manual_confirmed');
  end loop;
  if (public.receipt_preferred_provider_reading_strategy('maya','gcash','maya_sent_money_v1',revision||'-manual')->>'strategy') is not null then
    raise exception 'Manual owner confirmations trained bank OCR'; end if;

  -- Existing GCash events have no destination column in their old payloads.
  -- This rollback-only insert represents legacy rows; no UPDATE/backfill occurs.
  for i in 1..5 loop
    insert into public.receipt_feedback_events(event_key,event_type,booking_ref,receipt_image_hash,provider,parser_revision,layout,outcome,strategies)
      values('bank-rollback-legacy-'||i,'analysis','BANK-FEEDBACK-ROLLBACK-NO-BOOKING',repeat(md5('bank-feedback-legacy-'||i),2),
        'gcash',legacy_revision,'gcash_express_send','auto_valid',
        '[{"id":"gcash_full_contrast_v1","clean":true,"outcome":"clean","confidence":0.95,"durationMs":100,"ocrCalls":1}]');
  end loop;
  if (public.receipt_preferred_reading_strategy('gcash_express_send',legacy_revision)->>'eligibleSamples')::integer<>5
    or exists(select 1 from public.receipt_feedback_events where parser_revision=legacy_revision and destination_provider<>'unknown') then
    raise exception 'GCash compatibility required a historical rewrite or lost its preference'; end if;
  report:=public.receipt_feedback_report(30);
  if report->>'correctnessAvailable' is distinct from 'false' or report->'falseApprovalRate'<>'null'::jsonb
    or not(report ?& array['byRevision','byStrategy','pendingRate','averageOriginalConfidence','byProvider','byRoute','byLayout','byProviderStrategy','byProviderRouteRevision'])
    or not exists(select 1 from jsonb_array_elements(report->'byRoute') r where r->>'provider'='securitybank' and r->>'destination_provider'='securitybank')
    or not exists(select 1 from jsonb_array_elements(report->'byProviderStrategy') r where r->>'provider'='maya' and r->>'destination_provider'='gcash' and r->>'layout'='maya_sent_money_v1' and r->>'parser_revision'=revision) then
    raise exception 'Provider/route/layout reporting missing or claimed payment correctness'; end if;
  if (select count(*) from public.bookings)<>before_bookings then raise exception 'Feedback test changed booking count'; end if;
end $test$;
