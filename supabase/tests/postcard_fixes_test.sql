-- Database tests for the postcard fixes after the 2026-11-14 review (20261113001550 to 001575):
-- only an address Lob will take counts as mailable (a full state name becomes its code, a ZIP+4 its
-- hyphen, and what still doesn't fit is left out with why).
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tmkpf;
grant usage on schema tmkpf to authenticated, service_role, anon;
create function tmkpf.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tmkpf.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function tmkpf.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
create function tmkpf.as_nobody() returns void language sql as $$
  select set_config('request.jwt.claims', '', true)
$$;
create function tmkpf.count_of(p_sql text) returns integer language plpgsql as $$
declare v integer;
begin
  execute 'select count(*) from (' || p_sql || ') x' into v;
  return v;
end $$;
grant execute on all functions in schema tmkpf to authenticated, service_role, anon;

\set pat 'ac200000-0000-0000-0000-000000000001'
\set olive 'ac200000-0000-0000-0000-000000000002'
\set ray 'ac200000-0000-0000-0000-000000000003'

begin;
-- Pat owns Sketchy Gutters, Olive is in the office, Ray is field crew.
insert into auth.users (id, email, raw_user_meta_data) values
  (:'pat', 'pat@fixes.test', '{"full_name": "Pat Owner"}'),
  (:'olive', 'olive@fixes.test', '{"full_name": "Olive Office"}'),
  (:'ray', 'ray@fixes.test', '{"full_name": "Ray Crew"}');
set local role authenticated;
select tmkpf.as_user(:'pat');
select public.create_company('Sketchy Gutters', 'general') as co \gset
reset role;
insert into public.memberships (company_id, user_id, role) values (:'co', :'olive', 'office'), (:'co', :'ray', 'field_crew');

\o
\echo 'Addresses Lob will take'
\o /dev/null
select tmkpf.check(private.us_state_code('IL') = 'IL' and private.us_state_code(' il ') = 'IL' and private.us_state_code('Illinois') = 'IL' and private.us_state_code('new  york') = 'NY'
  and private.us_state_code('D.C.') = 'DC' and private.us_state_code('Puerto Rico') = 'PR', 'a state is its two-letter code, typed as the code or in full');
select tmkpf.check(private.us_state_code('Ill') is null and private.us_state_code('Ontario') is null and private.us_state_code('ZZ') is null and private.us_state_code('') is null,
  'and what isn''t a US state is nothing');
select tmkpf.check(private.mailable_address('12  Oak St', null, 'Springfield', 'Illinois', '627011234', '')
  = '{"line1": "12 Oak St", "city": "Springfield", "region": "IL", "postal_code": "62701-1234", "country": "US"}'::jsonb, 'an address goes as Lob takes it: IL, and 62701-1234');
select tmkpf.check(private.mailable_address('12 Oak St', 'Apt 2', 'Springfield', 'il', '62701 1234', 'USA') ->> 'postal_code' = '62701-1234'
  and private.mailable_address('12 Oak St', null, 'Springfield', 'IL', '62701', null) ->> 'postal_code' = '62701', 'a ZIP is five digits or five, a hyphen and four');
select tmkpf.check(private.mailable_address('12 Oak St', null, 'Springfield', 'Ill.', '62701', '') = '{"problem": "bad_state"}'::jsonb, 'a state that isn''t one is left out as that');
select tmkpf.check(private.mailable_address(repeat('x', 65), null, 'Springfield', 'IL', '62701', '') = '{"problem": "too_long"}'::jsonb
  and private.mailable_address('12 Oak St', repeat('x', 65), 'Springfield', 'IL', '62701', '') = '{"problem": "too_long"}'::jsonb, 'and a line longer than Lob takes as that');
select tmkpf.check(private.mailable_address('1 King St', null, 'Toronto', 'ON', 'M5H 1A1', '') = '{"problem": "outside_us"}'::jsonb
  and private.mailable_address('1 King St', null, 'Toronto', 'ON', '62701', 'CA') = '{"problem": "outside_us"}'::jsonb
  and private.mailable_address('12 Oak St', null, 'Springfield', '', '62701', '') = '{"problem": "no_address"}'::jsonb, 'abroad and incomplete are said as before');

-- Ann's state is typed in full; Bea's is something Lob can't read, with no other address; Cal's
-- billing state is bad but his property is fine; Dot's street line is too long.
insert into public.clients (company_id, display_name, status, billing_address, tags) values
  (:'co', 'Ann Oak', 'active', '{"line1": "12 Oak St", "city": "Springfield", "region": "Illinois", "postal_code": "627011234"}', '{mail}'),
  (:'co', 'Bea Elm', 'active', '{"line1": "8 Elm Ct", "city": "Springfield", "region": "Ill.", "postal_code": "62702"}', '{mail}'),
  (:'co', 'Cal Fir', 'active', '{"line1": "3 Fir Rd", "city": "Springfield", "region": "Illinoy", "postal_code": "62703"}', '{mail}'),
  (:'co', 'Dot Yew', 'active', jsonb_build_object('line1', repeat('Very Long Street Name ', 4), 'city', 'Springfield', 'region', 'IL', 'postal_code', '62704'), '{mail}');
select id as ann from public.clients where display_name = 'Ann Oak' \gset
select id as cal from public.clients where display_name = 'Cal Fir' \gset
insert into public.properties (company_id, client_id, line1, city, region, postal_code) values (:'co', :'cal', '5 Fir Rd', 'Peoria', 'illinois', '61602');

set local role authenticated;
select tmkpf.as_user(:'olive');
select tmkpf.check((select address = '{"line1": "12 Oak St", "city": "Springfield", "region": "IL", "postal_code": "62701-1234", "country": "US"}'::jsonb
  from public.postcard_audience(:'co', '{"tags_any": ["mail"]}') where client_id = :'ann'), 'Ann, in "Illinois", gets a card addressed to IL');
select tmkpf.check((select address ->> 'line1' = '5 Fir Rd' and address ->> 'region' = 'IL' from public.postcard_audience(:'co', '{"tags_any": ["mail"]}') where client_id = :'cal'),
  'Cal''s goes to his property, his billing state being unreadable');
select tmkpf.check((select jsonb_object_agg(display_name, left_out) = '{"Bea Elm": "bad_state", "Dot Yew": "too_long"}'::jsonb
  from public.postcard_audience(:'co', '{"tags_any": ["mail"]}') where left_out is not null), 'Bea and Dot are left out, each with why');
select tmkpf.check((select s -> 'count' = '2' and s -> 'left_out' ->> 'bad_state' = '1' and s -> 'left_out' ->> 'too_long' = '1' and s -> 'left_out' ->> 'no_address' = '0'
  from public.postcard_audience_summary(:'co', '{"tags_any": ["mail"]}') s), 'and the count before Send is the two Lob will take');
reset role;

rollback;

\o
\echo 'All postcard fix tests passed.'
