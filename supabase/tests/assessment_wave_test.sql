-- Database tests for the assessments wave (20261124000600_assessment_wave): the two tables a
-- site visit gathers into — visit_measurements (a room's tape-measure dimensions) and
-- visit_voice_reports (a spoken walkthrough's recording, transcript, items and status).
-- These pin the shape the API and the web app are written against: the columns and their
-- types, row-level security on with the field-inclusive policies apply_policies makes, the
-- voice report's status list, and the checks that keep a measurement a measurement.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1124aw;
grant usage on schema t1124aw to authenticated, service_role;
create function t1124aw.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
grant execute on all functions in schema t1124aw to authenticated, service_role;

-- Both tables are there.
select t1124aw.check(
  (select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('visit_measurements', 'visit_voice_reports')) = 2,
  'visit_measurements and visit_voice_reports exist');

-- The measurement's columns: feet are numeric, the height and the photo are optional.
select t1124aw.check(
  (select data_type from information_schema.columns where table_schema = 'public' and table_name = 'visit_measurements' and column_name = 'length_ft') = 'numeric'
  and (select data_type from information_schema.columns where table_schema = 'public' and table_name = 'visit_measurements' and column_name = 'width_ft') = 'numeric'
  and (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'visit_measurements' and column_name = 'height_ft') = 'YES'
  and (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'visit_measurements' and column_name = 'photo_id') = 'YES'
  and (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'visit_measurements' and column_name = 'label') = 'NO',
  'a measurement has a label, a length and a width, and may have a height and a photo');

-- The voice report's columns: the words and the items it was structured into.
select t1124aw.check(
  (select data_type from information_schema.columns where table_schema = 'public' and table_name = 'visit_voice_reports' and column_name = 'items') = 'jsonb'
  and (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'visit_voice_reports' and column_name = 'items') like '%[]%'
  and (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'visit_voice_reports' and column_name = 'status') like '%recorded%'
  and (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'visit_voice_reports' and column_name = 'transcript') = 'YES'
  and (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'visit_voice_reports' and column_name = 'quote_id') = 'YES',
  'a voice report holds its items as jsonb, starts recorded, and may hold a transcript and a quote');

-- Row-level security is on for both, with the four policies apply_policies makes for each.
select t1124aw.check(
  (select count(*) from pg_class where relname in ('visit_measurements', 'visit_voice_reports') and relrowsecurity) = 2,
  'row-level security is on for both tables');
select t1124aw.check(
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'visit_measurements'
     and policyname in ('visit_measurements_read', 'visit_measurements_insert', 'visit_measurements_update', 'visit_measurements_delete')) = 4
  and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'visit_voice_reports'
     and policyname in ('visit_voice_reports_read', 'visit_voice_reports_insert', 'visit_voice_reports_update', 'visit_voice_reports_delete')) = 4,
  'both tables carry read, insert, update and delete policies');

-- The policies reach the field: a field_crew member is named in the read and write checks.
select t1124aw.check(
  (select qual from pg_policies where schemaname = 'public' and tablename = 'visit_measurements' and policyname = 'visit_measurements_read') like '%field_crew%'
  and (select with_check from pg_policies where schemaname = 'public' and tablename = 'visit_voice_reports' and policyname = 'visit_voice_reports_insert') like '%field_crew%',
  'the policies include field_crew, who measure and record on the visit');

-- The status list is the five stages a report can stand at, and nothing else.
select t1124aw.check(
  (select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'public.visit_voice_reports'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%status%') like '%''recorded''%'
  and (select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'public.visit_voice_reports'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%status%') like '%''needs_key''%'
  and (select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'public.visit_voice_reports'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%status%') like '%''transcribed''%'
  and (select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'public.visit_voice_reports'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%status%') like '%''ready''%'
  and (select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'public.visit_voice_reports'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%status%') like '%''failed''%',
  'a voice report''s status is one of recorded, needs_key, transcribed, ready, failed');

-- A measurement's dimensions must be positive, and its label must say something.
select t1124aw.check(
  (select count(*) from pg_constraint where conrelid = 'public.visit_measurements'::regclass and contype = 'c'
     and (pg_get_constraintdef(oid) like '%length_ft%' or pg_get_constraintdef(oid) like '%width_ft%' or pg_get_constraintdef(oid) like '%label%')) >= 3,
  'a measurement''s label and dimensions carry their checks');

-- Both tables hang off the visit (and the company), and a report off its quote.
select t1124aw.check(
  (select count(*) from pg_constraint where contype = 'f' and conrelid = 'public.visit_measurements'::regclass
     and confrelid in ('public.visits'::regclass, 'public.companies'::regclass)) = 2
  and (select count(*) from pg_constraint where contype = 'f' and conrelid = 'public.visit_voice_reports'::regclass
     and confrelid in ('public.visits'::regclass, 'public.companies'::regclass, 'public.quotes'::regclass)) = 3,
  'measurements and voice reports reference their company and visit; a report also its quote');

-- The indexes the visit page reads by.
select t1124aw.check(
  (select count(*) from pg_indexes where schemaname = 'public' and tablename = 'visit_measurements' and indexdef like '%(company_id, visit_id)%') >= 1
  and (select count(*) from pg_indexes where schemaname = 'public' and tablename = 'visit_voice_reports' and indexdef like '%(company_id, visit_id, created_at%') >= 1,
  'both tables are indexed by company and visit');
