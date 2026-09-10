-- Extend advisory OCR telemetry without changing booking/payment state or rules.
begin;
do $$ begin
  if public.chino_project_url() <> 'https://wskzptxekldhsxluhgos.supabase.co' then
    raise exception 'CHINO project guard failed';
  end if;
end $$;

-- A constant default preserves old rows without rewriting their observations.
alter table public.receipt_feedback_events
  add column if not exists destination_provider text not null default 'unknown';
create index if not exists receipt_feedback_events_provider_policy_idx
  on public.receipt_feedback_events(provider,destination_provider,layout,parser_revision,id desc)
  where event_type='analysis';

create or replace function public.receipt_feedback_scope_is_known(p_provider text,p_destination text,p_layout text)
returns boolean language sql immutable set search_path=public,pg_temp as $$
  select exists(select 1 from (values
    ('gcash','gcash','gcash_express_send'),
    ('maya','gcash','maya_sent_money_v1'),
    ('bdopay','gcash','bdopay_sent_instapay_v1'),
    ('bpi','gcash','bpi_transfer_success_v1'),
    ('gotyme','gcash','gotyme_transferred_v1'),
    ('gotyme','gcash','gotyme_transfer_success_v1'),
    ('maribank','gcash','maribank_money_sent_v1'),
    ('securitybank','securitybank','securitybank_gcash_transfer_v1')
  ) known(provider,destination,layout)
  where provider=p_provider and destination=p_destination and layout=p_layout);
$$;
revoke all on function public.receipt_feedback_scope_is_known(text,text,text) from public,anon,authenticated,service_role;

create or replace function public.receipt_feedback_destination(p_evidence jsonb)
returns text language plpgsql immutable set search_path=public,pg_temp as $$
declare expected text; parser text; route text;
begin
  select d,p,r into expected,parser,route from (values
    ('gcash','gcash','gcash_v1',null::text),
    ('maya','gcash','maya_to_gcash_v1','maya_to_gcash'),
    ('bdopay','gcash','bdopay_to_gcash_v1','bdopay_to_gcash'),
    ('bpi','gcash','bpi_to_gcash_v1','bpi_to_gcash'),
    ('gotyme','gcash','gotyme_to_gcash_v1','gotyme_to_gcash'),
    ('maribank','gcash','maribank_to_gcash_v1','maribank_to_gcash'),
    ('securitybank','securitybank','gcash_to_securitybank_v1','gcash_to_securitybank')
  ) known(provider,d,p,r) where provider=p_evidence->>'provider';
  if expected is null or p_evidence->>'parserVersion' is distinct from parser
     or p_evidence#>>'{verification,destinationProvider}' is distinct from expected
     or (p_evidence ? 'destinationProvider' and p_evidence->>'destinationProvider' is distinct from expected)
     or (route is not null and p_evidence->>'route' is distinct from route) then return 'unknown'; end if;
  return expected;
end $$;
revoke all on function public.receipt_feedback_destination(jsonb) from public,anon,authenticated,service_role;

