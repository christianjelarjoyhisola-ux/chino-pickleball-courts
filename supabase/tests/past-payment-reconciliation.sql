begin;
create temporary table reconcile_test_bookings as select * from public.bookings with no data;
create temporary table reconcile_test_records (like public.booking_payment_reconciliations including defaults);
create temporary table reconcile_test_audits (like public.booking_owner_payment_confirmations including defaults);
create temporary table reconcile_test_actor(role text);
insert into reconcile_test_actor values('owner');
create function pg_temp.test_role() returns text language sql as $$select role from reconcile_test_actor$$;
create function pg_temp.test_allowed(roles text[]) returns boolean language sql as $$select coalesce(role=any(roles),false) from reconcile_test_actor$$;
do $$ declare body text; fname text; begin
 foreach fname in array array['public.confirm_booking_transaction(text)','public.reconcile_past_booking_payment(text,text,text,boolean)'] loop
 body:=pg_get_functiondef(fname::regprocedure);
 body:=replace(body,'public.confirm_booking_transaction','pg_temp.test_confirm');
 body:=replace(body,'public.reconcile_past_booking_payment','pg_temp.test_reconcile');
 body:=replace(body,'public.bookings','pg_temp.reconcile_test_bookings');
 body:=replace(body,'public.booking_payment_reconciliations','pg_temp.reconcile_test_records');
 body:=replace(body,'public.booking_owner_payment_confirmations','pg_temp.reconcile_test_audits');
 body:=replace(body,'public.has_account_role','pg_temp.test_allowed');
 body:=replace(body,'public.current_account_role','pg_temp.test_role');
 execute body;
 end loop;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000001010',true);
do $$ declare result jsonb; denied boolean; begin
 insert into reconcile_test_bookings(ref,status,payment_status,payment_method,total,downpayment,email,host_booking,date,receipt_image_url,receipt_status)
 values('TEST-PAST-RECONCILE','pending','for_verification','maribank',530,530,'test@example.invalid',false,(now() at time zone 'Asia/Manila')::date-1,'test/receipt.jpg','manual_review');
 update reconcile_test_actor set role='court_owner';
 begin perform pg_temp.test_reconcile('TEST-PAST-RECONCILE','BC550000000000000099','Bank account matched to receipt',true);raise exception 'Unauthorized accepted';exception when insufficient_privilege then null;end;
 update reconcile_test_actor set role='owner';
 begin perform pg_temp.test_reconcile('TEST-PAST-RECONCILE','BC550000000000000099','short',true);raise exception 'Missing reason accepted';exception when others then if sqlerrm='Missing reason accepted' then raise;end if;end;
 begin perform pg_temp.test_reconcile('TEST-PAST-RECONCILE','BC550000000000000099','Bank account matched to receipt',false);raise exception 'Missing attestation accepted';exception when others then if sqlerrm='Missing attestation accepted' then raise;end if;end;
 update reconcile_test_bookings set date=(now() at time zone 'Asia/Manila')::date;
 begin perform pg_temp.test_reconcile('TEST-PAST-RECONCILE','BC550000000000000099','Bank account matched to receipt',true);raise exception 'Future accepted';exception when others then if sqlerrm='Future accepted' then raise;end if;end;
 update reconcile_test_bookings set date=(now() at time zone 'Asia/Manila')::date-1;
 result:=pg_temp.test_reconcile('TEST-PAST-RECONCILE','BC550000000000000099','Bank account matched to receipt',true);
 if result->>'status'<>'completed' or (select count(*) from reconcile_test_records)<>1 or not exists(select 1 from reconcile_test_bookings where status='completed' and payment_status='paid' and receipt_status='manual_review') then raise exception 'Reconciliation or preserved OCR failed';end if;
 begin perform pg_temp.test_reconcile('TEST-PAST-RECONCILE','BC550000000000000099','Bank account matched to receipt',true);raise exception 'Repeat accepted';exception when others then if sqlerrm='Repeat accepted' then raise;end if;end;
 if (select count(*) from reconcile_test_records)<>1 then raise exception 'Duplicate audit';end if;
 insert into reconcile_test_bookings(ref,status,payment_status,payment_method,total,downpayment,email,host_booking,date,receipt_image_url,receipt_status)
 values('TEST-DUPLICATE-RECONCILE','pending','for_verification','maribank',530,530,'test@example.invalid',false,(now() at time zone 'Asia/Manila')::date-1,'test/other.jpg','manual_review');
 begin perform pg_temp.test_reconcile('TEST-DUPLICATE-RECONCILE','BC550000000000000099','Bank account matched to receipt',true);raise exception 'Duplicate reference accepted';exception when unique_violation then null;end;
 if exists(select 1 from reconcile_test_bookings where ref='TEST-DUPLICATE-RECONCILE' and payment_status='paid') then raise exception 'Failed duplicate changed payment';end if;
 update reconcile_test_bookings set status='cancelled' where ref='TEST-DUPLICATE-RECONCILE';
 begin perform pg_temp.test_reconcile('TEST-DUPLICATE-RECONCILE','BC550000000000000098','Bank account matched to receipt',true);raise exception 'Cancelled booking accepted';exception when others then if sqlerrm='Cancelled booking accepted' then raise;end if;end;

 if has_function_privilege('anon','public.reconcile_past_booking_payment(text,text,text,boolean)','execute') then raise exception 'Anonymous access';end if;
end $$;
select 'PASS: past payment, owner access, reason, attestation, date, audit, preserved OCR and repeat protection' result;
rollback;
