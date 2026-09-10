-- Integration test against a submitted, unpaid booking with no reference.
-- Run in a transaction with chino.test_booking_ref set, and ROLLBACK afterward.
-- Uses the real booking table and every production trigger. Each role's
-- transition is additionally rolled back inside an exception subtransaction.
do $test$
declare
  test_ref text := nullif(current_setting('chino.test_booking_ref', true), '');
  actor record;
  outcome record;
  before_state jsonb;
  after_state jsonb;
  refs text[];
  tested integer := 0;
  blocked boolean;
begin
  if test_ref is null then raise exception 'Set chino.test_booking_ref before testing'; end if;
  select array_agg(b.ref order by b.ref) into refs
    from public.bookings b join public.bookings target on target.ref=test_ref
    where b.ref=target.ref or (target.booking_group_ref is not null and b.booking_group_ref=target.booking_group_ref);
  if refs is null then raise exception 'Test booking missing'; end if;
  if exists(select 1 from public.bookings where ref=any(refs) and
    (payment_status<>'for_verification' or nullif(trim(gcash_ref),'') is not null)) then
    raise exception 'Use an unpaid booking without a reference';
  end if;
  select jsonb_agg(to_jsonb(b) order by ref) into before_state from public.bookings b where ref=any(refs);
  for actor in select distinct on (role) id,role from public.accounts
    where role in ('owner','court_owner') and status='active' order by role,id loop
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor.id,'role','authenticated')::text,true);
    perform set_config('request.jwt.claim.sub',actor.id::text,true);
    perform set_config('request.jwt.claim.role','authenticated',true);
    begin
      -- A raw update still cannot invent an unreferenced payment claim.
      blocked:=false;
      begin
        update public.bookings set status='confirmed',payment_status='paid' where ref=any(refs);
      exception when invalid_parameter_value then blocked:=true;
      end;
      if not blocked then raise exception 'Unaudited direct settlement accepted'; end if;
      select * into outcome from public.confirm_booking_transaction(test_ref);
      if not outcome.transitioned or outcome.booking_payment_status<>'paid'
        or outcome.booking_refs is distinct from refs then raise exception 'Full-trigger confirmation failed'; end if;
      select * into outcome from public.confirm_booking_transaction(test_ref);
      if outcome.transitioned then raise exception 'Repeat confirmation not idempotent'; end if;
      if (select count(*) from public.booking_owner_payment_confirmations where booking_ref=test_ref
          and confirmation_xact=txid_current() and confirmed_by=actor.id and missing_reference)<>1 then
        raise exception 'Expected one owner attestation';
      end if;
      raise exception sqlstate 'Z0001' using message='Rollback successful test';
    exception when sqlstate 'Z0001' then null;
    end;
    select jsonb_agg(to_jsonb(b) order by ref) into after_state from public.bookings b where ref=any(refs);
    if before_state is distinct from after_state then raise exception 'Test changed real booking'; end if;
    tested:=tested+1;
  end loop;
  if tested<>2 then raise exception 'Both active owner roles are needed for this integration test'; end if;
end;
$test$;
