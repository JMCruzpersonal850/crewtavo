-- Database tests for the hourly job profit check's later fixes:
--   20261113001687_profit_check_counts_pay_as_the_job_page.sql   one sum of a job's sub and crew
--     pay, read by the job page (job_pay_costs) and by the check (job_pay_costs_for_check) alike.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t_jpc;
grant usage on schema t_jpc to authenticated, service_role;
create sequence t_jpc.passed;
grant usage on sequence t_jpc.passed to authenticated, service_role;
create function t_jpc.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  perform nextval('t_jpc.passed');
  raise notice 'ok - %', p_what;
end $$;
create function t_jpc.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function t_jpc.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema t_jpc to authenticated, service_role;
-- What the job page was told, kept to set beside what the check is told.
create table t_jpc.page_says (job_id uuid, amount numeric, payees integer);
grant all on t_jpc.page_says to authenticated, service_role;

\set mara 'c0614000-0000-0000-0000-000000000001'
\set milo 'c0614000-0000-0000-0000-000000000002'
\set moe 'c0614000-0000-0000-0000-000000000003'

-- Mara owns Maple Paving; Milo is in its office; Moe is on the crew, and paid by the job.
insert into auth.users (id, email, raw_user_meta_data) values
  (:'mara', 'mara@maple-paving.test', '{"full_name": "Mara Maple"}'),
  (:'milo', 'milo@maple-paving.test', '{"full_name": "Milo Maple"}'),
  (:'moe', 'moe@maple-paving.test', '{"full_name": "Moe Maple"}');
begin;
set local role authenticated;
select t_jpc.as_user(:'mara');
select public.create_company('Maple Paving', 'paving') as co \gset
insert into public.memberships (company_id, user_id, role) values (:'co', :'milo', 'office'), (:'co', :'moe', 'field_crew');
insert into public.clients (company_id, display_name) values (:'co', 'Mia Maple') returning id as client \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'Maple lot') returning id as job \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'Maple drive') returning id as job2 \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit_price, unit_cost) values (:'co', :'job', 'Paving', 1, 10000, 1000), (:'co', :'job2', 'Paving', 1, 4000, 500);
commit;

-- ===== One sum of a job's pay, for the job page and for the hourly check =======================
-- Moe agreed to $7,500 for the lot, then was offered $6,500 and hasn't answered: what was agreed is
-- kept (accepted_snapshot) and is what the job costs until he does. On the drive he's been paid $900.
-- (Written straight in, as the offers' own functions would leave them.)
set session_replication_role = replica;
insert into public.job_pay (company_id, job_id, user_id, status, total, accepted_snapshot) values (:'co', :'job', :'moe', 'offered', 6500, '{"total": 7500}');
insert into public.job_pay (company_id, job_id, user_id, status, total, earned_on, paid_at, paid_amount, method) values (:'co', :'job2', :'moe', 'paid', 1000, current_date, now(), 900, 'check');
set session_replication_role = origin;

begin;
set local role authenticated;
select t_jpc.as_user(:'milo');
insert into t_jpc.page_says select * from public.job_pay_costs(array[:'job', :'job2']::uuid[]);
select t_jpc.check((select amount = 7500 and payees = 1 from t_jpc.page_says where job_id = :'job') and (select amount = 900 from t_jpc.page_says where job_id = :'job2'),
  'the job page counts a re-offered price at the $7,500 agreed, and paid work at the $900 paid');
select t_jpc.check(t_jpc.error_of(format('select * from public.job_pay_costs_for_check(%L, %L)', :'co', array[:'job']::uuid[])) like '42501:%', 'the check''s own way in is the server''s alone');
commit;
set role service_role;
select t_jpc.check((select count(*) = 2 from public.job_pay_costs_for_check(:'co', array[:'job', :'job2']::uuid[]))
  and not exists (select job_id, amount, payees from public.job_pay_costs_for_check(:'co', array[:'job', :'job2']::uuid[]) except select job_id, amount, payees from t_jpc.page_says)
  and not exists (select job_id, amount, payees from t_jpc.page_says except select job_id, amount, payees from public.job_pay_costs_for_check(:'co', array[:'job', :'job2']::uuid[])),
  'the hourly check is given exactly what the job page is, the same jobs fed to both');
select t_jpc.check(not exists (select from public.job_pay_costs_for_check(gen_random_uuid(), array[:'job']::uuid[])), 'and only for the company it''s checking');
reset role;
begin;
set local role authenticated;
select t_jpc.as_user(:'moe');
select t_jpc.check(not exists (select from public.job_pay_costs(array[:'job']::uuid[])), 'the crew still isn''t told what a job''s pay comes to');
commit;

\o
select format('All %s job-profit-check checks passed.', last_value) from t_jpc.passed \gset
\echo :format
