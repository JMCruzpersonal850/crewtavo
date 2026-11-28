-- The AI voice agent: one row per call the agent took (apps/api/src/lib/voiceAgent.ts,
-- services/voiceAgent.ts and routes/voiceAgent.ts; packages/core/src/voiceAgent.ts). When a call to the office goes unanswered, the phone system forwards it to a
-- number the voice platform (Retell or Vapi) provides; the platform runs an agent on OpenAI's
-- Realtime model that can book a free estimate into the calendar or take a message, answering
-- the company's FAQs along the way. When the call ends, the platform posts its end-of-call
-- report to the API, which parses it with the service key and writes one row here — who
-- called, when, how long, what came of it (booked / message / faq / transferred / other /
-- unknown), the platform's summary and the full transcript, a link to the recording, and the
-- details the agent pulled out of the conversation (name, address, the job, the time they
-- wanted). When the agent books, the API also links the request and the visit it made, so the
-- call and the booking point at each other. Nobody writes these rows by hand: people only
-- read them, in the AI Command Center, which is an office view — so reads are office-only and
-- there is no insert/update/delete policy for people at all; the API's service key bypasses
-- RLS to write. The platform can deliver the same report twice (Retell sends call_ended and
-- then call_analyzed for one call), so (company_id, provider, provider_call_id) is unique
-- where the platform gave the call an id, and the API upserts on it instead of doubling rows.
-- Note: no private.restrict_area policy here — the areas it guards are named product surfaces
-- (invoices, sales, marketing, settings, ...) and there is no sensible one for AI calls; the
-- office-only read policy above is the whole gate, the way the table's rows are written only
-- by the service key.

create table public.ai_calls (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  provider text not null check (provider in ('retell', 'vapi')),  -- the platform that ran the call
  provider_call_id text,           -- the platform's own id for the call; null if a report lacked one
  caller_name text,                -- who called, as the platform heard it / the agent collected it
  caller_phone text,               -- the number they called from
  called_number text,              -- the number they reached (the platform's number for this company)
  started_at timestamptz,          -- when the call started, on the platform's clock
  ended_at timestamptz,            -- when it ended
  duration_seconds integer,        -- how long it ran, as the platform counted it
  outcome text not null default 'unknown'
    check (outcome in ('booked', 'message', 'faq', 'transferred', 'other', 'unknown')),
  summary text,                    -- the platform's short account of the call
  transcript text,                 -- the whole conversation, as text
  recording_url text,              -- the platform's recording, where it keeps one
  extracted jsonb not null default '{}'::jsonb,  -- what the agent pulled out: name, phone, email, address, service, starts_at, message, flags
  raw jsonb,                       -- the platform's report as it arrived, for anything the parse missed
  client_id uuid,                  -- the client the call matched or made, once the API links it
  request_id uuid,                 -- the request a booking made, once the API links it
  visit_id uuid,                   -- the visit a booking made, once the API links it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, client_id) references public.clients (company_id, id) on delete set null (client_id),
  foreign key (company_id, request_id) references public.requests (company_id, id) on delete set null (request_id),
  foreign key (company_id, visit_id) references public.visits (company_id, id) on delete set null (visit_id)
);
create unique index ai_calls_provider_call_idx on public.ai_calls (company_id, provider, provider_call_id)
  where provider_call_id is not null;
create index ai_calls_company_created_idx on public.ai_calls (company_id, created_at desc);
select private.add_touch_triggers(array['ai_calls']);
alter table public.ai_calls enable row level security;
create policy ai_calls_read on public.ai_calls for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'));

notify pgrst, 'reload schema';
