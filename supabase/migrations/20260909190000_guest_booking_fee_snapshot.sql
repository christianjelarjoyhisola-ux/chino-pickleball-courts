begin;
do $$ begin if public.chino_project_url() <> 'https://wskzptxekldhsxluhgos.supabase.co' then raise exception 'CHINO project guard failed'; end if; end $$;
-- Preserve token-protected access while returning the immutable fee breakdown.
drop function public.get_public_booking_by_ref(text,text);
CREATE OR REPLACE FUNCTION public.get_public_booking_by_ref(p_ref text, p_access_token text)
 RETURNS TABLE(ref text, court_id text, court_name text, date date, slots text[], start_time text, end_time text, duration numeric, rate numeric, total numeric, payment_status text, status text, created_at timestamp with time zone, booking_fee_mode_snapshot text, booking_fee_amount_snapshot numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select
    b.ref,
    b.court_id,
    b.court_name,
    b.date,
    b.slots,
    b.start_time,
    b.end_time,
    b.duration,
    b.rate,
    b.total,
    b.payment_status,
    b.status,
    b.created_at,
    b.booking_fee_mode_snapshot,
    b.booking_fee_amount_snapshot
  from public.bookings b
  where coalesce(auth.role(), nullif(current_setting('request.jwt.claim.role', true), '')) = 'anon'
    and length(coalesce(p_access_token, '')) between 32 and 256
    and b.ref = trim(coalesce(p_ref, ''))
    and b.customer_access_token_hash = encode(extensions.digest(p_access_token, 'sha256'), 'hex')
  limit 1
$function$
;
revoke all on function public.get_public_booking_by_ref(text,text) from public,anon,authenticated;
grant execute on function public.get_public_booking_by_ref(text,text) to anon,service_role;
commit;
