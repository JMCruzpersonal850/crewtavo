-- Live tracking on the way: the client follows the crew on a map between the On my way tap and
-- the visit starting, the way Lead Control's tracking link works, built from Crewtavo's own
-- pieces (docs: the 2026-11-25 study in the fork's notes).
--
--   * The link is a signed link of a new kind, "track" (apps/api/src/lib/links.ts): minted by
--     the on-my-way automation as it runs ({{tracking_link}}), good for four hours at most, and
--     worth nothing once the visit leaves en route — the public page reads the visit's status,
--     not the link's word for it. No token table: the signed link is the credential, as every
--     other client link is.
--   * visit_live_location keeps only the LATEST place a crew phone reported for a visit, never
--     a trail: the client's page only ever shows the last place, and a finished trip leaves
--     nothing behind to resurrect. A row is written by the API with the service key (the ping
--     endpoint checks the person is on the visit first); the office reads it, and the office
--     can clear it (a visit put back on the schedule and sent out again starts clean).
--   * A third worker notice, en_route_sharing, joins clock_location and clock_at_property in
--     worker_notices: before a phone shares its place with a client, the worker is told once,
--     in the same words-and-tap pattern as the clock notices. A company turns the whole thing
--     off with settings.tracking.live = false (read by the field app too, below).

-- ---------------------------------------------------------------------------------------------
-- The latest place, per visit
-- ---------------------------------------------------------------------------------------------

create table public.visit_live_location (
  visit_id uuid primary key,
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,  -- whose phone reported last
  lat double precision,
  lng double precision,
  accuracy double precision,                                   -- metres, as the phone said
  recorded_at timestamptz,                                     -- when the phone took the fix
  sharing_stopped_at timestamptz,                              -- the worker tapped Stop sharing
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, visit_id) references public.visits (company_id, id) on delete cascade
);
comment on table public.visit_live_location is 'The latest place a crew phone reported while on the way to a visit; one row per visit, never a trail. Written by the API only.';
create index visit_live_location_company_idx on public.visit_live_location (company_id);
select private.add_touch_triggers(array['visit_live_location']);

alter table public.visit_live_location enable row level security;
create policy visit_live_location_read on public.visit_live_location for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'));
-- Cleared by the office, or by someone on the visit: a visit sent out again starts clean
-- (services/schedule.ts clears the row as it goes en route again), whoever tapped On my way.
create policy visit_live_location_delete on public.visit_live_location for delete to authenticated
  using (
    private.has_role(company_id, '{owner,admin,office}')
    or exists (select 1 from public.visit_assignees a where a.visit_id = visit_live_location.visit_id and a.user_id = (select auth.uid()))
    or exists (
      select 1 from public.visits v
      join public.crew_members m on m.crew_id = v.crew_id and m.company_id = v.company_id
      where v.id = visit_live_location.visit_id and m.user_id = (select auth.uid())
    )
  );
revoke all on public.visit_live_location from anon;
revoke insert, update, truncate on public.visit_live_location from authenticated;
grant select, delete on public.visit_live_location to authenticated;

-- ---------------------------------------------------------------------------------------------
-- The en-route sharing notice
-- ---------------------------------------------------------------------------------------------

alter table public.worker_notices drop constraint if exists worker_notices_notice_check;
alter table public.worker_notices add constraint worker_notices_notice_check
  check (notice in ('clock_location', 'clock_at_property', 'en_route_sharing'));
comment on table public.worker_notices is 'Notices a worker acknowledged about what the app collects (written by acknowledge_worker_notices only)';

