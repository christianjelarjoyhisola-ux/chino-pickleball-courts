-- Run after the Security Bank migration. All fixture settings roll back.
begin;
update public.settings set value=case when key='payment_method_securitybank' then '0' else '' end where key in ('payment_method_securitybank','securitybank_merchant_number','securitybank_merchant_name');
do $test$ begin
 if public.public_payment_method_ready('securitybank') then raise exception 'Unconfigured method enabled'; end if;
 update public.settings set value='1' where key='payment_method_securitybank';
 if public.public_payment_method_ready('securitybank') then raise exception 'Missing account accepted'; end if;
 update public.settings set value='CHINO TEST' where key='securitybank_merchant_name';
 if public.public_payment_method_ready('securitybank') then raise exception 'Missing number accepted'; end if;
 update public.settings set value='000012345678' where key='securitybank_merchant_number';
 if not public.public_payment_method_ready('securitybank') then raise exception 'Configured method unavailable'; end if;
 if public.normalize_payment_reference_key('securitybank','SB-123ABC456')<>'securitybank:SB123ABC456' then raise exception 'Reference lost'; end if;
 update public.settings set value='0' where key='payment_method_securitybank';
 if public.public_payment_method_ready('securitybank') then raise exception 'Disabled method accepted'; end if;
end $test$;
rollback;
select 'Security Bank readiness and reference checks passed; rolled back' as result;
