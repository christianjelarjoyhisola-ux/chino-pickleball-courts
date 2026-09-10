-- Owner-requested CHINO policy: match the GoTyme recipient name rather than
-- requiring the masked destination account suffix. Other payment checks and
-- providers keep their existing requirements. The verifier reads this setting
-- server-side; a player cannot select the policy in an upload request.
begin;
do $$ begin
  if public.chino_project_url() <> 'https://wskzptxekldhsxluhgos.supabase.co' then
    raise exception 'Wrong project';
  end if;
end $$;
insert into public.settings (key, value)
values ('gotyme_receipt_recipient_policy', 'masked_name_only')
on conflict (key) do update set value = excluded.value;
commit;
