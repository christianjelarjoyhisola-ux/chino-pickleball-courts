-- Synthetic policy and temporary-table tests only. All changes roll back.
begin;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',(select id::text from public.accounts where role='owner' limit 1),true);
create temporary table fee_mode_snapshot_test as select * from public.bookings with no data;
create trigger fee_test_snapshot before insert on fee_mode_snapshot_test for each row execute function public.snapshot_booking_fee_on_insert();
create trigger fee_test_immutable before update on fee_mode_snapshot_test for each row execute function public.guard_booking_fee_snapshot_update();
do $test$
declare court_id text; total numeric; old_total numeric; blocked boolean; row_data record;
begin
 if public.current_account_role() is distinct from 'owner' then raise exception 'Missing System Owner test identity'; end if;
 select id into court_id from public.courts order by id limit 1;
 if court_id is null then raise exception 'Missing court test fixture'; end if;
 -- Reversible fixture prices; no bookings or payments are created.
 update public.courts set promo_enabled=false,rate=365,rate_schedule='[{"from":0,"to":24,"rate":365}]'::jsonb where id=court_id;
 perform public.set_booking_fee_policy('included',15);
 total:=public.calculate_booking_court_total(court_id,array['10'],current_date)+public.calculate_booking_service_fee(array['10']);
 if total<>365 then raise exception 'Included total should be 365: %',total; end if;
 insert into fee_mode_snapshot_test(ref,slots,total,payment_method,created_via) values ('FEE-INCLUDED',array['10'],total,'gcash','customer');
 perform public.set_booking_fee_policy('separate',15);
 total:=public.calculate_booking_court_total(court_id,array['10','11'],current_date)+public.calculate_booking_service_fee(array['10','11']);
 if total<>760 then raise exception 'Two-hour separate total should be 760: %',total; end if;
 insert into fee_mode_snapshot_test(ref,slots,total,payment_method,created_via) values ('FEE-SEPARATE',array['10','11'],total,'gcash','customer');
 select * into row_data from fee_mode_snapshot_test where ref='FEE-SEPARATE';
 if row_data.booking_fee_mode_snapshot<>'separate' or row_data.booking_fee_amount_snapshot<>30 then raise exception 'Separate snapshot mismatch'; end if;
 select * into row_data from fee_mode_snapshot_test where ref='FEE-INCLUDED';
 if row_data.total<>365 or row_data.booking_fee_mode_snapshot<>'included' or row_data.booking_fee_amount_snapshot<>15 then raise exception 'Historical snapshot changed'; end if;
 blocked:=false; begin update fee_mode_snapshot_test set booking_fee_mode_snapshot='separate' where ref='FEE-INCLUDED'; exception when sqlstate '22000' then blocked:=true; end;
 if not blocked then raise exception 'Snapshot edit allowed'; end if;
 update public.courts set promo_enabled=true,promo_rate=265,promo_start_date=null,promo_end_date=null where id=court_id;
 total:=public.calculate_booking_court_total(court_id,array['10'],current_date)+public.calculate_booking_service_fee(array['10']);
 if total<>280 then raise exception 'Separate promo total should be 280: %',total; end if;
 perform public.set_booking_fee_policy('included',15);
 total:=public.calculate_booking_court_total(court_id,array['10'],current_date)+public.calculate_booking_service_fee(array['10']);
 if total<>265 then raise exception 'Included promo total should be 265: %',total; end if;
 blocked:=false; begin perform public.set_booking_fee_policy('separate',-1); exception when sqlstate '22023' then blocked:=true; end;
 if not blocked then raise exception 'Negative fee allowed'; end if;
 blocked:=false; begin update public.settings set value='separate' where key='booking_fee_mode'; exception when sqlstate '22023' then blocked:=true; end;
 if not blocked then raise exception 'Unaudited mode change allowed'; end if;
end $test$;
select set_config('request.jwt.claim.sub',(select id::text from public.accounts where role='court_owner' limit 1),true);
do $test$ declare blocked boolean:=false; begin
 begin perform public.set_booking_fee_policy('separate',15); exception when sqlstate '42501' then blocked:=true; end;
 if not blocked then raise exception 'Court Owner changed System Owner fee policy'; end if;
 if public.can_write_setting('booking_fee_mode') then raise exception 'Court Owner can directly change fee mode'; end if;
end $test$;
rollback;
