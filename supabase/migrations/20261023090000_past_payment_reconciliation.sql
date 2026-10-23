-- Manual decisions retain the original OCR outcome rather than masquerading as auto approval.
do $$ declare d text; begin
 d := pg_get_functiondef('public.confirm_booking_transaction(text)'::regprocedure);
 d := replace(d, E'receipt_status = case\n           when is_digital_payment and public.current_account_role() = ''owner''\n             then ''auto_approved'' else b.receipt_status end,', 'receipt_status = b.receipt_status,');
 if d like '%then ''auto_approved'' else b.receipt_status end%' then raise exception 'Confirmation function shape changed'; end if;
 execute d;
end $$;

create table public.booking_payment_reconciliations (
 id uuid primary key default gen_random_uuid(),
 booking_ref text not null,
 booking_refs text[] not null,
 amount numeric not null check(amount > 0),
 payment_reference text not null,
 reason text not null check(length(trim(reason)) between 10 and 1000),
 reconciled_by uuid not null,
 reconciled_at timestamptz not null default now(),
 previous_state jsonb not null
);
alter table public.booking_payment_reconciliations enable row level security;
revoke all on public.booking_payment_reconciliations from public,anon,authenticated;
grant select on public.booking_payment_reconciliations to authenticated;
create policy reconciliation_owner_read on public.booking_payment_reconciliations for select to authenticated
 using (public.has_account_role(array['owner','court_owner']));

create or replace function public.reconcile_past_booking_payment(p_booking_ref text,p_payment_reference text,p_reason text,p_session_completed boolean)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare anchor public.bookings%rowtype; refs text[]; snapshots jsonb; result record; amount_value numeric; audit_id uuid; ref_value text := trim(coalesce(p_payment_reference,''));
begin
 if not public.has_account_role(array['owner']) then raise exception 'Only the system owner can reconcile past payments.' using errcode='42501'; end if;
 if p_session_completed is distinct from true then raise exception 'Confirm that payment was received and the court session took place.'; end if;
 if length(trim(coalesce(p_reason,''))) not between 10 and 1000 then raise exception 'Enter a reconciliation reason of 10 to 1000 characters.'; end if;
 if length(ref_value) not between 6 and 100 or ref_value !~ '^[A-Za-z0-9 -]+$' then raise exception 'Enter the actual bank transaction reference (6 to 100 letters or digits).'; end if;
 select * into anchor from public.bookings where ref=p_booking_ref;
 if not found then raise exception 'Booking not found.'; end if;
 anchor.booking_group_ref := nullif(trim(anchor.booking_group_ref),'');
 perform b.ref from public.bookings b where (anchor.booking_group_ref is not null and nullif(trim(b.booking_group_ref),'')=anchor.booking_group_ref) or (anchor.booking_group_ref is null and b.ref=anchor.ref) order by b.ref for update;
 if not exists(select 1 from public.bookings b where b.ref=anchor.ref and nullif(trim(b.booking_group_ref),'') is not distinct from anchor.booking_group_ref) then raise exception 'Booking group changed. Refresh and retry.'; end if;
 select array_agg(b.ref order by b.ref),jsonb_agg(jsonb_build_object('ref',b.ref,'status',b.status,'payment_status',b.payment_status,'receipt_status',b.receipt_status,'receipt_flags',b.receipt_flags,'receipt_image_hash',b.receipt_image_hash,'date',b.date,'total',b.total,'downpayment',b.downpayment,'reference',b.gcash_ref)),sum(b.downpayment) into refs,snapshots,amount_value
 from public.bookings b where (anchor.booking_group_ref is not null and nullif(trim(b.booking_group_ref),'')=anchor.booking_group_ref) or (anchor.booking_group_ref is null and b.ref=anchor.ref);
 if exists(select 1 from public.bookings b where b.ref=any(refs) and (b.date is null or b.date >= (now() at time zone 'Asia/Manila')::date)) then raise exception 'Reconciliation is for bookings before today in Philippine time.'; end if;
 if exists(select 1 from public.bookings b where b.ref=any(refs) and (b.status not in ('pending','verifying') or b.payment_status <> 'for_verification' or coalesce(b.receipt_image_url,'')='' or b.payment_reassigned_to_ref is not null)) then raise exception 'Only unresolved past bookings with a receipt can be reconciled.'; end if;
 if exists(select 1 from public.bookings b where b.ref=any(refs) and coalesce(trim(b.gcash_ref),'')<>'' and public.normalize_payment_reference_key(b.payment_method,b.gcash_ref) is distinct from public.normalize_payment_reference_key(b.payment_method,ref_value)) then raise exception 'The entered reference differs from the saved payment reference. Resolve the discrepancy first.'; end if;
 update public.bookings set gcash_ref=ref_value where ref=any(refs);
 select * into result from public.confirm_booking_transaction(p_booking_ref);
 if result.booking_payment_status <> 'paid' then raise exception 'Past reconciliation requires full payment. Resolve the remaining balance first.'; end if;
 update public.bookings set status='completed' where ref=any(refs);
 insert into public.booking_payment_reconciliations(booking_ref,booking_refs,amount,payment_reference,reason,reconciled_by,previous_state)
 values(p_booking_ref,refs,amount_value,ref_value,trim(p_reason),auth.uid(),snapshots) returning id into audit_id;
 return jsonb_build_object('id',audit_id,'booking_refs',refs,'status','completed','payment_status','paid');
end $$;
revoke all on function public.reconcile_past_booking_payment(text,text,text,boolean) from public,anon;
grant execute on function public.reconcile_past_booking_payment(text,text,text,boolean) to authenticated;
