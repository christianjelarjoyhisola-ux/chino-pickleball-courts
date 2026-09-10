-- Maya uses the existing dedicated receipt verifier and shared GCash receiver.
-- Clean receipts auto-approve; pending/incomplete transfers remain for review.
insert into public.settings (key, value)
values ('payment_method_maya', '1')
on conflict (key) do update
set value = excluded.value, updated_at = now();
