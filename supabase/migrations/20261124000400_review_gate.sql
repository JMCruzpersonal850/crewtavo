-- Review gate: a review link no longer sends the client straight to the business's review page.
-- The API sends them to a gate page (web /r/<token>) that asks how it went first: 4-5 stars go on
-- to the review page (settings.review_url); 1-3 stars stay private — the client tells the
-- business what went wrong instead, and it lands here for the office (Marketing → Reviews).
-- The gate's open is the ask's open: track_review_click already ran when the link was followed,
-- so a gated ask stops its reminders exactly like a redirected one did.
--   * review_feedback: one private note per unhappy ask (the API writes it; the office reads it
--     and marks it handled). Stars are 1-3 by construction — a 4-5 star client never lands here.

create table public.review_feedback (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  client_id uuid,
  job_id uuid,
  review_request_id uuid,
  stars integer not null check (stars between 1 and 3),
  comment text check (comment is null or length(comment) <= 2000),
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  unique (company_id, id),
  foreign key (company_id, client_id) references public.clients (company_id, id) on delete cascade,
  foreign key (company_id, job_id) references public.jobs (company_id, id) on delete set null (job_id),
  foreign key (company_id, review_request_id) references public.review_requests (company_id, id) on delete set null (review_request_id)
);
create index review_feedback_company_idx on public.review_feedback (company_id, created_at desc);
create index review_feedback_request_idx on public.review_feedback (review_request_id);
alter table public.review_feedback enable row level security;
-- The office reads it and marks it handled (Marketing → Reviews); clients never write it through
-- their own session — the public gate writes through the server — and nobody deletes it.
create policy review_feedback_read on public.review_feedback for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'));
create policy review_feedback_update on public.review_feedback for update to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'))
  with check (private.has_role(company_id, '{owner,admin,office}'));
revoke insert, delete on public.review_feedback from authenticated;

comment on table public.review_feedback is 'Private 1-3 star feedback from the review gate: what an unhappy client told the business instead of a public review.';
