-- Direct MariBank recipient, supplied by the CHINO owner.
begin;
do $$ begin if public.chino_project_url() <> 'https://wskzptxekldhsxluhgos.supabase.co' then raise exception 'Wrong project'; end if; end $$;
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

  if method_value = 'gotyme' then
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
  elsif method_value = 'maribank' then
    select exists(select 1 from public.settings where key='maribank_merchant_name' and nullif(trim(value),'') is not null) into has_recipient_name;
    select exists(select 1 from public.settings where key='maribank_merchant_number' and nullif(trim(value),'') is not null) into has_destination;
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


insert into public.settings(key,value) values
 ('maribank_merchant_number','15521507144'),
 ('maribank_merchant_name','KRISTIE LOU VILLANUEVA'),
 ('maribank_qr_image','https://chinopickleballcourt.com/assets/maribank-qr.png'),
 ('payment_method_maribank','1')
on conflict(key) do update set value=excluded.value;

-- Patch existing functions without replacing unrelated booking/settlement logic.
do $patch$
declare original text; patched text;
begin
  select pg_get_functiondef('public.prepare_public_booking_insert()'::regprocedure) into original;
  patched := replace(original, 'when new.payment_method = ''securitybank''', 'when new.payment_method = ''maribank'' then ''maribank'' when new.payment_method = ''securitybank''');
  if patched = original then raise exception 'Missing booking destination branch'; end if;
  execute patched;
  select pg_get_functiondef('public.update_public_booking_hold(text,text,jsonb)'::regprocedure) into original;
  patched := replace(original, 'case when lower(p_updates->>''payment_method'') = ''securitybank''', 'case when lower(p_updates->>''payment_method'') = ''maribank'' then ''maribank'' when lower(p_updates->>''payment_method'') = ''securitybank''');
  if patched = original then raise exception 'Missing hold destination branch'; end if;
  execute patched;
  select pg_get_functiondef('public.prevent_automatic_booking_rejection()'::regprocedure) into original;
  patched := replace(original, 'method_value in (''gotyme'', ''maribank'')', 'method_value = ''gotyme''');
  if patched = original then raise exception 'Missing legacy destination override'; end if;
  execute patched;
  select pg_get_functiondef(p.oid) into strict original from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='finalize_digital_receipt_auto_approval';
  patched := replace(original, '''gcash'', ''bdopay'', ''maya'', ''bpi'', ''gotyme'', ''maribank'', ''securitybank''', '''gcash'', ''bdopay'', ''maya'', ''bpi'', ''gotyme'', ''securitybank''');
  if patched = original then raise exception 'Missing auto-approval provider guard'; end if;
  execute patched;
end;
$patch$;
commit;