create or replace function public.receipt_feedback_layout(p_evidence jsonb)
returns text language sql immutable set search_path=public,pg_temp as $$
  select case when p_evidence#>>'{feedback,version}'='receipt_feedback_v1'
    and p_evidence#>>'{feedback,parserRevision}'=coalesce(nullif(p_evidence->>'verifierRevision',''),nullif(p_evidence->>'parserVersion',''),'unknown')
    and public.receipt_feedback_scope_is_known(p_evidence->>'provider',public.receipt_feedback_destination(p_evidence),p_evidence#>>'{feedback,layout}')
    and (p_evidence->>'provider'<>'gcash' or p_evidence#>>'{gcash,indicators,classification}'='gcash')
    then p_evidence#>>'{feedback,layout}' else 'unknown' end;
$$;
revoke all on function public.receipt_feedback_layout(jsonb) from public,anon,authenticated,service_role;

-- The original release only collected this single GCash route. Resolve it at
-- read time to preserve its history; no bank/unknown-layout history is inferred.
create or replace function public.receipt_feedback_effective_destination(p_provider text,p_destination text,p_layout text)
returns text language sql immutable set search_path=public,pg_temp as $$
  select case when p_provider='gcash' and p_destination='unknown' and p_layout='gcash_express_send'
    then 'gcash' else p_destination end;
$$;
revoke all on function public.receipt_feedback_effective_destination(text,text,text) from public,anon,authenticated,service_role;

create or replace function public.receipt_feedback_capture_analysis()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare
  evidence jsonb := coalesce(new.extracted,'{}');
  feedback jsonb := coalesce(new.extracted->'feedback','{}');
  revision text := left(coalesce(nullif(new.extracted->>'verifierRevision',''),nullif(new.extracted->>'parserVersion',''),'unknown'),100);
  provider_value text := left(coalesce(new.extracted->>'provider','unknown'),30);
  destination_value text := public.receipt_feedback_destination(evidence);
  layout_value text := 'unknown';
  group_value text; clean boolean := false; strategies_value jsonb := '[]';
  candidate jsonb; strategy_id text; candidate_clean boolean;
  duration_value numeric; calls_value numeric; strategy_allowlist text[];
begin
  if coalesce(auth.role(),'')<>'service_role' or coalesce(new.image_hash,'') !~ '^[0-9a-f]{64}$' then return new; end if;
  select b.booking_group_ref into group_value from public.bookings b where b.ref=new.booking_ref;
  clean := coalesce(public.receipt_auto_approval_evidence_is_clean(new.result,new.flags,new.confidence,new.extracted),false);
  if feedback->>'version'='receipt_feedback_v1' and feedback->>'parserRevision'=revision then
    if provider_value='gcash' and evidence->>'parserVersion'='gcash_v1' then
      strategy_allowlist := array['gcash_original_v1','gcash_recipient_pair_v1','gcash_full_contrast_v1','gcash_full_enlarged_v1'];
    elsif provider_value in ('maya','bdopay','bpi','gotyme','maribank','securitybank') then
      strategy_allowlist := array['bank_original_v1','bank_full_contrast_v1','bank_full_enlarged_v1'];
      if provider_value='gotyme' then strategy_allowlist:=array_append(strategy_allowlist,'bank_gotyme_recipient_pair_v1'); end if;
    end if;
    if strategy_allowlist is not null then
      layout_value := public.receipt_feedback_layout(evidence);
      duration_value := public.receipt_feedback_bounded_number(feedback->'durationMs',600000);
      calls_value := public.receipt_feedback_bounded_number(feedback->'ocrCalls',30);
      if duration_value<>trunc(duration_value) then duration_value:=null; end if;
      if calls_value<>trunc(calls_value) then calls_value:=null; end if;
      if jsonb_typeof(feedback->'strategies')='array' and jsonb_array_length(feedback->'strategies')<=4 then
        for candidate in select value from jsonb_array_elements(feedback->'strategies') loop
          strategy_id:=candidate->>'id';
          if strategy_id is null or not(strategy_id=any(strategy_allowlist))
            or coalesce(candidate->>'attempted','')<>'true'
            or coalesce(candidate->>'outcome','') not in ('clean','uncertain','conflict','error')
            or exists(select 1 from jsonb_array_elements(strategies_value) item where item->>'id'=strategy_id) then continue; end if;
          candidate_clean:=clean and new.result='auto_approved' and layout_value<>'unknown'
            and candidate->>'hardChecksClean'='true' and candidate->>'outcome'='clean'
            and public.receipt_feedback_bounded_number(candidate->'confidence',1)>=.9
            -- GCash prior metadata remains readable. New bank samples require
            -- explicitly native OCR; field confidence may exceed page average.
            and (provider_value='gcash' or evidence->>'ocrConfidenceSource'='native');
          strategies_value:=strategies_value || jsonb_build_array(jsonb_build_object(
            'id',strategy_id,'outcome',candidate->>'outcome','clean',coalesce(candidate_clean,false),
            'durationMs',public.receipt_feedback_bounded_number(candidate->'durationMs',600000),
            'ocrCalls',public.receipt_feedback_bounded_number(candidate->'ocrCalls',30),
            'confidence',public.receipt_feedback_bounded_number(candidate->'confidence',1)));
        end loop;
      end if;
    end if;
  end if;
  insert into public.receipt_feedback_events(event_key,event_type,receipt_verification_id,booking_ref,booking_group_ref,
    receipt_image_hash,provider,destination_provider,parser_revision,layout,outcome,flags,
    original_confidence,approval_confidence,duration_ms,ocr_calls,strategies)
  values('audit:'||new.id,'analysis',new.id,new.booking_ref,group_value,new.image_hash,provider_value,destination_value,
    revision,layout_value,case when clean then 'auto_valid' else 'pending' end,coalesce(new.flags,'{}'),
    public.receipt_feedback_bounded_number(coalesce(evidence->'originalOcrConfidence',evidence->'ocrConfidence'),1),
    public.receipt_feedback_bounded_number(evidence->'approvalConfidence',1),duration_value::integer,calls_value::integer,strategies_value)
  on conflict(event_key) do nothing;
  return new;
exception when others then
  raise log 'Receipt analysis feedback unavailable (SQLSTATE %)',sqlstate;
  return new;
end $$;
revoke all on function public.receipt_feedback_capture_analysis() from public,anon,authenticated,service_role;

create or replace function public.receipt_feedback_capture_decision()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare outcome_value text; audit_id bigint; actor jsonb;
begin
  if coalesce(new.receipt_image_hash,'') !~ '^[0-9a-f]{64}$'
    or coalesce(new.payment_method,'') not in ('gcash','bdopay','maya','bpi','gotyme','maribank','pnb','securitybank') then return new; end if;
  if coalesce(auth.role(),'')<>'service_role'
    and not(auth.uid() is not null and coalesce(public.current_account_role(),'') in ('owner','court_owner')) then return new; end if;
  outcome_value:=public.receipt_feedback_decision_outcome(to_jsonb(old),to_jsonb(new));
  if outcome_value is null then return new; end if;
  actor:=public.admin_activity_actor();
  select v.id into audit_id from public.receipt_verifications v where v.image_hash=new.receipt_image_hash and
    (v.booking_ref=new.ref or v.booking_ref in(select b.ref from public.bookings b where b.booking_group_ref=new.booking_group_ref))
    order by v.id desc limit 1;
  insert into public.receipt_feedback_events(event_key,event_type,receipt_verification_id,booking_ref,booking_group_ref,
    receipt_image_hash,provider,destination_provider,parser_revision,layout,outcome,flags,actor_kind)
  values('decision:'||txid_current()||':'||new.ref||':'||coalesce(old.payment_status,'')||':'||coalesce(new.payment_status,'')||':'||outcome_value,
    'decision',audit_id,new.ref,new.booking_group_ref,new.receipt_image_hash,new.payment_method,
    case when new.receipt_extracted->>'provider'=new.payment_method then public.receipt_feedback_destination(new.receipt_extracted) else 'unknown' end,
    left(coalesce(new.receipt_extracted->>'verifierRevision',new.receipt_extracted->>'parserVersion','unknown'),100),
    case when new.receipt_extracted->>'provider'=new.payment_method then public.receipt_feedback_layout(new.receipt_extracted) else 'unknown' end,
    outcome_value,coalesce(new.receipt_flags,'{}'),coalesce(actor->>'kind','system')) on conflict(event_key) do nothing;
  return new;
exception when others then
  raise log 'Receipt decision feedback unavailable (SQLSTATE %)',sqlstate;
  return new;
end $$;
revoke all on function public.receipt_feedback_capture_decision() from public,anon,authenticated,service_role;

create or replace function public.receipt_preferred_provider_reading_strategy(
  p_provider text,p_destination_provider text,p_layout text,p_parser_revision text)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare stats_value jsonb; chosen jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Receipt strategy preferences are server-only.' using errcode='42501';
  end if;
  if not public.receipt_feedback_scope_is_known(p_provider,p_destination_provider,p_layout)
    or nullif(trim(p_parser_revision),'') is null or length(p_parser_revision)>100 then
    return jsonb_build_object('strategy',null,'eligibleSamples',0,'minimumSamples',5,'stats','[]'::jsonb);
  end if;
  with observations as (
    select distinct on(e.receipt_image_hash,s->>'id') e.receipt_image_hash,s->>'id' strategy,s->>'clean'='true' clean,
      (s->>'durationMs')::numeric duration_ms,(s->>'ocrCalls')::numeric ocr_calls
    from public.receipt_feedback_events e cross join lateral jsonb_array_elements(e.strategies) s
    where e.event_type='analysis' and e.provider=p_provider
      and public.receipt_feedback_effective_destination(e.provider,e.destination_provider,e.layout)=p_destination_provider
      and e.layout=p_layout and e.parser_revision=p_parser_revision
      and s->>'id'=any(case when p_provider='gcash' then array['gcash_full_contrast_v1','gcash_full_enlarged_v1']
        else array['bank_full_contrast_v1','bank_full_enlarged_v1'] end)
    order by e.receipt_image_hash,s->>'id',e.id desc
  ), aggregates as (
    select strategy,count(*) samples,count(*) filter(where clean) clean_samples,
      count(*) filter(where clean)::numeric/count(*) clean_rate,
      avg(duration_ms) average_duration_ms,avg(ocr_calls) average_ocr_calls from observations group by strategy
  ) select coalesce(jsonb_agg(jsonb_build_object('strategy',strategy,'samples',samples,'cleanSamples',clean_samples,
    'cleanRate',clean_rate,'averageDurationMs',average_duration_ms,'averageOcrCalls',average_ocr_calls)
    order by clean_rate desc,average_duration_ms asc nulls last,strategy),'[]') into stats_value from aggregates;
  select item into chosen from jsonb_array_elements(stats_value) item where (item->>'cleanSamples')::integer>=5 limit 1;
  return jsonb_build_object('strategy',chosen->>'strategy','eligibleSamples',coalesce((chosen->>'cleanSamples')::integer,0),
    'minimumSamples',5,'stats',stats_value);
end $$;
revoke all on function public.receipt_preferred_provider_reading_strategy(text,text,text,text) from public,anon,authenticated;
grant execute on function public.receipt_preferred_provider_reading_strategy(text,text,text,text) to service_role;

create or replace function public.receipt_preferred_reading_strategy(p_layout text,p_parser_revision text)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select public.receipt_preferred_provider_reading_strategy('gcash','gcash',p_layout,p_parser_revision);
$$;
revoke all on function public.receipt_preferred_reading_strategy(text,text) from public,anon,authenticated;
grant execute on function public.receipt_preferred_reading_strategy(text,text) to service_role;

create or replace function public.receipt_feedback_report(p_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role'
    and not (auth.uid() is not null and coalesce(public.current_account_role(),'') in ('owner','court_owner')) then
    raise exception 'Only active owners may view receipt performance.' using errcode='42501';
  end if;
  if p_days is null or p_days<1 or p_days>365 then
    raise exception 'Report days must be between 1 and 365.' using errcode='22023';
  end if;
  with recent as (
    select * from public.receipt_feedback_events where created_at>=now()-make_interval(days=>p_days)
  ), latest as (
    select distinct on(receipt_image_hash) * from recent order by receipt_image_hash,id desc
  ), analyses as (
    select distinct on(receipt_image_hash) * from recent where event_type='analysis' order by receipt_image_hash,id desc
  ), causes as (
    select flag,count(distinct a.receipt_image_hash) count from analyses a
    join latest l using(receipt_image_hash) cross join lateral unnest(a.flags) flag
    where l.outcome='pending' group by flag
  ), versions as (
    select provider,parser_revision,layout,count(*) receipts,count(*) filter(where outcome='auto_valid') auto_valid,
      count(*) filter(where outcome='pending') pending from analyses group by provider,parser_revision,layout
  ), strategy_observations as (
    select distinct on(e.receipt_image_hash,s->>'id') e.receipt_image_hash,s->>'id' strategy,
      s->>'clean'='true' clean,s->>'outcome' outcome,
      (s->>'durationMs')::numeric duration_ms,(s->>'ocrCalls')::numeric ocr_calls,
      (s->>'confidence')::numeric confidence
    from recent e cross join lateral jsonb_array_elements(e.strategies) s
    where e.event_type='analysis' order by e.receipt_image_hash,s->>'id',e.id desc
  ), strategy_totals as (
    select strategy,count(*) receipts,count(*) filter(where clean) clean_receipts,
      count(*) filter(where outcome='uncertain') uncertain_receipts,
      count(*) filter(where outcome='conflict') conflicting_receipts,
      count(*) filter(where outcome='error') errors,
      avg(duration_ms) average_duration_ms,avg(ocr_calls) average_ocr_calls,
      avg(confidence) average_native_confidence
    from strategy_observations group by strategy
  ) select jsonb_build_object(
    'days',p_days,'events',(select count(*) from recent),'distinctReceipts',(select count(*) from latest),
    'outcomes',(select coalesce(jsonb_object_agg(outcome,count),'{}') from (select outcome,count(*) count from latest group by outcome) counts),
    'pendingRate',(select count(*) filter(where outcome='pending')::numeric/nullif(count(*),0) from latest),
    'analysisPendingRate',(select count(*) filter(where outcome='pending')::numeric/nullif(count(*),0) from analyses),
    'pendingCauses',(select coalesce(jsonb_object_agg(flag,count),'{}') from causes),
    'averageDurationMs',(select avg(duration_ms) from analyses),
    'p95DurationMs',(select percentile_cont(.95) within group(order by duration_ms) from analyses where duration_ms is not null),
    'averageOcrCalls',(select avg(ocr_calls) from analyses),'nativeOcrCalls',(select coalesce(sum(ocr_calls),0) from recent where event_type='analysis'),
    'averageOriginalConfidence',(select avg(original_confidence) from analyses),
    'averageApprovalConfidence',(select avg(approval_confidence) from analyses),
    'unknownLayoutReceipts',(select count(*) from analyses where layout='unknown'),
    'byStrategy',(select coalesce(jsonb_agg(to_jsonb(strategy_totals)),'[]') from strategy_totals),
    'byRevision',(select coalesce(jsonb_agg(to_jsonb(versions)),'[]') from versions),
    'correctnessAvailable',false,'falseApprovalRate',null,
    'correctnessNote','Owner confirmations and OCR auto-approvals are workflow outcomes. Independent receiving-account reconciliation is required to measure correctness.'
  ) into result;
  -- Scoped breakdowns retain provider/route/layout boundaries even if one image
  -- is submitted through more than one payment method. Existing totals above
  -- remain compatible and count distinct images across the whole report.
  with recent as (
    select e.*,public.receipt_feedback_effective_destination(e.provider,e.destination_provider,e.layout) destination
    from public.receipt_feedback_events e where e.event_type='analysis' and e.created_at>=now()-make_interval(days=>p_days)
  ), provider_latest as (
    select distinct on(provider,receipt_image_hash) * from recent order by provider,receipt_image_hash,id desc
  ), route_latest as (
    select distinct on(provider,destination,receipt_image_hash) * from recent order by provider,destination,receipt_image_hash,id desc
  ), layout_latest as (
    select distinct on(provider,destination,layout,receipt_image_hash) * from recent order by provider,destination,layout,receipt_image_hash,id desc
  ), revision_latest as (
    select distinct on(provider,destination,layout,parser_revision,receipt_image_hash) * from recent order by provider,destination,layout,parser_revision,receipt_image_hash,id desc
  ), providers as (
    select provider,count(*) receipts,count(*) filter(where outcome='auto_valid') auto_valid,
      count(*) filter(where outcome='pending') pending,avg(duration_ms) average_duration_ms,avg(ocr_calls) average_ocr_calls
    from provider_latest group by provider
  ), routes as (
    select provider,destination destination_provider,count(*) receipts,count(*) filter(where outcome='auto_valid') auto_valid,
      count(*) filter(where outcome='pending') pending,avg(duration_ms) average_duration_ms,avg(ocr_calls) average_ocr_calls
    from route_latest group by provider,destination
  ), layouts as (
    select provider,destination destination_provider,layout,count(*) receipts,count(*) filter(where outcome='auto_valid') auto_valid,
      count(*) filter(where outcome='pending') pending,avg(duration_ms) average_duration_ms,avg(ocr_calls) average_ocr_calls
    from layout_latest group by provider,destination,layout
  ), revisions as (
    select provider,destination destination_provider,layout,parser_revision,count(*) receipts,
      count(*) filter(where outcome='auto_valid') auto_valid,count(*) filter(where outcome='pending') pending
    from revision_latest group by provider,destination,layout,parser_revision
  ), observations as (
    select distinct on(e.provider,e.destination,e.layout,e.parser_revision,e.receipt_image_hash,s->>'id')
      e.provider,e.destination,e.layout,e.parser_revision,e.receipt_image_hash,s->>'id' strategy,
      s->>'clean'='true' clean,s->>'outcome' outcome,
      (s->>'durationMs')::numeric duration_ms,(s->>'ocrCalls')::numeric ocr_calls,(s->>'confidence')::numeric confidence
    from recent e cross join lateral jsonb_array_elements(e.strategies) s
    order by e.provider,e.destination,e.layout,e.parser_revision,e.receipt_image_hash,s->>'id',e.id desc
  ), strategies as (
    select provider,destination destination_provider,layout,parser_revision,strategy,count(*) receipts,
      count(*) filter(where clean) clean_receipts,count(*) filter(where outcome='uncertain') uncertain_receipts,
      count(*) filter(where outcome='conflict') conflicting_receipts,count(*) filter(where outcome='error') errors,
      avg(duration_ms) average_duration_ms,avg(ocr_calls) average_ocr_calls,avg(confidence) average_native_confidence
    from observations group by provider,destination,layout,parser_revision,strategy
  ) select result || jsonb_build_object(
    'byProvider',(select coalesce(jsonb_agg(to_jsonb(providers) order by provider),'[]') from providers),
    'byRoute',(select coalesce(jsonb_agg(to_jsonb(routes) order by provider,destination_provider),'[]') from routes),
    'byLayout',(select coalesce(jsonb_agg(to_jsonb(layouts) order by provider,destination_provider,layout),'[]') from layouts),
    'byProviderRouteRevision',(select coalesce(jsonb_agg(to_jsonb(revisions) order by provider,destination_provider,layout,parser_revision),'[]') from revisions),
    'byProviderStrategy',(select coalesce(jsonb_agg(to_jsonb(strategies) order by provider,destination_provider,layout,parser_revision,strategy),'[]') from strategies)
  ) into result;
  return result;
end $$;
revoke all on function public.receipt_feedback_report(integer) from public,anon;
grant execute on function public.receipt_feedback_report(integer) to authenticated,service_role;



notify pgrst,'reload schema';
commit;
