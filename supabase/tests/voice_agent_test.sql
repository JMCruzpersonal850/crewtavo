-- Database tests for the AI voice agent's storage (20261124000700_voice_agent): one row per
-- call the agent took, in public.ai_calls. The rows are written by the API with the service
-- key from the platform's end-of-call webhook; people only read them, in the AI Command
-- Center, and only the office may — this pins the table's shape, that office-only read (a
-- field member of the same company and another company's owner both see nothing), the
-- outcome check, and the unique index that keeps a platform's redelivered report (Retell
-- sends call_ended, then call_analyzed, for one call) from doubling a row.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1124va;
grant usage on schema t1124va to authenticated, service_role;
create function t1124va.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- The error a statement raises, as "code: message", or 'none'.
create function t1124va.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function t1124va.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema t1124va to authenticated, service_role;

\set oscar '11240000-0000-4000-8000-000000000001'
\set nora '11240000-0000-4000-8000-000000000002'
\set fred '11240000-0000-4000-8000-000000000003'
\set opal '11240000-0000-4000-8000-000000000004'

insert into auth.users (id, email, raw_user_meta_data) values
  (:'oscar', 'oscar@ocean.test', '{"full_name": "Oscar Owner"}'),
  (:'nora', 'nora@nora.test', '{"full_name": "Nora Other"}'),
  (:'fred', 'fred@ocean.test', '{"full_name": "Fred Field"}'),
  (:'opal', 'opal@ocean.test', '{"full_name": "Opal Office"}');

begin;
set local role authenticated;
select t1124va.as_user(:'nora');
select public.create_company('Nora Yards', 'general') as other \gset
select t1124va.as_user(:'oscar');
select public.create_company('Ocean Crest Painting', 'painting', 'America/Chicago') as co \gset

-- Fred works the field for Oscar's company; Opal works its office.
insert into public.memberships (company_id, user_id, role) values
  (:'co', :'fred', 'field_crew'),
  (:'co', :'opal', 'office');

-- The table is there, with RLS on.
select t1124va.check(
  (select relrowsecurity from pg_class where oid = 'public.ai_calls'::regclass),
  'ai_calls exists with row level security enabled');

-- A call, written the way the API writes it: with the service key, which bypasses RLS (there
-- is deliberately no insert policy for people).
set local role service_role;
insert into public.ai_calls (company_id, provider, provider_call_id, caller_name, caller_phone,
                             called_number, started_at, ended_at, duration_seconds, outcome,
                             summary, transcript, extracted)
  values (:'co', 'retell', 'call_abc123', 'Geoff Larue', '+18505550101', '+18505550199',
          now() - interval '5 minutes', now() - interval '2 minutes', 180, 'message',
          'Caller asked for a callback about painting his brick exterior.',
          'Agent: Thanks for calling Ocean Crest Painting...',
          '{"name":"Geoff Larue","message":"Please call me back about the brick job."}'::jsonb)
  returning id as call \gset
set local role authenticated;

-- The office reads it: the owner, and an office member.
select t1124va.check((select count(*) from public.ai_calls where id = :'call') = 1, 'owner reads the AI call');
select t1124va.as_user(:'opal');
select t1124va.check((select count(*) from public.ai_calls where id = :'call') = 1, 'office member reads the AI call');

-- A field member of the same company does not: transcripts and messages are office reading.
select t1124va.as_user(:'fred');
select t1124va.check((select count(*) from public.ai_calls where id = :'call') = 0, 'field member reads no AI calls');

-- Another company's owner does not either.
select t1124va.as_user(:'nora');
select t1124va.check((select count(*) from public.ai_calls where id = :'call') = 0, 'another company''s owner reads no AI calls');

-- The outcome check rejects a value outside the list (checked as the service key, so the
-- failure is the check itself, not the missing insert policy).
select t1124va.as_user(:'oscar');
set local role service_role;
select t1124va.check(
  t1124va.error_of(format(
    'insert into public.ai_calls (company_id, provider, outcome) values (%L, %L, %L)',
    :'co', 'vapi', 'sold')) like '23514:%',
  'an outcome outside the list is rejected');

-- The provider check does the same for a platform that isn't Retell or Vapi.
select t1124va.check(
  t1124va.error_of(format(
    'insert into public.ai_calls (company_id, provider) values (%L, %L)',
    :'co', 'carrier-pigeon')) like '23514:%',
  'a provider outside retell/vapi is rejected');

-- The unique index dedupes a redelivered report: the same (company, provider, provider_call_id)
-- cannot be written twice...
select t1124va.check(
  t1124va.error_of(format(
    'insert into public.ai_calls (company_id, provider, provider_call_id) values (%L, %L, %L)',
    :'co', 'retell', 'call_abc123')) like '23505:%',
  'the same provider call id twice in one company is rejected');

-- ...but the same call id under the other provider is a different call, and a report with no
-- call id at all is never deduped away.
insert into public.ai_calls (company_id, provider, provider_call_id) values (:'co', 'vapi', 'call_abc123');
insert into public.ai_calls (company_id, provider) values (:'co', 'retell'), (:'co', 'retell');
select t1124va.check((select count(*) from public.ai_calls where company_id = :'co') = 4,
  'other-provider and id-less reports still land');
commit;
