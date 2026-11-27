-- Database tests for the painting settings page's first live failure (2026-11-26): a fresh
-- painting company's owner opened Settings → Painting and got "You don't have permission to do
-- that." The API's painting routes read companies.settings through the person's own client,
-- and 20261123100100_prices_and_settings_for_the_office.sql grants authenticated a column list
-- on companies that leaves settings out — so the read answers 42501 even for the owner, while
-- everything else the page does (the trade gate, the paint tables, saving the column) is fine.
-- The routes now read the column with the server's key, like autopay and Square do. This test
-- pins the database half of that contract: the lockdown itself, the owner's full use of the
-- paint tables, and the server's read the fix relies on.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1126p;
grant usage on schema t1126p to authenticated, service_role;
create function t1126p.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- The error a statement raises, as "code: message", or 'none'.
create function t1126p.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function t1126p.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema t1126p to authenticated, service_role;

\set oscar '11260000-0000-4000-8000-000000000001'
\set nora '11260000-0000-4000-8000-000000000002'

insert into auth.users (id, email, raw_user_meta_data) values
  (:'oscar', 'oscar@ocean.test', '{"full_name": "Oscar Owner"}'),
  (:'nora', 'nora@nora.test', '{"full_name": "Nora Other"}');

begin;
set local role authenticated;
select t1126p.as_user(:'nora');
select public.create_company('Nora Yards', 'general') as other \gset
select t1126p.as_user(:'oscar');
select public.create_company('Ocean Crest Painting', 'painting', 'America/Chicago') as co \gset

-- The gate the API checks first reads a granted column: fine for the owner.
select t1126p.check(
  (select trade_preset from public.companies where id = :'co') = 'painting',
  'owner reads companies.trade_preset (the painting gate)');

-- The bug: the person's own client cannot select companies.settings, even as owner.
select t1126p.check(
  t1126p.error_of(format('select settings from public.companies where id = %L', :'co')) like '42501:%',
  'owner selecting companies.settings as themselves is refused (42501) — the Settings → Painting failure');

-- The sanctioned as-the-person read still hands the office its painting numbers.
update public.companies set settings = '{"painting":{"defaultMarginPct":35}}'::jsonb where id = :'co';
select t1126p.check(
  (public.company_settings(:'co') -> 'painting' ->> 'defaultMarginPct') = '35',
  'company_settings() returns the painting slice to the owner');

-- The paint tables themselves were never the problem: full use as the owner.
insert into public.paint_products (company_id, name, scope, cost_per_gallon, markup_pct, coverage_per_gallon, sort)
  values (:'co', 'Interior Acrylic Latex', 'interior', 42, 30, 400, 0) returning id as product \gset
insert into public.paint_packages (company_id, set_name, name, tier, scope, sort)
  values (:'co', 'Exterior Painting', 'Better', 'better', 'exterior', 7) returning id as package \gset
select t1126p.check((select count(*) from public.paint_products where company_id = :'co') = 1, 'owner reads paint_products');
select t1126p.check((select count(*) from public.paint_packages where company_id = :'co') = 1, 'owner reads paint_packages');
update public.paint_products set cost_per_gallon = 43 where id = :'product';
select t1126p.check((select cost_per_gallon from public.paint_products where id = :'product') = 43, 'owner updates a paint product');
delete from public.paint_products where id = :'product';
delete from public.paint_packages where id = :'package';
select t1126p.check((select count(*) from public.paint_products where company_id = :'co') = 0, 'owner deletes a paint product');

-- Saving the numbers (the PUT's write half) is granted to the owner; only the read was not.
select t1126p.check(
  t1126p.error_of(format('update public.companies set settings = %L::jsonb where id = %L', '{"painting":{"defaultMarginPct":30}}', :'co')) = 'none',
  'owner updates companies.settings (the write was never refused)');

-- Another company's owner sees none of it.
select t1126p.as_user(:'nora');
select t1126p.check((select count(*) from public.paint_products where company_id = :'co') = 0, 'another company''s owner reads no paint_products');
select t1126p.check((select count(*) from public.paint_packages where company_id = :'co') = 0, 'another company''s owner reads no paint_packages');
commit;

-- The read the fixed routes use: the server's key sees the column for the company
-- requireCompany checked the person into.
begin;
set local role service_role;
select t1126p.check(
  (select settings -> 'painting' ->> 'defaultMarginPct' from public.companies where id = :'co') = '30',
  'service_role reads companies.settings (the API''s fixed read path)');
commit;
