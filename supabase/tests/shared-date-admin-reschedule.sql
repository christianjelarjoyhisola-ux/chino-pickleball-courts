-- Run against CHINO after the shared-date migration. All fixture changes roll back.
begin;
do $$
declare court text; actor uuid; target date:=current_date+45; payload jsonb; result jsonb;
begin
 select id into actor from public.accounts where role='owner' and status='active' limit 1;
 select id into court from public.courts order by id limit 1;
 if actor is null or court is null then raise exception 'Test prerequisites missing'; end if;
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform set_config('request.jwt.claim.role','authenticated',true);
 insert into public.bookings(ref,booking_group_ref,full_name,court_id,date,slots,start_time,end_time,duration,rate,total,status,payment_status,created_via)
 values ('TEST-RESCHEDULE-A','TEST-RESCHEDULE-FAMILY','Rollback fixture',court,current_date+44,array['6'],'6:00 AM','7:00 AM',1,315,315,'completed','paid','admin'),
        ('TEST-RESCHEDULE-B','TEST-RESCHEDULE-FAMILY','Rollback fixture',court,current_date+44,array['8','9'],'8:00 AM','10:00 AM',2,315,630,'confirmed','paid','admin');
 payload:=jsonb_build_array(jsonb_build_object('bookingRef','TEST-RESCHEDULE-A','date',target,'startHour',10,'expectedDate',current_date+44,'expectedSlots',jsonb_build_array(6),'expectedCourtId',court),jsonb_build_object('bookingRef','TEST-RESCHEDULE-B','date',target,'startHour',12,'expectedDate',current_date+44,'expectedSlots',jsonb_build_array(8,9),'expectedCourtId',court));
 begin
   perform public.reschedule_bookings_transaction('TEST-RESCHEDULE-A',payload);
   raise exception 'Missing reason incorrectly accepted';
 exception when sqlstate '22023' then
   if sqlerrm not like '%reason%' then raise; end if;
 end;
 payload:=jsonb_set(jsonb_set(payload,'{0,reason}','"Owner approved replacement"'),'{1,reason}','"Owner approved replacement"');
 begin
   perform public.reschedule_bookings_transaction('TEST-RESCHEDULE-A',jsonb_set(payload,'{1,startHour}','10'));
   raise exception 'Overlap incorrectly accepted';
 exception when sqlstate '23P01' then null;
 end;
 if exists(select 1 from public.bookings where ref in ('TEST-RESCHEDULE-A','TEST-RESCHEDULE-B') and date<>current_date+44) then raise exception 'Failed operation moved a row';end if;
 begin
   perform public.reschedule_bookings_transaction('TEST-RESCHEDULE-A',jsonb_set(payload,'{1,date}',to_jsonb(target+1)));
   raise exception 'Mixed dates incorrectly accepted';
 exception when sqlstate '22023' then
   if sqlerrm not like '%shared date%' then raise;end if;
 end;
 result:=public.reschedule_bookings_transaction('TEST-RESCHEDULE-A',payload);
 if jsonb_array_length(result->'items')<>2 then raise exception 'Items lost';end if;
 if (select count(*) from public.bookings where ref in ('TEST-RESCHEDULE-A','TEST-RESCHEDULE-B') and date=target and status='confirmed' and payment_status='paid')<>2 then raise exception 'State or payments not preserved';end if;
 if (select sum(total) from public.bookings where ref in ('TEST-RESCHEDULE-A','TEST-RESCHEDULE-B'))<>945 then raise exception 'Payment amount changed';end if;
 if (select count(*) from public.admin_booking_reschedule_history where booking_ref in ('TEST-RESCHEDULE-A','TEST-RESCHEDULE-B') and actor_id=actor and reason='Owner approved replacement')<>2 then raise exception 'Audit missing';end if;
 begin
   update public.admin_booking_reschedule_history set reason='changed' where booking_ref='TEST-RESCHEDULE-A';
   raise exception 'Audit mutable';
 exception when sqlstate '42501' then null;
 end;
 perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000000',true);
 begin
   perform public.reschedule_bookings_transaction('TEST-RESCHEDULE-A',payload);
   raise exception 'Unauthenticated mutation accepted';
 exception when sqlstate '42501' then null;
 end;
end;
$$;
select 'PASS: rollback-only admin reschedule integration checks' as result;
rollback;

