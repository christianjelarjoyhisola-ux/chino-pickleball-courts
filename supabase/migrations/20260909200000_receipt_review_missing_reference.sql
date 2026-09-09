-- Preserve unreadable receipt evidence for owner review without approving it.
-- The approval finalizer and payment-reference validator stay unchanged.
begin;

do $migration$
declare
  signature text := 'public.finalize_digital_receipt_review(text,text[],text,uuid,text,text,text,text,text,text[],jsonb,numeric,timestamp with time zone,text)';
  original text;
  patched text;
  normalize_pattern text := 'normalized_reference := public\.normalize_payment_reference_key\([[:space:]]*provider_value,[[:space:]]*p_payment_reference[[:space:]]*\);';
  binding_pattern text := 'public\.normalize_payment_reference_key\([[:space:]]*provider_value,[[:space:]]*b\.gcash_ref[[:space:]]*\) <> normalized_reference';
begin
  if public.chino_project_url() <> 'https://wskzptxekldhsxluhgos.supabase.co' then
    raise exception 'CHINO project guard failed';
  end if;
  if to_regprocedure(signature) is null then
    raise exception 'The dedicated receipt review finalizer is missing';
  end if;
  select pg_get_functiondef(to_regprocedure(signature)) into original;
  if position('-- Review evidence may be incomplete; this never settles a payment.' in original) > 0 then
    return;
  end if;
  if position('referenceInputMode' in original) = 0
     or position('receipt_only' in original) = 0
     or (select count(*) from regexp_matches(original, normalize_pattern, 'g')) <> 1
     or (select count(*) from regexp_matches(original, binding_pattern, 'g')) <> 1 then
    raise exception 'Unexpected receipt review definition; no changes applied';
  end if;

  patched := regexp_replace(original, normalize_pattern, $replacement$
  -- Review evidence may be incomplete; this never settles a payment.
  if nullif(trim(coalesce(p_payment_reference, '')), '') is null then
    normalized_reference := null;
  else
    normalized_reference := public.normalize_payment_reference_key(
      provider_value,
      p_payment_reference
    );
  end if;$replacement$);

  -- A missing OCR reference cannot bypass an existing saved reference.
  -- The existing receipt_only check still applies when the booking has none.
  patched := regexp_replace(patched, binding_pattern,
    'public.normalize_payment_reference_key(provider_value, b.gcash_ref) is distinct from normalized_reference');
  execute patched;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
