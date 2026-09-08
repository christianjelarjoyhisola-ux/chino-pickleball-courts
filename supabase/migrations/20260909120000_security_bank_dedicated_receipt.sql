-- Dedicated GCash-to-Security Bank evidence. Preserve locking and atomic settlement.
begin;
do $$ begin if public.chino_project_url()<>'https://wskzptxekldhsxluhgos.supabase.co' then raise exception 'Wrong project'; end if; end $$;
do $patch$
declare signature text; original text; patched text;
begin
 foreach signature in array array['public.assert_clean_registration_receipt(bigint,text,text,text,numeric,text,text,date,text,integer)',
'public.finalize_digital_receipt_auto_approval(text,text[],text,uuid,text,text,text,text,text,text,text[],jsonb,numeric,timestamp with time zone,text)',
'public.finalize_digital_receipt_review(text,text[],text,uuid,text,text,text,text,text,text[],jsonb,numeric,timestamp with time zone,text)'] loop
  if to_regprocedure(signature) is null then raise exception 'Missing %',signature; end if;
  select pg_get_functiondef(to_regprocedure(signature)) into original;
  if position('gcash_to_securitybank_v1' in original)>0 then continue; end if;
  patched:=replace(original, '''bpi'', ''gotyme'', ''maribank'')', '''bpi'', ''gotyme'', ''maribank'', ''securitybank'')');
  patched:=replace(patched, 'when ''bpi'' then ''bpi_to_gcash''', 'when ''securitybank'' then ''gcash_to_securitybank'' when ''bpi'' then ''bpi_to_gcash''');
  patched:=replace(patched, 'when ''bpi'' then ''bpi_to_gcash_v1''', 'when ''securitybank'' then ''gcash_to_securitybank_v1'' when ''bpi'' then ''bpi_to_gcash_v1''');
  patched:=replace(patched, ')) <> ''gcash''', ')) <> (case when provider_value = ''securitybank'' then ''securitybank'' else ''gcash'' end)');
  if patched=original or position('gcash_to_securitybank_v1' in patched)=0 then raise exception 'Unexpected receipt contract %',signature; end if;
  if position('destinationProvider' in original)>0 and position('then ''securitybank'' else ''gcash'' end' in patched)=0 then raise exception 'Missing destination guard %',signature; end if;
  execute patched;
 end loop;
end $patch$;
CREATE OR REPLACE FUNCTION public.receipt_auto_approval_evidence_is_clean(p_result text, p_flags text[], p_confidence numeric, p_extracted jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select
    lower(trim(coalesce(p_result, ''))) = 'auto_approved'
    and cardinality(coalesce(p_flags, array[]::text[])) = 0
    and p_confidence is not null
    and p_confidence >= 0.90
    and p_confidence <= 1
    and jsonb_typeof(p_extracted) = 'object'
    and lower(coalesce(
      p_extracted#>>'{verification,decision}',
      ''
    )) = 'valid'
    and coalesce(
      p_extracted#>>'{verification,sourceProviderMatch}',
      ''
    ) = 'true'
    and coalesce(
      p_extracted#>>'{verification,referenceMatch}',
      ''
    ) = 'true'
    and coalesce(
      p_extracted#>>'{verification,amountMatch}',
      ''
    ) = 'true'
    and coalesce(
      p_extracted#>>'{verification,timestampValid}',
      ''
    ) = 'true'
    and coalesce(
      p_extracted#>>'{verification,recipientMatch}',
      ''
    ) = 'true'
    and coalesce(
      p_extracted#>>'{verification,duplicateClear}',
      ''
    ) = 'true'
    and lower(coalesce(
      p_extracted#>>'{verification,destinationProvider}',
      ''
    )) = (case when lower(coalesce(p_extracted->>'provider','')) = 'securitybank' then 'securitybank' else 'gcash' end)
    and (lower(coalesce(p_extracted->>'provider','')) <> 'securitybank' or (
      p_extracted->>'route' = 'gcash_to_securitybank' and
      p_extracted->>'parserVersion' = 'gcash_to_securitybank_v1'
    ));
$function$
;
commit;
