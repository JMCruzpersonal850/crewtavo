-- Database tests for 20261113001420_review_comparison.sql: the office reads its comparison, nobody
-- else does and nobody writes it from the browser; at most five competitors and one place of its own;
-- a check keeps the count before, so the change can be shown; and the weekly check is due only for a
-- company that turned it on, with Marketing installed and places to check.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tmkrc;
grant usage on schema tmkrc to authenticated, service_role, anon;
create function tmkrc.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tmkrc.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function tmkrc.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
create function tmkrc.as_nobody() returns void language sql as $$
  select set_config('request.jwt.claims', '', true)
$$;
grant execute on all functions in schema tmkrc to authenticated, service_role, anon;

\set pat 'ae100000-0000-0000-0000-000000000001'
\set olive 'ae100000-0000-0000-0000-000000000002'
\set ray 'ae100000-0000-0000-0000-000000000003'

begin;
insert into auth.users (id, email, raw_user_meta_data) values
  (:'pat', 'pat@sketchy.test', '{"full_name": "Pat Owner"}'),
  (:'olive', 'olive@sketchy.test', '{"full_name": "Olive Office"}'),
  (:'ray', 'ray@sketchy.test', '{"full_name": "Ray Crew"}');
set local role authenticated;
select tmkrc.as_user(:'pat');
select public.create_company('Sketchy Gutters', 'general') as co \gset
reset role;
select tmkrc.as_nobody();
insert into public.memberships (company_id, user_id, role) values (:'co', :'olive', 'office'), (:'co', :'ray', 'field_crew');
update public.companies set settings = jsonb_set(coalesce(settings, '{}'), '{marketing}', '{"enabled": true}') where id = :'co';

\o
\echo 'Five competitors and the business itself'
\o /dev/null
insert into public.review_comparisons (company_id, enabled) values (:'co', true);
insert into public.review_places (company_id, place_id, name, is_own) values (:'co', 'own', 'Sketchy Gutters', true);
insert into public.review_places (company_id, place_id, name) values (:'co', 'p1', 'Rival 1');
select tmkrc.check(tmkrc.error_of(format('insert into public.review_places (company_id, place_id, name) values (%L, %L, %L)', :'co', 'p1', 'Rival 1')) like '23505:%', 'a place is on the card once');
insert into public.review_places (company_id, place_id, name) select :'co', 'p' || n, 'Rival ' || n from generate_series(2, 5) n;
select tmkrc.check(tmkrc.error_of(format('insert into public.review_places (company_id, place_id, name) values (%L, %L, %L)', :'co', 'p6', 'Rival 6')) like '22023:%', 'a sixth competitor is turned down');
select tmkrc.check(tmkrc.error_of(format('insert into public.review_places (company_id, place_id, name, is_own) values (%L, %L, %L, true)', :'co', 'own2', 'Us again')) like '23505:%', 'and a second place of its own');

\o
\echo 'A check keeps the count before'
\o /dev/null
select id as p1 from public.review_places where place_id = 'p1' \gset
set local role service_role;
select public.record_review_place(:'p1', 'Rival One', 4.4, 50, 'https://maps.google.com/?cid=1');
select tmkrc.check((select rating = 4.4 and ratings_total = 50 and previous_total is null and name = 'Rival One' from public.review_places where id = :'p1'), 'the first check has nothing before it');
select public.record_review_place(:'p1', 'Rival One', 4.5, 53, 'javascript:alert(1)');
select tmkrc.check((select ratings_total = 53 and previous_total = 50 and previous_checked_at is not null and maps_url = 'https://maps.google.com/?cid=1' from public.review_places where id = :'p1'),
  'the next keeps the count before, and only an https Maps link');

\o
\echo 'The count before is from at least six days back'
\o /dev/null
-- The first two checks were a week ago and two weeks ago.
update public.review_places set checked_at = now() - interval '7 days', previous_checked_at = now() - interval '14 days' where id = :'p1';
-- This week's check, by two servers in the same minute.
select public.record_review_place(:'p1', 'Rival One', 4.5, 58);
select tmkrc.check((select ratings_total = 58 and previous_total = 53 and previous_checked_at < now() - interval '6 days' from public.review_places where id = :'p1'), 'the weekly check compares with last week''s count');
select public.record_review_place(:'p1', 'Rival One', 4.5, 58);
select tmkrc.check((select ratings_total = 58 and previous_total = 53 from public.review_places where id = :'p1'), 'a second server checking in the same minute doesn''t wipe the change: still +5, not "No change"');
-- "Check now" the day after.
update public.review_places set checked_at = now() - interval '1 day' where id = :'p1';
select public.record_review_place(:'p1', 'Rival One', 4.6, 59);
select tmkrc.check((select ratings_total = 59 and rating = 4.6 and previous_total = 53 and previous_checked_at < now() - interval '6 days' from public.review_places where id = :'p1'),
  'a check by hand the day after shows the new count against last week''s, not against yesterday''s');
