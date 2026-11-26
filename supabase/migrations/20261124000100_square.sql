-- Square as another place money moves (integrations/square.ts), beside Stripe, never instead
-- of it in the data: a company connects its own Square developer app on the Apps page, and
-- clients pay its invoices from the Client Hub with Square's card form. Crewtavo stays the
-- book of record — no Square invoice mirrors a Crewtavo one — so all this adds is:
--   * invoices.pay_provider: the provider an invoice is paid with, locked when it's sent, so
--     switching the company's provider (Settings → Payments) never strands an open invoice;
--   * square_payments: one row per Square payment (or try at one), the square_payments twin
--     of stripe_invoices' live rows, so a payment on its way is known and the webhook and the
--     charge's own answer reconcile against the same row.
-- The money itself lands in the payments table with processor 'square' and the Square
-- payment id as processor_ref, exactly as Stripe's does, so totals, activity and accounting
-- follow from the same triggers. Square objects are written by the API with the service key;
-- people read them.

-- ---------------------------------------------------------------------------------------------
-- The provider an invoice is paid with
-- ---------------------------------------------------------------------------------------------

alter table public.invoices add column pay_provider text check (pay_provider in ('stripe', 'square'));

-- An invoice locked to Square has nothing in Stripe to keep in step: the Stripe sync leaves
-- it alone. Every invoice there is today has no lock (null), so nothing changes for them.
create or replace function private.enqueue_stripe() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('crewtavo.quiet', true), '') = 'on' then
    return null;
  end if;
  if new.pay_provider = 'square' then
    return null;
  end if;
  -- Drafts being edited, and void invoices, have nothing in Stripe to keep in step.
  if new.status in ('draft', 'void') and (tg_op = 'INSERT' or old.status = new.status) then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.status is not distinct from old.status and new.balance_due is not distinct from old.balance_due then
    return null;
  end if;
  if not exists (select 1 from public.integrations where company_id = new.company_id and provider = 'stripe' and status = 'connected')
     and not exists (select 1 from public.stripe_invoices where invoice_id = new.id) then
    return null;
  end if;
  if exists (
    select 1 from public.outbox
    where topic = 'stripe.invoice' and payload ->> 'invoice_id' = new.id::text
      and done_at is null and dead_at is null and locked_until is null
  ) then
    return null;
  end if;
  insert into public.outbox (company_id, topic, payload)
  values (new.company_id, 'stripe.invoice', jsonb_build_object('invoice_id', new.id));
  return null;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Square payments
-- ---------------------------------------------------------------------------------------------

create table public.square_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  invoice_id uuid,
  square_payment_id text unique,   -- Square's payment id; null while the charge is being made
  location_id text,                -- the location the payment was taken at
  status text not null default 'creating'
    check (status in ('creating', 'pending', 'completed', 'failed', 'canceled', 'refunded')),
  amount numeric(12, 2) not null default 0,      -- what's owed that was charged, tip kept apart
  tip_amount numeric(12, 2) not null default 0,
  fee_amount numeric(12, 2) not null default 0,  -- what Square kept, once it settles
  currency text not null default 'usd',
  idempotency_key text,            -- the key the charge was made with, so a retry replays it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, invoice_id) references public.invoices (company_id, id) on delete set null (invoice_id)
);
create index square_payments_invoice_idx on public.square_payments (company_id, invoice_id);
create unique index square_payments_attempt_idx on public.square_payments (company_id, idempotency_key)
  where idempotency_key is not null;
select private.add_touch_triggers(array['square_payments']);
alter table public.square_payments enable row level security;
create policy square_payments_read on public.square_payments for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'));
select private.restrict_area('square_payments', 'invoices', true);

notify pgrst, 'reload schema';
