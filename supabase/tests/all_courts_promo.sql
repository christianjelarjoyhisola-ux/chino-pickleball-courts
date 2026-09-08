-- All promotion changes below are rolled back; no bookings are created.
begin;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',(select id::text from public.accounts where role='owner' limit 1),true);
do $$ declare n integer; blocked boolean; begin
 n:=public.set_all_courts_promo(true,0.01,current_date,current_date+1);
 if n<>(select count(*) from public.courts) or exists(select 1 from public.courts where not promo_enabled or promo_rate<>0.01) then raise exception 'Not all courts updated'; end if;
 blocked:=false;
 begin perform public.set_all_courts_promo(true,9999999999,null,null); exception when others then blocked:=true; end;
 if not blocked or exists(select 1 from public.courts where promo_rate<>0.01) then raise exception 'Invalid promo partially saved'; end if;
 blocked:=false;
 begin perform public.set_all_courts_promo(true,0.01,current_date+1,current_date); exception when others then blocked:=true; end;
 if not blocked then raise exception 'Reversed dates accepted'; end if;
 perform public.set_all_courts_promo(false,null,null,null);
 if exists(select 1 from public.courts where promo_enabled) then raise exception 'Disable did not apply to all courts'; end if;
end $$;
select set_config('request.jwt.claim.sub',(select id::text from public.accounts where role='court_owner' limit 1),true);
select public.set_all_courts_promo(false,null,null,null);
select set_config('request.jwt.claim.role','anon',true);
do $$ declare blocked boolean:=false; begin
 begin perform public.set_all_courts_promo(true,0.01,null,null); exception when insufficient_privilege then blocked:=true; end;
 if not blocked then raise exception 'Unauthorized promo update accepted'; end if;
end $$;
rollback;
select 'Both owner roles supported; enable/disable, dates, atomic rollback and unauthorized access checked; changes rolled back' as result;