-- Next week's check: the count from six days back or more is the hand check's.
update public.review_places set checked_at = now() - interval '6 days 1 hour' where id = :'p1';
select public.record_review_place(:'p1', 'Rival One', 4.6, 64);
select tmkrc.check((select ratings_total = 64 and previous_total = 59 from public.review_places where id = :'p1'), 'next week it moves on to the latest count that''s six days old');
update public.review_places set problem = 'Google doesn''t list this place anymore.' where id = :'p1';
select public.record_review_place(:'p1', 'Rival One', 4.6, 64);
select tmkrc.check((select problem is null from public.review_places where id = :'p1'), 'a place that''s read again has nothing wrong with it');
reset role;

\o
\echo 'Read by the office, written only by the server'
\o /dev/null
set local role authenticated;
select tmkrc.as_user(:'olive');
select tmkrc.check((select count(*) = 6 from public.review_places) and (select count(*) = 1 from public.review_comparisons), 'the office reads the comparison');
select tmkrc.check(tmkrc.error_of(format('insert into public.review_places (company_id, place_id, name) values (%L, %L, %L)', :'co', 'x', 'X')) like '42501:%', 'but can''t add a place from the browser');
select tmkrc.check(tmkrc.error_of(format('update public.review_comparisons set enabled = true where company_id = %L', :'co')) like '42501:%', 'nor flip the switch around the check with Google');
select tmkrc.check(tmkrc.error_of(format('select public.record_review_place(%L, %L, 5, 999)', :'p1', 'Fake')) like '42501:%', 'nor write a rating');
select tmkrc.as_user(:'ray');
select tmkrc.check((select count(*) = 0 from public.review_places), 'field crew don''t see it');
reset role;
set local role anon;
select tmkrc.as_nobody();
select tmkrc.check(tmkrc.error_of('select count(*) from public.review_places') like '42501:%', 'nor anyone without signing in');
reset role;

\o
\echo 'The weekly check'
\o /dev/null
set local role service_role;
select tmkrc.check((select count(*) = 1 from public.review_comparisons_due(20) d where d.company_id = :'co'), 'due when never checked');
update public.review_comparisons set checked_at = now() - interval '3 days' where company_id = :'co';
select tmkrc.check((select count(*) = 0 from public.review_comparisons_due(20) d where d.company_id = :'co'), 'not again within the week');
update public.review_comparisons set checked_at = now() - interval '8 days' where company_id = :'co';
select tmkrc.check((select count(*) = 1 from public.review_comparisons_due(20) d where d.company_id = :'co'), 'due again after it');
update public.review_comparisons set enabled = false where company_id = :'co';
select tmkrc.check((select count(*) = 0 from public.review_comparisons_due(20) d where d.company_id = :'co'), 'never while it''s off');

\o
\echo 'Where nearby is, for 30 days'
\o /dev/null
update public.review_comparisons set lat = 39.78, lng = -89.65, located_at = now() - interval '29 days' where company_id = :'co';
select tmkrc.check(public.expire_review_locations() = 0 and (select lat = 39.78 from public.review_comparisons where company_id = :'co'), 'a point found 29 days ago is kept');
update public.review_comparisons set located_at = now() - interval '31 days' where company_id = :'co';
select tmkrc.check(public.expire_review_locations() = 1, 'after 30 days it''s forgotten');
select tmkrc.check((select lat is null and lng is null and located_at is null from public.review_comparisons where company_id = :'co'), 'the point and its date are gone');
update public.review_comparisons set lat = 39.78, lng = -89.65, located_at = null where company_id = :'co';
select tmkrc.check(public.expire_review_locations() = 1, 'and so is one with no date to go by');
select tmkrc.check((select lat is null from public.review_comparisons where company_id = :'co'), 'gone too');
reset role;
set local role authenticated;
select tmkrc.as_user(:'olive');
select tmkrc.check(tmkrc.error_of('select public.expire_review_locations()') like '42501:%', 'only the server forgets them');
select tmkrc.as_nobody();
reset role;
set local role service_role;

\o
\echo 'Claimed, so two servers don''t both ask Google'
\o /dev/null
update public.review_comparisons set enabled = true, checked_at = now() - interval '8 days', tried_at = null where company_id = :'co';
select tmkrc.check((select count(*) = 1 from public.claim_review_comparisons(20) d where d.company_id = :'co'), 'the first server to look takes the company');
select tmkrc.check((select count(*) = 0 from public.claim_review_comparisons(20) d where d.company_id = :'co'), 'the second finds it taken');
-- The check failed (checked_at didn't move): it isn't tried again within the hour, but is the next day.
select tmkrc.check((select tried_at is not null and checked_at < now() - interval '7 days' from public.review_comparisons where company_id = :'co'), 'a check that didn''t work leaves when it last worked alone');
update public.review_comparisons set tried_at = now() - interval '25 hours' where company_id = :'co';
select tmkrc.check((select count(*) = 1 from public.claim_review_comparisons(20) d where d.company_id = :'co'), 'a failed check is tried again the next day');
update public.review_comparisons set checked_at = now(), tried_at = now() - interval '25 hours' where company_id = :'co';
select tmkrc.check((select count(*) = 0 from public.claim_review_comparisons(20) d where d.company_id = :'co'), 'and once it has worked, not for a week');
reset role;
set local role authenticated;
select tmkrc.as_user(:'olive');
select tmkrc.check(tmkrc.error_of('select * from public.claim_review_comparisons(20)') like '42501:%', 'the office can''t claim the check');
reset role;

rollback;

\o
\echo 'All review comparison tests passed.'
