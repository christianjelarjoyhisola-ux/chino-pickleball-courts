-- Advisory receipt telemetry. It can rank fixed OCR strategies, never change
-- payment rules or learn merchant details from owner decisions.
begin;

do $$ begin
  if public.chino_project_url() <> 'https://wskzptxekldhsxluhgos.supabase.co' then
    raise exception 'CHINO project guard failed';
  end if;
end $$;

create table if not exists public.receipt_feedback_events (
  id bigint generated always as identity primary key,
  event_key text not null unique,
  event_type text not null check (event_type in ('analysis', 'decision')),
  receipt_verification_id bigint,
  booking_ref text not null,
  booking_group_ref text,
  receipt_image_hash text not null check (receipt_image_hash ~ '^[0-9a-f]{64}$'),
  provider text not null,
  parser_revision text not null,
  layout text not null,
  outcome text not null check (outcome in ('auto_valid', 'pending', 'manual_confirmed', 'rejected')),
  flags text[] not null default '{}',
  original_confidence numeric,
  approval_confidence numeric,
  duration_ms integer check (duration_ms between 0 and 600000),
  ocr_calls integer check (ocr_calls between 0 and 30),
  strategies jsonb not null default '[]' check (jsonb_typeof(strategies) = 'array'),
  actor_kind text not null default 'system',
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists receipt_feedback_events_receipt_idx
  on public.receipt_feedback_events (receipt_image_hash, id desc);
create index if not exists receipt_feedback_events_policy_idx
  on public.receipt_feedback_events (layout, parser_revision, created_at desc)
  where event_type = 'analysis';
alter table public.receipt_feedback_events enable row level security;
revoke all on public.receipt_feedback_events from public, anon, authenticated, service_role;
grant select on public.receipt_feedback_events to service_role;
revoke all on sequence public.receipt_feedback_events_id_seq from public, anon, authenticated, service_role;
comment on table public.receipt_feedback_events is
  'Append-only advisory OCR telemetry. Owner decisions are workflow outcomes, not independently verified payment truth. No receipt text or merchant identities are learned here.';

create or replace function public.receipt_feedback_bounded_number(p_value jsonb, p_max numeric)
returns numeric language plpgsql immutable set search_path = public, pg_temp as $$
declare value numeric;
begin
  if jsonb_typeof(p_value) is distinct from 'number' then return null; end if;
  value := (p_value #>> '{}')::numeric;
  if value < 0 or value > p_max then return null; end if;
  return value;
exception when others then return null;
end $$;
revoke all on function public.receipt_feedback_bounded_number(jsonb,numeric) from public,anon,authenticated,service_role;

create or replace function public.receipt_feedback_capture_analysis()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  evidence jsonb := coalesce(new.extracted, '{}');
  feedback jsonb := coalesce(new.extracted->'feedback', '{}');
  revision text := left(coalesce(nullif(new.extracted->>'verifierRevision',''), nullif(new.extracted->>'parserVersion',''), 'unknown'), 100);
  layout_value text := 'unknown';
  group_value text;
  clean boolean := false;
  strategies_value jsonb := '[]';
  candidate jsonb;
  strategy_id text;
  candidate_clean boolean;
  duration_value numeric;
  calls_value numeric;
begin
  -- Only the server verifier writes training observations. Browser-submitted
  -- audits, even if another policy later permits them, do not count.
  if coalesce(auth.role(),'') <> 'service_role'
     or coalesce(new.image_hash,'') !~ '^[0-9a-f]{64}$' then return new; end if;

  select b.booking_group_ref into group_value
    from public.bookings b where b.ref = new.booking_ref;
  clean := coalesce(public.receipt_auto_approval_evidence_is_clean(
    new.result, new.flags, new.confidence, new.extracted), false);

  if feedback->>'version' = 'receipt_feedback_v1'
     and feedback->>'parserRevision' = revision
     and evidence->>'provider' = 'gcash'
     and evidence->>'parserVersion' = 'gcash_v1' then
    if evidence#>>'{gcash,indicators,classification}' = 'gcash'
       and feedback->>'layout' = 'gcash_express_send' then
      layout_value := 'gcash_express_send';
    end if;
    duration_value := public.receipt_feedback_bounded_number(feedback->'durationMs',600000);
    calls_value := public.receipt_feedback_bounded_number(feedback->'ocrCalls',30);
    if duration_value <> trunc(duration_value) then duration_value := null; end if;
    if calls_value <> trunc(calls_value) then calls_value := null; end if;
    if jsonb_typeof(feedback->'strategies') = 'array'
       and jsonb_array_length(feedback->'strategies') <= 4 then
      for candidate in select value from jsonb_array_elements(feedback->'strategies') loop
        strategy_id := candidate->>'id';
        if coalesce(strategy_id,'') not in ('gcash_original_v1','gcash_recipient_pair_v1',
          'gcash_full_contrast_v1','gcash_full_enlarged_v1')
          or coalesce(candidate->>'attempted','') <> 'true'
          or coalesce(candidate->>'outcome','') not in ('clean','uncertain','conflict','error')
          or exists (select 1 from jsonb_array_elements(strategies_value) item where item->>'id'=strategy_id)
        then continue; end if;
        -- A manual confirmation or candidate's own claim cannot make it a
        -- successful OCR sample. The immutable server audit must be clean too.
        candidate_clean := clean and new.result = 'auto_approved'
          and layout_value = 'gcash_express_send'
          and candidate->>'hardChecksClean' = 'true' and candidate->>'outcome' = 'clean'
          and public.receipt_feedback_bounded_number(candidate->'confidence',1) >= .9;
        strategies_value := strategies_value || jsonb_build_array(jsonb_build_object(
          'id',strategy_id,'outcome',candidate->>'outcome','clean',coalesce(candidate_clean,false),
          'durationMs',public.receipt_feedback_bounded_number(candidate->'durationMs',600000),
          'ocrCalls',public.receipt_feedback_bounded_number(candidate->'ocrCalls',30),
          'confidence',public.receipt_feedback_bounded_number(candidate->'confidence',1)
        ));
      end loop;
    end if;
  end if;

  insert into public.receipt_feedback_events (
    event_key,event_type,receipt_verification_id,booking_ref,booking_group_ref,
    receipt_image_hash,provider,parser_revision,layout,outcome,flags,
    original_confidence,approval_confidence,duration_ms,ocr_calls,strategies
  ) values (
    'audit:'||new.id,'analysis',new.id,new.booking_ref,group_value,
    new.image_hash,left(coalesce(evidence->>'provider','unknown'),30),revision,layout_value,
    case when clean then 'auto_valid' else 'pending' end,
    coalesce(new.flags,'{}'),
    public.receipt_feedback_bounded_number(coalesce(evidence->'originalOcrConfidence',evidence->'ocrConfidence'),1),
    public.receipt_feedback_bounded_number(evidence->'approvalConfidence',1),
    duration_value::integer,calls_value::integer,strategies_value
  ) on conflict (event_key) do nothing;
  return new;
exception when others then
  -- Telemetry is advisory: unavailable storage, bad metadata, or an exception
  -- must never change or prevent the payment/audit being processed.
  raise log 'Receipt analysis feedback unavailable (SQLSTATE %)', sqlstate;
  return new;
end $$;
revoke all on function public.receipt_feedback_capture_analysis() from public,anon,authenticated,service_role;

drop trigger if exists z90_capture_receipt_feedback on public.receipt_verifications;
create trigger z90_capture_receipt_feedback after insert on public.receipt_verifications
for each row execute function public.receipt_feedback_capture_analysis();

create or replace function public.receipt_feedback_decision_outcome(p_old jsonb,p_new jsonb)
returns text language sql immutable set search_path = public,pg_temp as $$
  select case
    when p_old->>'status' is not distinct from p_new->>'status'
      and p_old->>'payment_status' is not distinct from p_new->>'payment_status' then null
    when p_new->>'payment_status' = 'rejected' then 'rejected'
    when p_new->>'payment_status' in ('paid','downpayment_paid')
      and p_new->>'status' in ('confirmed','completed')
      then case when p_new->>'receipt_status' = 'auto_approved' then 'auto_valid' else 'manual_confirmed' end
    else null end;
$$;
revoke all on function public.receipt_feedback_decision_outcome(jsonb,jsonb) from public,anon,authenticated,service_role;

create or replace function public.receipt_feedback_capture_decision()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare outcome_value text; audit_id bigint; actor jsonb;
begin
  if coalesce(new.receipt_image_hash,'') !~ '^[0-9a-f]{64}$'
    or coalesce(new.payment_method,'') not in ('gcash','bdopay','maya','bpi','gotyme','maribank','pnb','securitybank') then return new; end if;
  if coalesce(auth.role(),'') <> 'service_role'
    and not (auth.uid() is not null and coalesce(public.current_account_role(),'') in ('owner','court_owner')) then return new; end if;
  outcome_value := public.receipt_feedback_decision_outcome(to_jsonb(old),to_jsonb(new));
  if outcome_value is null then return new; end if;
  actor := public.admin_activity_actor();
  select v.id into audit_id from public.receipt_verifications v
    where v.image_hash=new.receipt_image_hash and
      (v.booking_ref=new.ref or v.booking_ref in (select b.ref from public.bookings b where b.booking_group_ref=new.booking_group_ref))
    order by v.id desc limit 1;
  insert into public.receipt_feedback_events (
    event_key,event_type,receipt_verification_id,booking_ref,booking_group_ref,
    receipt_image_hash,provider,parser_revision,layout,outcome,flags,actor_kind
  ) values (
    'decision:'||txid_current()||':'||new.ref||':'||coalesce(old.payment_status,'')||':'||coalesce(new.payment_status,'')||':'||outcome_value,
    'decision',audit_id,new.ref,new.booking_group_ref,new.receipt_image_hash,new.payment_method,
    left(coalesce(new.receipt_extracted->>'verifierRevision',new.receipt_extracted->>'parserVersion','unknown'),100),
    case when new.receipt_extracted#>>'{feedback,layout}'='gcash_express_send' then 'gcash_express_send' else 'unknown' end,
    outcome_value,coalesce(new.receipt_flags,'{}'),coalesce(actor->>'kind','system')
  ) on conflict (event_key) do nothing;
  return new;
exception when others then
  raise log 'Receipt decision feedback unavailable (SQLSTATE %)', sqlstate;
  return new;
end $$;
revoke all on function public.receipt_feedback_capture_decision() from public,anon,authenticated,service_role;
drop trigger if exists z98_capture_receipt_decision_feedback on public.bookings;
create trigger z98_capture_receipt_decision_feedback after update of status,payment_status on public.bookings
for each row execute function public.receipt_feedback_capture_decision();

create or replace function public.receipt_preferred_reading_strategy(p_layout text,p_parser_revision text)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare stats_value jsonb; chosen jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Receipt strategy preferences are server-only.' using errcode='42501';
  end if;
  if coalesce(p_layout,'') <> 'gcash_express_send' or nullif(trim(p_parser_revision),'') is null or length(p_parser_revision)>100 then
    return jsonb_build_object('strategy',null,'eligibleSamples',0,'minimumSamples',5,'stats','[]'::jsonb);
  end if;
  with observations as (
    select distinct on (e.receipt_image_hash,s->>'id')
      e.receipt_image_hash,s->>'id' strategy,s->>'clean'='true' clean,
      (s->>'durationMs')::numeric duration_ms,(s->>'ocrCalls')::numeric ocr_calls
    from public.receipt_feedback_events e
    cross join lateral jsonb_array_elements(e.strategies) s
    where e.event_type='analysis' and e.layout=p_layout and e.parser_revision=p_parser_revision
      and s->>'id' in ('gcash_full_contrast_v1','gcash_full_enlarged_v1')
    order by e.receipt_image_hash,s->>'id',e.id desc
  ), aggregates as (
    select strategy,count(*) samples,count(*) filter(where clean) clean_samples,
      count(*) filter(where clean)::numeric/count(*) clean_rate,
      avg(duration_ms) average_duration_ms,avg(ocr_calls) average_ocr_calls
    from observations group by strategy
  ) select coalesce(jsonb_agg(jsonb_build_object(
      'strategy',strategy,'samples',samples,'cleanSamples',clean_samples,
      'cleanRate',clean_rate,'averageDurationMs',average_duration_ms,'averageOcrCalls',average_ocr_calls
    ) order by clean_rate desc,average_duration_ms asc nulls last,strategy),'[]') into stats_value from aggregates;
  select item into chosen from jsonb_array_elements(stats_value) item
    where (item->>'cleanSamples')::integer >= 5 limit 1;
  return jsonb_build_object('strategy',chosen->>'strategy','eligibleSamples',coalesce((chosen->>'cleanSamples')::integer,0),
    'minimumSamples',5,'stats',stats_value);
end $$;
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
  return result;
end $$;
revoke all on function public.receipt_feedback_report(integer) from public,anon;
grant execute on function public.receipt_feedback_report(integer) to authenticated,service_role;

notify pgrst,'reload schema';
commit;
