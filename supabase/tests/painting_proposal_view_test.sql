-- Database tests for painting phase 3's storage (20261124000300_painting_proposal_view): a
-- line's room on quote_line_items.paint_detail and the proposal's client-page words on
-- quotes.paint_presentation. Both are plain nullable jsonb under the tables' existing
-- policies, so the builder's own client (the office's, through PostgREST) writes and reads
-- them like any other line field — this pins that, plus the one function that copies a
-- proposal wholesale: duplicate_quote must carry the rooms and the words (and the paint
-- package links phase 2 added, which a copy was dropping), or duplicating a proposal would
-- quietly unpaint it.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1127pv;
grant usage on schema t1127pv to authenticated, service_role;
create function t1127pv.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t1127pv.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema t1127pv to authenticated, service_role;

\set oscar '11270000-0000-4000-8000-000000000001'
\set nora '11270000-0000-4000-8000-000000000002'

insert into auth.users (id, email, raw_user_meta_data) values
  (:'oscar', 'oscar@ocean.test', '{"full_name": "Oscar Owner"}'),
  (:'nora', 'nora@nora.test', '{"full_name": "Nora Other"}');

begin;
set local role authenticated;
select t1127pv.as_user(:'nora');
select public.create_company('Nora Yards', 'general') as other \gset
select t1127pv.as_user(:'oscar');
select public.create_company('Ocean Crest Painting', 'painting', 'America/Chicago') as co \gset

insert into public.clients (company_id, display_name, email) values (:'co', 'Geoff Larue', 'larue123@hotmail.com') returning id as geoff \gset
insert into public.paint_packages (company_id, set_name, name, tier, scope, sort)
  values (:'co', 'Exterior Painting', 'Better', 'better', 'exterior', 0) returning id as pkg \gset
insert into public.quotes (company_id, client_id, title, paint_package_id, paint_presentation)
  values (:'co', :'geoff', 'Exterior — Brick Painting', :'pkg',
          '{"scope":"Repaint the painted brick exterior.","notes":"Cash offer — one coat.","highlights":["Cash offer — $3,500 total","No warranty included"]}'::jsonb)
  returning id as prop \gset
insert into public.quote_options (company_id, quote_id, paint_package_id, name, sort)
  values (:'co', :'prop', :'pkg', 'Better', 0) returning id as opt \gset
insert into public.quote_line_items (company_id, quote_id, option_id, name, unit_price, paint_detail)
  values (:'co', :'prop', :'opt', 'Brick Painting', 3500, '{"room":"Exterior","dimensions":"52'' × 52'' × 8''"}'::jsonb) returning id as line \gset

-- The columns are jsonb, and null where nothing was written.
select t1127pv.check(
  (select data_type from information_schema.columns where table_schema = 'public' and table_name = 'quote_line_items' and column_name = 'paint_detail') = 'jsonb'
  and (select data_type from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'paint_presentation') = 'jsonb',
  'paint_detail and paint_presentation are jsonb columns');

-- The builder's writes, as the owner through their own client: a line's room, the words.
update public.quote_line_items set paint_detail = '{"room":"Side Wall"}'::jsonb where id = :'line';
select t1127pv.check(
  (select paint_detail ->> 'room' from public.quote_line_items where id = :'line') = 'Side Wall',
  'owner writes and reads a line''s room');
update public.quote_line_items set paint_detail = '{"room":"Exterior","dimensions":"52'' × 52'' × 8''"}'::jsonb where id = :'line';
update public.quotes set paint_presentation = '{"scope":"Written scope."}'::jsonb where id = :'prop';
select t1127pv.check(
  (select paint_presentation ->> 'scope' from public.quotes where id = :'prop') = 'Written scope.',
  'owner writes and reads the proposal''s words');
update public.quotes set paint_presentation = '{"scope":"Repaint the painted brick exterior.","notes":"Cash offer — one coat.","highlights":["Cash offer — $3,500 total","No warranty included"]}'::jsonb where id = :'prop';

-- A copy keeps the whole painting shape: the words, the package links, each line's room.
select public.duplicate_quote(:'prop') as copy \gset
select t1127pv.check(
  (select paint_presentation from public.quotes where id = :'copy') = (select paint_presentation from public.quotes where id = :'prop'),
  'a copy keeps the proposal''s words');
select t1127pv.check(
  (select paint_package_id from public.quotes where id = :'copy') = :'pkg'
  and (select paint_package_id from public.quote_options where quote_id = :'copy') = :'pkg',
  'a copy keeps the paint package links (the quote''s and its options'')');
select t1127pv.check(
  (select paint_detail from public.quote_line_items where quote_id = :'copy') = '{"room":"Exterior","dimensions":"52'' × 52'' × 8''"}'::jsonb,
  'a copy keeps each line''s room and dimensions');

-- Another company's owner sees none of it.
select t1127pv.as_user(:'nora');
select t1127pv.check((select count(*) from public.quotes where id = :'prop') = 0, 'another company''s owner reads no proposal');
select t1127pv.check((select count(*) from public.quote_line_items where quote_id = :'prop') = 0, 'another company''s owner reads none of its lines');
commit;
