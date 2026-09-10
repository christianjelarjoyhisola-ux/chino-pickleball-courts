-- System-owner payment confirmation also verifies the digital payment.
-- Keep the owner attestation audit and all existing transaction safeguards.
begin;
do $migration$
declare
  definition text := pg_get_functiondef('public.confirm_booking_transaction(text)'::regprocedure);
  old_assignment text := 'payment_status = target_payment_status,';
  new_assignment text := $sql$payment_status = target_payment_status,
         receipt_status = case
           when is_digital_payment and public.current_account_role() = 'owner'
             then 'auto_approved' else b.receipt_status end,
         receipt_verified_at = case
           when is_digital_payment and public.current_account_role() = 'owner'
             then confirmation_time else b.receipt_verified_at end,$sql$;
begin
  if strpos(definition, old_assignment) = 0 then
    raise exception 'Booking confirmation payment assignment was not found';
  end if;
  execute replace(definition, old_assignment, new_assignment);
end;
$migration$;
notify pgrst, 'reload schema';
commit;
