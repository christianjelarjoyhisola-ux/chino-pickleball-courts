-- Repair the reported booking confirmed by the system owner before the
-- automatic-verification rule was installed. Preserve the original OCR record.
begin;
update public.bookings b
   set receipt_status = 'auto_approved',
       receipt_verified_at = a.confirmed_at
  from (
    select max(confirmed_at) as confirmed_at
      from public.booking_owner_payment_confirmations
     where confirmed_role = 'owner'
       and 'PB-MTV82981-81H8' = any(booking_refs)
  ) a
 where b.ref = 'PB-MTV82981-81H8'
   and b.status = 'confirmed'
   and b.payment_status = 'paid'
   and b.receipt_status = 'manual_review'
   and a.confirmed_at is not null;
commit;
