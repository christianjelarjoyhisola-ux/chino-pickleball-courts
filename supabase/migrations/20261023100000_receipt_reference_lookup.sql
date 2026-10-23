-- Owner-only, read-only evidence for reference prefill. Never approves a payment.
create or replace function public.get_booking_receipt_reference_evidence(p_booking_ref text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare anchor public.bookings%rowtype; evidence jsonb;
begin
 if not public.has_account_role(array['owner']) then
   raise exception 'Only the system owner can read reconciliation evidence.' using errcode='42501';
 end if;
 select * into anchor from public.bookings where ref=p_booking_ref;
 if not found then raise exception 'Booking not found.'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('extracted',v.extracted,'raw_ocr_text',v.raw_ocr_text)), '[]'::jsonb)
 into evidence
 from public.bookings b
 cross join lateral (
   select r.extracted,r.raw_ocr_text from public.receipt_verifications r
   where r.booking_ref=b.ref and r.image_hash=b.receipt_image_hash
     and nullif(b.receipt_image_hash,'') is not null
   order by r.created_at desc,r.id desc limit 1
 ) v
 where b.ref=anchor.ref or (nullif(trim(anchor.booking_group_ref),'') is not null
   and nullif(trim(b.booking_group_ref),'')=nullif(trim(anchor.booking_group_ref),''));
 return evidence;
end $$;
revoke all on function public.get_booking_receipt_reference_evidence(text) from public,anon;
grant execute on function public.get_booking_receipt_reference_evidence(text) to authenticated;
