-- Security Bank direct transfers. Receipt evidence always requires owner review.
begin;
do $$ begin if public.chino_project_url() <> 'https://wskzptxekldhsxluhgos.supabase.co' then raise exception 'Wrong project'; end if; end $$;
insert into public.settings(key,value) values ('payment_method_securitybank','0'),('securitybank_merchant_number',''),('securitybank_merchant_name','') on conflict (key) do nothing;

do $patch$
declare signature text; original text; patched text;
begin
 foreach signature in array array['public.create_host_booking_balance_payment(text,uuid,text,text,text)',
'public.transfer_cancelled_booking_payment(text,text,text,boolean,uuid)',
'public.guard_digital_payment_decision_role()',
'public.prepare_public_open_play_registration()',
'public.prepare_public_host_session_registration()',
'public.prepare_public_booking_insert()',
'public.update_public_booking_hold(text,text,jsonb)',
'public.reject_booking_payment_transaction(text,text)',
'public.normalize_payment_reference_key(text,text)',
'public.payment_review_ledger_keys(jsonb,text,text)',
'public.prevent_automatic_booking_rejection()',
'public.claim_owner_confirmed_receipt_evidence()',
'public.confirm_booking_transaction(text)' ] loop
  if to_regprocedure(signature) is null then raise exception 'Missing function %', signature; end if;
  select pg_get_functiondef(to_regprocedure(signature)) into original;
  if position('''securitybank''' in original)>0 then continue; end if;
  patched := replace(original, '''maribank'', ''pnb''', '''maribank'', ''pnb'', ''securitybank''');
  if patched=original and position('''securitybank''' in original)=0 then raise exception 'Unexpected provider list in %',signature; end if;
  execute patched;
 end loop;
end $patch$;

CREATE OR REPLACE FUNCTION public.public_payment_method_ready(p_method text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  method_value text := lower(trim(coalesce(p_method, '')));
  method_enabled boolean;
  has_recipient_name boolean;
  has_destination boolean;
begin
  select trim(coalesce(s.value, '')) = '1'
    into method_enabled
    from public.settings s
   where s.key = 'payment_method_' || method_value
   limit 1;

  if not coalesce(method_enabled, false) then
    return false;
  end if;
  if method_value = 'cash' then
    return true;
  end if;

  if method_value in ('gotyme', 'maribank') then
    select exists (
      select 1
        from public.settings s
       where s.key = 'gcash_merchant_name'
         and nullif(trim(coalesce(s.value, '')), '') is not null
    ) into has_recipient_name;
    select exists (
      select 1
        from public.settings s
       where s.key = any(array['gcash_merchant_number', 'gcash_qr_image'])
         and nullif(trim(coalesce(s.value, '')), '') is not null
    ) into has_destination;
  elsif method_value in ('gcash', 'bdopay', 'maya', 'bpi') then
    select exists (
      select 1
        from public.settings s
       where s.key = any(array[
         method_value || '_merchant_name',
         'payment_merchant_name',
         'gcash_merchant_name'
       ])
         and nullif(trim(coalesce(s.value, '')), '') is not null
    ) into has_recipient_name;
    select exists (
      select 1
        from public.settings s
       where s.key = any(array[
         method_value || '_merchant_number',
         method_value || '_qr_image',
         'gcash_merchant_number',
         'gcash_qr_image'
       ])
         and nullif(trim(coalesce(s.value, '')), '') is not null
    ) into has_destination;
  elsif method_value = 'securitybank' then
    select exists(select 1 from public.settings where key='securitybank_merchant_name' and nullif(trim(value),'') is not null) into has_recipient_name;
    select exists(select 1 from public.settings where key='securitybank_merchant_number' and nullif(trim(value),'') is not null) into has_destination;
  elsif method_value = 'pnb' then
    select exists (
      select 1
        from public.settings s
       where s.key = 'pnb_merchant_name'
         and nullif(trim(coalesce(s.value, '')), '') is not null
    ) into has_recipient_name;
    select exists (
      select 1
        from public.settings s
       where s.key = any(array['pnb_merchant_number', 'pnb_qr_image'])
         and nullif(trim(coalesce(s.value, '')), '') is not null
    ) into has_destination;
  else
    return false;
  end if;

  return coalesce(has_recipient_name, false)
     and coalesce(has_destination, false);
end;
$function$
;

alter table public.open_play_host_session_registrations drop constraint if exists open_play_host_session_registrations_payment_method_check;
alter table public.open_play_host_session_registrations add constraint open_play_host_session_registrations_payment_method_check check (payment_method in ('gcash','bdopay','maya','bpi','gotyme','maribank','pnb','securitybank','cash'));
alter table public.host_booking_balance_payments drop constraint if exists host_booking_balance_payments_provider_check;
alter table public.host_booking_balance_payments add constraint host_booking_balance_payments_provider_check check (payment_provider in ('gcash','bdopay','maya','bpi','gotyme','maribank','pnb','securitybank'));
alter table public.booking_payment_transfers drop constraint if exists booking_payment_transfers_method_check;
alter table public.booking_payment_transfers add constraint booking_payment_transfers_method_check check (payment_method in ('gcash','bdopay','maya','bpi','gotyme','maribank','pnb','securitybank'));
commit;
