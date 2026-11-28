-- Assessments wave: what an estimator measures and says on a site visit, kept on the visit.
--   * visit_measurements: a room's tape-measure dimensions (length, width, optional height),
--     named by the person measuring, with an optional note and an optional photo (an
--     attachments row, referenced loosely — attachments are generic, so no foreign key).
--     The areas a proposal prices from follow from these in packages/core (roomMeasurements).
--   * visit_voice_reports: a spoken walkthrough recorded on the visit. The recording itself is
--     a file in storage (kept as an attachments row by the API); this row holds where it lives,
--     its transcript, the work items the AI structured out of the transcript, and where the
--     report stands (recorded → transcribed → ready, or needs_key / failed with the problem in
--     plain words). Converting a report makes a draft quote and remembers it here.
-- Both tables belong to the visit: when the visit goes, they go.

-- ---------------------------------------------------------------------------------------------
-- Visit measurements
-- ---------------------------------------------------------------------------------------------

create table public.visit_measurements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  visit_id uuid not null,
  label text not null check (length(trim(label)) between 1 and 120),
  length_ft numeric(10, 2) not null check (length_ft > 0),
  width_ft numeric(10, 2) not null check (width_ft > 0),
  height_ft numeric(10, 2) check (height_ft is null or height_ft > 0),
  notes text,
  -- The photo of the room, when there is one: an attachments.id. No foreign key — attachments
  -- are generic rows owned by anything, and a measurement must not fall with a photo tidy-up.
  photo_id uuid,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, visit_id) references public.visits (company_id, id) on delete cascade
);
create index visit_measurements_company_visit_idx on public.visit_measurements (company_id, visit_id);
select private.add_touch_triggers(array['visit_measurements']);
alter table public.visit_measurements enable row level security;

-- The whole field team measures and reads on a visit; the office and estimators do too.
select private.apply_policies('visit_measurements', '{owner,admin,office,estimator,crew_lead,field_crew}', '{owner,admin,office,estimator,crew_lead,field_crew}');

comment on table public.visit_measurements is 'A room measured on a site visit: its label and its tape-measure length, width and (when taken) height in feet.';
comment on column public.visit_measurements.photo_id is 'An attachments.id for a photo of the measured room, when one was taken. Loose on purpose: no foreign key.';
comment on column public.visit_measurements.height_ft is 'Ceiling height in feet, when it was measured; wall area needs it, floor and ceiling area do not.';

-- ---------------------------------------------------------------------------------------------
-- Visit voice reports
-- ---------------------------------------------------------------------------------------------

create table public.visit_voice_reports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  visit_id uuid not null,
  -- Where the recording lives in the files bucket (the same path its attachments row carries).
  audio_path text not null,
  transcript text,
  -- The work items structured out of the transcript: [{"title","detail","quantity","unit"}].
  items jsonb not null default '[]',
  status text not null default 'recorded' check (status in ('recorded', 'needs_key', 'transcribed', 'ready', 'failed')),
  -- Why it stopped, in words the person who recorded it can act on (no key, a key that failed).
  problem text,
  -- The draft proposal this report was turned into, once it has been.
  quote_id uuid,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, visit_id) references public.visits (company_id, id) on delete cascade,
  foreign key (company_id, quote_id) references public.quotes (company_id, id) on delete set null (quote_id)
);
create index visit_voice_reports_company_visit_idx on public.visit_voice_reports (company_id, visit_id, created_at desc);
select private.add_touch_triggers(array['visit_voice_reports']);
alter table public.visit_voice_reports enable row level security;

select private.apply_policies('visit_voice_reports', '{owner,admin,office,estimator,crew_lead,field_crew}', '{owner,admin,office,estimator,crew_lead,field_crew}');

comment on table public.visit_voice_reports is 'A spoken walkthrough recorded on a site visit: its recording, transcript, structured work items and status.';
comment on column public.visit_voice_reports.items is 'Work items structured from the transcript by the AI: an array of {"title","detail","quantity","unit"}.';
comment on column public.visit_voice_reports.status is 'recorded, needs_key (no OpenAI key on the company), transcribed (words saved, items not structured), ready, or failed.';
comment on column public.visit_voice_reports.problem is 'Why the report stopped where it did, in plain words; null when nothing went wrong.';
comment on column public.visit_voice_reports.quote_id is 'The draft quote this report was converted into, while that quote is there.';

notify pgrst, 'reload schema';
