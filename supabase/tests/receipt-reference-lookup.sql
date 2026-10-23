begin;
create temporary table ref_test_bookings as select * from public.bookings with no data;
create temporary table ref_test_verifications as select * from public.receipt_verifications with no data;
create temporary table ref_test_actor(role text);
insert into ref_test_actor values('owner');
create function pg_temp.ref_allowed(roles text[]) returns boolean language sql as $$select coalesce(role=any(roles),false) from ref_test_actor$$;
do $$declare body text;begin
 body:=pg_get_functiondef('public.get_booking_receipt_reference_evidence(text)'::regprocedure);
 body:=replace(body,'public.get_booking_receipt_reference_evidence','pg_temp.ref_lookup');
 body:=replace(body,'public.bookings','pg_temp.ref_test_bookings');
 body:=replace(body,'public.receipt_verifications','pg_temp.ref_test_verifications');
 body:=replace(body,'public.has_account_role','pg_temp.ref_allowed');
 execute body;
end $$;
do $$declare result jsonb;begin
 insert into ref_test_bookings(ref,booking_group_ref,receipt_image_hash) values('A','GROUP','current'),('B','GROUP','child'),('C',null,'other'),('D',null,null);
 insert into ref_test_verifications(id,booking_ref,image_hash,raw_ocr_text,created_at) values
 (1,'A','old','STALE',now()),(2,'A','current','LATEST',now()),(3,'A','current','OLDER',now()-interval '1 day'),(4,'B','child','CHILD',now()),(5,'C','other','UNRELATED',now());
 result:=pg_temp.ref_lookup('A');
 if jsonb_array_length(result)<>2 or result::text not like '%LATEST%' or result::text not like '%CHILD%' or result::text like '%STALE%' or result::text like '%OLDER%' or result::text like '%UNRELATED%' then raise exception 'Evidence scope failed: %',result;end if;
 if pg_temp.ref_lookup('D')<>'[]'::jsonb then raise exception 'Missing hash must fail closed';end if;
 update ref_test_actor set role='court_owner';
 begin perform pg_temp.ref_lookup('A');raise exception 'Unauthorized accepted';exception when insufficient_privilege then null;end;
 if has_function_privilege('anon','public.get_booking_receipt_reference_evidence(text)','execute') then raise exception 'Anonymous access';end if;
end $$;
select 'PASS: current receipt only, latest evidence, grouped bookings, missing hash and owner authorization' result;
rollback;
