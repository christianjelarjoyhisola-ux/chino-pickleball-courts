-- Permit missing references only for the owner attestation inserted by the
-- confirmation transaction. Keep all available receipt replay keys protected.
begin;
alter table public.booking_owner_payment_confirmations
  add column confirmation_xact bigint not null default txid_current();

create function public.has_current_owner_payment_attestation(p_ref text, p_method text)
returns boolean language sql volatile security definer set search_path=public,pg_temp as $$
  select public.has_account_role(array['owner','court_owner']) and exists (
    select 1 from public.booking_owner_payment_confirmations a
    where a.confirmed_by=auth.uid()
      and a.confirmed_role=public.current_account_role()
      and a.confirmation_xact=txid_current()
      and a.missing_reference
      and p_ref=any(a.booking_refs)
      and a.payment_method=p_method
  )
$$;
revoke all on function public.has_current_owner_payment_attestation(text,text) from public,anon,authenticated;

CREATE OR REPLACE FUNCTION public.claim_owner_confirmed_receipt_evidence()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  actor_role_value text := public.current_account_role();
  provider_value text := lower(trim(coalesce(new.payment_method, '')));
  claim_scope_value text;
  claim_owner_value text;
  evidence_key record;
  incumbent_scope text;
  incumbent_owner text;
begin
  if auth.uid() is null
     or actor_role_value not in ('owner', 'court_owner')
     or provider_value not in (
       'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'pnb', 'securitybank'
     )
     or lower(trim(coalesce(new.payment_status, ''))) not in (
       'paid', 'downpayment_paid'
     )
     or lower(trim(coalesce(old.payment_status, ''))) in (
       'paid', 'downpayment_paid'
     ) then
    return new;
  end if;

  claim_scope_value := case
    when nullif(trim(coalesce(new.booking_group_ref, '')), '') is null
      then 'booking'
    else 'booking_group'
  end;
  claim_owner_value := coalesce(
    nullif(trim(coalesce(new.booking_group_ref, '')), ''),
    new.ref
  );

  -- Always claim the typed provider reference, even when older/mismatched OCR
  -- evidence did not emit a complete dedupeKeys array.
  if not (
    nullif(trim(coalesce(new.gcash_ref, '')), '') is null
    and new.status = 'confirmed'
    and new.payment_status in ('paid', 'downpayment_paid')
    and public.has_current_owner_payment_attestation(new.ref, provider_value)
  ) then
    perform public.claim_payment_reference(
      provider_value,
      new.gcash_ref,
      claim_scope_value,
      claim_owner_value,
      new.ref
    );
  end if;

  for evidence_key in
    select distinct keys.ledger_key, keys.provider_key
      from public.payment_review_ledger_keys(
        coalesce(new.receipt_extracted, '{}'::jsonb),
        provider_value,
        new.gcash_ref
      ) keys
  loop
    if nullif(trim(coalesce(evidence_key.ledger_key, '')), '') is null
       or length(evidence_key.ledger_key) > 240
       or nullif(trim(coalesce(evidence_key.provider_key, '')), '') is null
       or length(evidence_key.provider_key) > 80 then
      raise exception 'Receipt verifier emitted an invalid replay key.'
        using errcode = '22023';
    end if;

    insert into public.used_gcash_refs (
      gcash_ref,
      booking_ref,
      provider,
      claim_scope,
      claim_owner_id
    ) values (
      evidence_key.ledger_key,
      new.ref,
      evidence_key.provider_key,
      claim_scope_value,
      claim_owner_value
    )
    on conflict (gcash_ref) do nothing;

    select ledger.claim_scope, ledger.claim_owner_id
      into incumbent_scope, incumbent_owner
      from public.used_gcash_refs ledger
     where ledger.gcash_ref = evidence_key.ledger_key;
    if incumbent_scope is distinct from claim_scope_value
       or incumbent_owner is distinct from claim_owner_value then
      raise exception 'This receipt or payment-rail reference is already linked to another payment.'
        using errcode = '23505';
    end if;
  end loop;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.claim_booking_reference_when_settled()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  method_value text := lower(coalesce(nullif(trim(new.payment_method), ''), 'cash'));
  owner_scope text := case
    when nullif(trim(coalesce(new.booking_group_ref, '')), '') is not null
      then 'booking_group'
    else 'booking'
  end;
  owner_id text := coalesce(
    nullif(trim(coalesce(new.booking_group_ref, '')), ''),
    new.ref
  );
begin
  if new.payment_status not in ('paid', 'downpayment_paid', 'deposit_retained')
     or method_value = 'cash' then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.payment_status in ('paid', 'downpayment_paid', 'deposit_retained')
     and lower(coalesce(nullif(trim(old.payment_method), ''), 'cash')) = method_value
     and old.gcash_ref is not distinct from new.gcash_ref
     and old.booking_group_ref is not distinct from new.booking_group_ref then
    return new;
  end if;

  if not (
    nullif(trim(coalesce(new.gcash_ref, '')), '') is null
    and new.status = 'confirmed'
    and new.payment_status in ('paid', 'downpayment_paid')
    and public.has_current_owner_payment_attestation(new.ref, method_value)
  ) then
    perform public.claim_payment_reference(
      method_value,
      new.gcash_ref,
      owner_scope,
      owner_id,
      new.ref
    );
  end if;
  return new;
end;
$function$;

notify pgrst, 'reload schema';
commit;