-- As in 20261113001810_location_notice.sql, with en_route_sharing among the notices a person
-- can acknowledge.
create or replace function public.acknowledge_worker_notices(p_company uuid, p_notices text[], p_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null or not exists (
    select 1 from public.memberships m where m.company_id = p_company and m.user_id = v_user and m.active
  ) then
    raise exception 'You don''t have access to this company.' using errcode = '42501';
  end if;
  insert into public.worker_notices (company_id, user_id, notice, acknowledged_at)
  select p_company, v_user, n, least(coalesce(p_at, now()), now())
  from unnest(coalesce(p_notices, '{}')) as n
  where n in ('clock_location', 'clock_at_property', 'en_route_sharing')
  on conflict do nothing;
  return coalesce((select jsonb_object_agg(w.notice, w.acknowledged_at) from public.worker_notices w where w.company_id = p_company and w.user_id = v_user), '{}'::jsonb);
end $$;
revoke all on function public.acknowledge_worker_notices(uuid, text[], timestamptz) from public, anon;
grant execute on function public.acknowledge_worker_notices(uuid, text[], timestamptz) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Field crew read the tracking switch with the rest of their settings
-- ---------------------------------------------------------------------------------------------

-- As in 20261123100100_prices_and_settings_for_the_office.sql, with 'tracking' among what a
-- crew's screens read (packages/core/src/companySettings.ts FIELD_SETTINGS mirrors this list):
-- the field app has to know whether the company shares a crew's place at all before it offers
-- to, and before the en-route notice applies.
create or replace function private.field_settings(p_settings jsonb) returns jsonb
language sql immutable parallel safe set search_path = '' as $$
  select coalesce(jsonb_object_agg(e.key,
           case when e.key = any (array['team_chat', 'drive', 'marketing', 'paving_app', 'roofing_app', 'snow_app', 'careers', 'website'])
                then jsonb_build_object('enabled', case when jsonb_typeof(e.value) = 'object' then e.value -> 'enabled' end)
                else e.value end), '{}')
  from jsonb_each(case when jsonb_typeof(p_settings) = 'object' then p_settings else '{}' end) e
  where e.key = any (array['clock', 'branding', 'working_hours', 'schedule', 'depot', 'arrival_window_min', 'maps', 'files',
                           'contact_messages', 'receipt_reading', 'tracking',
                           'team_chat', 'drive', 'marketing', 'paving_app', 'roofing_app', 'snow_app', 'careers', 'website'])
$$;

-- ---------------------------------------------------------------------------------------------
-- The on-my-way starter carries the live tracking link
-- ---------------------------------------------------------------------------------------------

-- As in 20261105000210_on_my_way_eta.sql, with the tracking link in the on-my-way text: a crew
-- on the way can be followed live ({{tracking_link}}, services/tracking.ts). A company that
-- turned live tracking off (settings.tracking.live) sends no link: the run leaves the words
-- without one, and the line the send adds is absent too.
create or replace function private.install_default_automations(p_company uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare office jsonb := '["owner", "admin", "office"]';
begin
  insert into public.automation_rules (company_id, template_key, name, description, trigger, delay_minutes, conditions, actions, enabled)
  values
    (p_company, 'notify_quote_approved', 'Tell the office when a quote is approved',
     'A notification for the office as soon as a client approves.', 'quote.approved', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', office, 'title', 'Quote #{{number}} approved',
       'body', '{{client.name}} approved “{{title}}” ({{total}}).')), true),
    (p_company, 'notify_changes_requested', 'Tell the office when a client asks for changes',
     null, 'quote.changes_requested', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', office, 'title', 'Changes requested on quote #{{number}}',
       'body', '{{client.name}} wants changes to “{{title}}”.')), true),
    (p_company, 'notify_range_accepted', 'Tell the office when a client says yes to a price range',
     'A notification to book the site visit.', 'quote.range_accepted', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', '["owner", "admin", "office", "estimator"]'::jsonb,
       'title', '{{client.name}} wants a visit', 'body', 'They said yes to the price range for “{{title}}”. Book the site visit.')), true),
    (p_company, 'notify_new_request', 'Tell the office about new online requests',
     'Requests from your booking forms and the Client Hub.', 'request.created', 0,
     jsonb_build_array(jsonb_build_object('field', 'source', 'op', 'in', 'value', jsonb_build_array('web_form', 'hub', 'referral'))),
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', office, 'title', 'New request from {{client.name}}',
       'body', '{{title}}')), true),
    (p_company, 'notify_invoice_paid', 'Tell the office when an invoice is paid',
     null, 'invoice.paid', 0, jsonb_build_array(jsonb_build_object('field', 'amount_paid', 'op', 'gte', 'value', 0.01)),
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', office, 'title', 'Invoice #{{number}} paid',
       'body', '{{client.name}} paid {{total}}.')), true),
    (p_company, 'quote_followup', 'Follow up on quotes after 3 days',
     'Emails the client if they haven''t answered a quote three days after you send it.', 'quote.sent', 4320,
     jsonb_build_array(jsonb_build_object('field', 'status', 'op', 'equals', 'value', 'sent')),
     jsonb_build_array(jsonb_build_object('type', 'send_email',
       'subject', 'Following up on your quote from {{company.name}}',
       'body', E'Hi {{client.first_name}},\n\nJust checking whether you had any questions about quote #{{number}} ({{total}}). You can review and approve it here:\n\n{{link}}\n\nThanks,\n{{company.name}}')), true),
    (p_company, 'invoice_overdue', 'Remind clients when an invoice is past due',
     null, 'invoice.overdue', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'send_email',
       'subject', 'Reminder: invoice #{{number}} from {{company.name}} is past due',
       'body', E'Hi {{client.first_name}},\n\nThis is a friendly reminder that invoice #{{number}} has a balance of {{balance}}. You can view and pay it here:\n\n{{link}}\n\nThank you,\n{{company.name}}')), true),
    (p_company, 'visit_reminder', 'Remind clients the day before a visit',
     'Sent the day before each scheduled visit or assessment.', 'visit.reminder', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'send_email',
       'subject', 'Reminder: {{company.name}} is coming {{date}}',
       'body', E'Hi {{client.first_name}},\n\nThis is a reminder that {{company.name}} is scheduled to visit {{address}} on {{date}}{{time}}.\n\nQuestions? Reply to this email or call {{company.phone}}.')), false),
    (p_company, 'on_my_way', 'Text the client when the crew is on the way',
     'Sent when a crew taps “On my way” in the app.', 'visit.en_route', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'send_sms',
       'body', 'Hi {{client.first_name}}, this is {{company.name}}. Our crew is on the way to {{address}} now{{eta}}. Track them live: {{tracking_link}}')), false),
    (p_company, 'review_after_job', 'Ask for a Google review after a job',
     'Sends your review link a day after a job is completed.', 'job.completed', 1440,
     jsonb_build_array(jsonb_build_object('field', 'kind', 'op', 'not_equals', 'value', 'recurring')),
     jsonb_build_array(jsonb_build_object('type', 'request_review', 'channel', 'email')), false),
    (p_company, 'review_recurring', 'Ask for a Google review on recurring work',
     'Sends your review link a day after a recurring job reaches the visit you chose in Marketing, once for each job.', 'job.recurring_third_visit', 1440, '[]',
     jsonb_build_array(jsonb_build_object('type', 'request_review', 'channel', 'email')), false),
    (p_company, 'referral_after_job', 'Ask for referrals after a job',
     'Emails your referral link a week after a job is completed.', 'job.completed', 10080,
     jsonb_build_array(jsonb_build_object('field', 'kind', 'op', 'not_equals', 'value', 'recurring')),
     jsonb_build_array(jsonb_build_object('type', 'request_referral')), false),
    (p_company, 'reengage_past_clients', 'Re-engage past clients',
     'Emails clients a year after their last visit, once each time they go quiet.', 'client.inactive', 0,
     jsonb_build_array(jsonb_build_object('field', 'days_since_visit', 'op', 'gte', 'value', 365)),
     jsonb_build_array(jsonb_build_object('type', 'send_email', 'subject', 'It''s been a while, {{client.first_name}}',
       'body', E'Hi {{client.first_name}},\n\nIt''s been a while since we last worked together, and we''d love to help again. If anything around the property needs attention, you can ask for a visit online:\n\n{{link}}\n\nOr just reply to this email and we''ll get you on the schedule.\n\nThanks,\n{{company.name}}\n{{company.phone}}')), false),
    (p_company, 'win_back_lost_quotes', 'Win back lost quotes',
     'Emails the client 30 days after a quote is marked lost, if it still is.', 'quote.lost', 43200,
     jsonb_build_array(jsonb_build_object('field', 'status', 'op', 'equals', 'value', 'lost')),
     jsonb_build_array(jsonb_build_object('type', 'send_email', 'subject', 'Still thinking about {{title}}?',
       'body', E'Hi {{client.first_name}},\n\nA while ago we sent you a quote for {{title}}. If the timing wasn''t right, or you''d like us to take another look at the price or the work, you can ask us for a fresh quote online:\n\n{{link}}\n\nOr just reply to this email and we''ll take another look.\n\nThanks,\n{{company.name}}\n{{company.phone}}')), false)
  on conflict (company_id, template_key) do nothing;
end $$;

-- Rules still the starter, word for word, carry the link too; one a business changed stays as
-- they wrote it (and the send still adds the line after their words, as it does for any rule
-- whose words leave the link out).
update public.automation_rules
   set actions = jsonb_build_array(jsonb_build_object('type', 'send_sms',
                   'body', 'Hi {{client.first_name}}, this is {{company.name}}. Our crew is on the way to {{address}} now{{eta}}. Track them live: {{tracking_link}}'))
 where template_key = 'on_my_way' and trigger = 'visit.en_route'
   and actions = jsonb_build_array(jsonb_build_object('type', 'send_sms',
                   'body', 'Hi {{client.first_name}}, this is {{company.name}}. Our crew is on the way to {{address}} now{{eta}}.'));

notify pgrst, 'reload schema';
