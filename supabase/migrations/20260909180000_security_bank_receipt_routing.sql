-- Keep Security Bank destinations distinct throughout hold creation/finalization.
begin;
do $migration$
declare name text; original text; patched text;
begin
 if public.chino_project_url() <> 'https://wskzptxekldhsxluhgos.supabase.co' then raise exception 'CHINO project guard failed'; end if;
 for name in select unnest(array['prepare_public_booking_insert','update_public_booking_hold']) loop
  select pg_get_functiondef(p.oid) into strict original from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=name;
  patched := replace(original, 'when new.payment_method = ''cash'' then ''cash''', 'when new.payment_method = ''securitybank'' then ''securitybank'' when new.payment_method = ''cash'' then ''cash''');
  patched := replace(patched, 'when lower(p_updates->>''payment_method'') = ''cash'' then ''cash''', 'when lower(p_updates->>''payment_method'') = ''securitybank'' then ''securitybank'' when lower(p_updates->>''payment_method'') = ''cash'' then ''cash''');
  if patched = original then raise exception 'Unexpected destination routing in %',name; end if;
  execute patched;
 end loop;
end $migration$;

-- Correct only unfinished Security Bank payments. Never change settled receipts.
update public.bookings set received_account='securitybank'
 where payment_method='securitybank' and received_account='gcash'
 and status in ('verifying','pending') and payment_status in ('unpaid','pending','for_verification');

-- Restore existing immutable review evidence omitted by the destination mismatch.
-- Match the exact current upload; this does not re-run or approve a payment.
with latest as (
 select distinct on (v.booking_ref) v.* from public.receipt_verifications v
 order by v.booking_ref,v.created_at desc,v.id desc
)
update public.bookings b set receipt_flags=v.flags,receipt_extracted=v.extracted,
 receipt_confidence=v.confidence,receipt_verified_at=v.created_at
 from latest v where b.ref=v.booking_ref and b.payment_method='securitybank'
 and b.received_account='securitybank' and b.status='pending'
 and b.payment_status='for_verification' and b.receipt_status='manual_review'
 and b.receipt_extracted is null and b.receipt_verified_at is null
 and b.receipt_image_hash=v.image_hash and v.result='manual_review'
 and v.extracted->>'parserVersion'='gcash_to_securitybank_v1';
commit;
