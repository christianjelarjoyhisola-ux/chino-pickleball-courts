begin;
do $$
declare signature text; definition text;
begin
  if public.chino_project_url() <> 'https://wskzptxekldhsxluhgos.supabase.co' then
    raise exception 'CHINO project guard failed';
  end if;
  -- Preserve subsequent pricing, role and weather changes in these functions.
  foreach signature in array array[
    'public.guard_public_booking_hold_update()',
    'public.update_public_booking_hold(text,text,jsonb)',
    'public.booking_occupies_slot(text,text,text,timestamptz)'
  ] loop
    definition := pg_get_functiondef(signature::regprocedure);
    definition := replace(definition, 'interval ''10 minutes''', 'interval ''15 minutes''');
    if signature = 'public.update_public_booking_hold(text,text,jsonb)' then
      definition := replace(definition,
        'or target.created_at <= now() - interval ''15 minutes''',
        'or (target.created_at <= now() - interval ''15 minutes'' and target.receipt_image_url is null)');
    end if;
    execute definition;
  end loop;
end $$;

-- A stored receipt must survive the checkout clock. This function returns only
-- occupancy, never receipt paths; SECURITY DEFINER avoids recursive booking RLS.
create or replace function public.booking_occupies_slot(
  booking_status text, booking_email text, booking_full_name text,
  booking_created_at timestamptz
) returns boolean language sql stable security definer
set search_path = pg_catalog, pg_temp as $$
  select case
    when lower(btrim(coalesce(booking_status,''))) in ('cancelled','forfeited') then false
    when booking_created_at <= now() - interval '15 minutes'
      and lower(btrim(coalesce(booking_status,''))) = 'verifying'
      and lower(btrim(coalesce(booking_email,''))) = 'reserve@hold.internal'
      and lower(btrim(coalesce(booking_full_name,''))) in ('reserving...','reserving…')
    then exists (
      select 1 from public.bookings b
      where b.created_at = booking_created_at and b.email = booking_email
        and b.full_name = booking_full_name and b.status = 'verifying'
        and ((nullif(b.receipt_image_url,'') is not null
          and nullif(b.receipt_image_hash,'') is not null)
          or exists (select 1 from public.receipt_verification_leases l
            where l.booking_key = coalesce(nullif(b.booking_group_ref,''),b.ref)
              and l.lease_expires_at > now()))
    )
    else true
  end
$$;

create or replace function public.require_receipt_before_payment_review()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  -- Temporary verifying holds remain permissible. Online payment review must
  -- always be backed by durable evidence, even for direct dashboard writes.
  if new.status = 'pending' and new.payment_status = 'for_verification'
     and coalesce(new.payment_method,'cash') <> 'cash'
     and (nullif(btrim(new.receipt_image_url),'') is null
       or nullif(btrim(new.receipt_image_hash),'') is null) then
    raise exception 'Store a receipt before sending an online payment for review.' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists require_receipt_before_payment_review on public.bookings;
create trigger require_receipt_before_payment_review
before insert or update of status, payment_status, receipt_image_url, receipt_image_hash
on public.bookings for each row execute function public.require_receipt_before_payment_review();
commit;
