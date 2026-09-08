begin;
do $$ begin if public.chino_project_url() <> 'https://wskzptxekldhsxluhgos.supabase.co' then raise exception 'CHINO project guard failed'; end if; end $$;
create or replace function public.set_all_courts_promo(p_enabled boolean,p_rate numeric default null,p_start date default null,p_end date default null)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare changed integer;
begin
 if auth.role() is distinct from 'authenticated' or not public.has_account_role(array['owner','court_owner']) then
  raise exception 'Only an owner or court owner can change court promotions.' using errcode='42501';
 end if;
 if p_enabled is null then raise exception 'Choose whether the promo is enabled.'; end if;
 -- An explicit court scope also satisfies the API safe-update guard.
 -- One transaction: existing pricing triggers validate every court. Any invalid
 -- rate/date rolls back the entire operation, avoiding partially applied promos.
 lock table public.courts in share row exclusive mode;
 if p_enabled then
  update public.courts set promo_enabled=true,promo_rate=p_rate,promo_start_date=p_start,promo_end_date=p_end where id is not null;
 else
  update public.courts set promo_enabled=false where id is not null;
 end if;
 get diagnostics changed=row_count;
 if changed=0 then raise exception 'Add a court before applying a promotion.'; end if;
 return changed;
end $$;
revoke all on function public.set_all_courts_promo(boolean,numeric,date,date) from public,anon;
grant execute on function public.set_all_courts_promo(boolean,numeric,date,date) to authenticated;
commit;
