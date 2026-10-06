begin;
-- Enable only destination-specific MariBank evidence. Legacy bank-to-GCash
-- evidence remains ineligible for settlement. Atomic leases/dedupe stay intact.
do $patch$
declare original text; patched text; function_name text;
begin
 foreach function_name in array array['finalize_digital_receipt_auto_approval','finalize_digital_receipt_review','assert_clean_registration_receipt'] loop
  select pg_get_functiondef(p.oid) into strict original from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=function_name;
  if position('maribank_direct_v1' in original)>0 then continue; end if;
  if position('when ''maribank'' then ''maribank_to_gcash_v1''' in original)=0
     or position('case when provider_value = ''securitybank'' then ''securitybank'' else ''gcash'' end' in original)=0 then
    raise exception 'Unexpected receipt guard %; migration requires review',function_name;
  end if;
  patched := replace(original,'provider_value not in (''gcash'', ''bdopay'', ''maya'', ''bpi'', ''gotyme'', ''securitybank'')','provider_value not in (''gcash'', ''bdopay'', ''maya'', ''bpi'', ''gotyme'', ''maribank'', ''securitybank'')');
  patched := replace(patched,'when ''maribank'' then ''maribank_to_gcash''','when ''maribank'' then ''maribank_direct''');
  patched := replace(patched,'when ''maribank'' then ''maribank_to_gcash_v1''','when ''maribank'' then ''maribank_direct_v1''');
  patched := replace(patched,'case when provider_value = ''securitybank'' then ''securitybank'' else ''gcash'' end','case when provider_value in (''securitybank'', ''maribank'') then provider_value else ''gcash'' end');
  execute patched;
 end loop;
 select pg_get_functiondef('public.receipt_auto_approval_evidence_is_clean(text,text[],numeric,jsonb)'::regprocedure) into original;
 if position('maribank_direct_v1' in original)=0 then
  patched:=replace(original,'case when lower(coalesce(p_extracted->>''provider'','''')) = ''securitybank'' then ''securitybank'' else ''gcash'' end','case when lower(coalesce(p_extracted->>''provider'','''')) in (''securitybank'',''maribank'') then lower(p_extracted->>''provider'') else ''gcash'' end');
  if patched=original then raise exception 'Missing clean receipt destination guard'; end if;
  patched:=replace(patched,'and (lower(coalesce(p_extracted->>''provider'','''')) <> ''securitybank''','and (lower(coalesce(p_extracted->>''provider'','''')) <> ''maribank'' or (p_extracted->>''route'' = ''maribank_direct'' and p_extracted->>''parserVersion'' = ''maribank_direct_v1'')) and (lower(coalesce(p_extracted->>''provider'','''')) <> ''securitybank''');
  if position('maribank_direct_v1' in patched)=0 then raise exception 'Missing clean receipt route guard'; end if;
  execute patched;
 end if;
 -- Keep old feedback readable while identifying the direct destination separately.
 select pg_get_functiondef('public.receipt_feedback_destination(jsonb)'::regprocedure) into original;
 if position('maribank_direct_v1' in original)=0 then
  if position('where provider=p_evidence->>''provider''' in original)=0 then raise exception 'Unexpected receipt feedback registry'; end if;
  patched:=replace(original,'(''maribank'',''gcash'',''maribank_to_gcash_v1'',''maribank_to_gcash''),','(''maribank'',''gcash'',''maribank_to_gcash_v1'',''maribank_to_gcash''), (''maribank'',''maribank'',''maribank_direct_v1'',''maribank_direct''),');
  if patched=original then raise exception 'Missing MariBank feedback route'; end if;
  patched:=replace(patched,'where provider=p_evidence->>''provider''','where provider=p_evidence->>''provider'' and p=p_evidence->>''parserVersion''');
  execute patched;
 end if;
end;
$patch$;
commit;
