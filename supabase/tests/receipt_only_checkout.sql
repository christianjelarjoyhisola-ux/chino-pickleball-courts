begin;

do $test$ begin
 if not public.booking_occupies_slot('verifying','reserve@hold.internal','Reserving...',now()-interval '9 minutes') then raise exception 'Early hold released'; end if;
 if public.booking_occupies_slot('verifying','reserve@hold.internal','Reserving...',now()-interval '11 minutes') then raise exception 'Expired hold still occupies'; end if;
 if not public.booking_occupies_slot('verifying','customer@example.com','Real Customer',now()-interval '11 minutes') then raise exception 'Submitted receipt booking released'; end if;
 if not public.booking_occupies_slot('pending','customer@example.com','Real Customer',now()-interval '20 minutes') then raise exception 'Pending booking released'; end if;
end $test$;
rollback;
