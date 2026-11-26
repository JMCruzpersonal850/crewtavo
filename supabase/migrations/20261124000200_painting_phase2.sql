-- Painting, phase 2: the products a painting business paints with, and its Good / Better / Best
-- packages (paint_packages, the paint_packages twin of roof_packages). Painting belongs to
-- painting businesses only (the trade preset is the gate, in the API and the web); these tables
-- are written for any company the way roof_packages is, and the painting routes refuse every
-- other trade before touching them. Also: a quote option — and the quote itself — can remember
-- the paint package it came from, beside roof's package_id, never instead of it.
--   * paint_products: cost per gallon, the markup it carries, and what a gallon covers (in the
--     surface's own unit — square feet for walls, linear feet for trim).
--   * paint_packages: a tier of a named set for interior or exterior work, with the product it
--     paints with, its coats, its markup over the base price and its warranty — Lead Control's
--     proposal-template packages, in Crewtavo's shape.
-- Prices and options follow from these in the API (services/paintPackages.ts); nothing here
-- changes a table another trade reads.

-- ---------------------------------------------------------------------------------------------
-- Paint products
-- ---------------------------------------------------------------------------------------------

create table public.paint_products (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  brand text check (brand is null or length(trim(brand)) between 1 and 80),
  -- Where the product is used: on interior surfaces, exterior surfaces, or trim.
  scope text not null default 'interior' check (scope in ('interior', 'exterior', 'trim')),
  cost_per_gallon numeric(10, 2) not null default 0 check (cost_per_gallon >= 0),
  markup_pct numeric(6, 2) not null default 30 check (markup_pct >= 0 and markup_pct <= 1000),
  coverage_per_gallon numeric(10, 2) not null default 400 check (coverage_per_gallon > 0),
  active boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);
create index paint_products_company_idx on public.paint_products (company_id, active, sort);
select private.add_touch_triggers(array['paint_products']);
alter table public.paint_products enable row level security;

-- The people who price work read them; the price list's people change them, like services.
select private.apply_policies('paint_products', '{owner,admin,office,estimator}', '{owner,admin,office,estimator}');
select private.restrict_area('paint_products', 'settings', false);

comment on table public.paint_products is 'A painting business''s paints: what a gallon costs, the markup it carries, and what a gallon covers.';
comment on column public.paint_products.coverage_per_gallon is 'What one gallon covers, in the unit of the surfaces it is used on (sq ft for walls, lin ft for trim).';

-- ---------------------------------------------------------------------------------------------
-- Paint packages
-- ---------------------------------------------------------------------------------------------

create table public.paint_packages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  -- The named set the tier belongs to (Lead Control's proposal template): a business can keep
  -- more than one set per scope and offer the tiers it chooses.
  set_name text not null default '' check (length(set_name) <= 80),
  name text not null check (length(trim(name)) between 1 and 80),
  tier text not null check (tier in ('good', 'better', 'best')),
  scope text not null check (scope in ('interior', 'exterior')),
  tagline text not null default '' check (length(tagline) <= 200),
  description text not null default '' check (length(description) <= 600),
  -- The paint grade in the client's words ("Premium", "Ultra-Premium"), when the tier has one.
  paint_grade text check (paint_grade is null or length(trim(paint_grade)) between 1 and 40),
  -- The product it paints with: a row of paint_products when its price is known, and always the
  -- client-facing name, which is all Lead Control's packages carry.
  product_id uuid,
  product_name text check (product_name is null or length(trim(product_name)) between 1 and 120),
  coats integer not null default 2 check (coats between 1 and 5),
  primer_coats integer not null default 0 check (primer_coats between 0 and 3),
  -- The tier's uplift over the base price, the DripJobs way (Good 0%, Better 15%, Best 30%).
  markup_pct numeric(6, 2) not null default 0 check (markup_pct >= 0 and markup_pct <= 1000),
  warranty_months integer not null default 0 check (warranty_months >= 0 and warranty_months <= 240),
  -- The warranty in a line, as the client reads it on the option ("3-year workmanship warranty").
  warranty text not null default '' check (length(warranty) <= 400),
  highlights text[] not null default '{}' check (cardinality(highlights) <= 8 and array_position(highlights, null) is null and length(array_to_string(highlights, '')) <= 1200),
  is_enabled boolean not null default true,
  is_default boolean not null default false,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, product_id) references public.paint_products (company_id, id) on delete set null (product_id)
);
create index paint_packages_company_idx on public.paint_packages (company_id, scope, sort);
select private.add_touch_triggers(array['paint_packages']);
alter table public.paint_packages enable row level security;

select private.apply_policies('paint_packages', '{owner,admin,office,estimator}', '{owner,admin,office,estimator}');
select private.restrict_area('paint_packages', 'settings', false);

comment on table public.paint_packages is 'A painting business''s Good / Better / Best packages: tiers of a named set, per scope, with their product, coats, markup and warranty.';

-- ---------------------------------------------------------------------------------------------
-- Quotes remember their paint package, the way they remember a roof package
-- ---------------------------------------------------------------------------------------------

alter table public.quote_options
  add column paint_package_id uuid,
  add constraint quote_options_paint_package_fkey foreign key (company_id, paint_package_id)
    references public.paint_packages (company_id, id) on delete set null (paint_package_id);
create index quote_options_paint_package_idx on public.quote_options (paint_package_id) where paint_package_id is not null;
comment on column public.quote_options.paint_package_id is 'The paint package it was made from, while that package is there.';

alter table public.quotes
  add column paint_package_id uuid,
  add constraint quotes_paint_package_fkey foreign key (company_id, paint_package_id)
    references public.paint_packages (company_id, id) on delete set null (paint_package_id);
comment on column public.quotes.paint_package_id is 'The paint package its lines came from.';

notify pgrst, 'reload schema';
