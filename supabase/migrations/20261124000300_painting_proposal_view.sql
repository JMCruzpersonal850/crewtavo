-- Painting, phase 3 (the proposal view): rooms on a proposal's lines, and the words its client
-- page is built from. Painting belongs to painting businesses only (the trade preset is the
-- gate, in the API and the web); both columns are nullable jsonb, null for every other trade's
-- rows and for every proposal written before this, and nothing here changes a table's shape
-- another trade reads.
--   * quote_line_items.paint_detail: the line's room — {room, dimensions} — so a proposal's
--     lines group into the rooms Lead Control's proposals are built from ("Exterior",
--     "Master Bedroom"), each with the dimensions its card shows (52' × 52' × 8'). The room is
--     the line's own: renaming a room rewrites the lines that say it, and a room with no lines
--     in it isn't stored anywhere. The painting math rounds its gallons up per room by this
--     name (core painting.ts), the way it already keyed them.
--   * quotes.paint_presentation: the proposal's own words for its client page —
--     {scope, notes, highlights}: the Overall Scope of Work paragraph, the Job Notes (apart
--     from quotes.message, which stays the note over the lines), and the What's Included
--     checklist, when the office writes them there. Empty pieces fall back to what proposals
--     already carry (the lines' descriptions, the message, a picked package's highlights).

alter table public.quote_line_items add column paint_detail jsonb;
comment on column public.quote_line_items.paint_detail is 'Painting only: the room this line belongs to on the proposal — {room, dimensions}. Null outside painting, and on lines in no room.';

alter table public.quotes add column paint_presentation jsonb;
comment on column public.quotes.paint_presentation is 'Painting only: the proposal''s words for its client page — {scope, notes, highlights}. Null outside painting; pieces left out fall back to the lines and the message.';

-- A copy of a proposal keeps its rooms and its words, the way it keeps its message and its
-- sections (duplicate_quote as 20261123100100 left it, with the painting pieces carried too:
-- the presentation, each line's room, and the paint package links phase 2 added beside
-- roofing's, which a copy was already dropping).
create or replace function public.duplicate_quote(p_quote uuid, p_template_name text default null, p_client uuid default null,
  p_property uuid default null, p_title text default null, p_custom_fields jsonb default null)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  q public.quotes;
  o public.quote_options;
  v_template boolean;
  v_new uuid;
  v_id uuid;
  v_map jsonb := '{}';
begin
  select * into q from public.quotes where id = p_quote;
  if not found then
    raise exception 'Quote not found' using errcode = 'P0002';
  end if;
  if p_template_name is not null and p_client is not null then
    raise exception 'A quote template has no client.' using errcode = '22023';
  end if;
  if p_template_name is not null and btrim(p_template_name) = '' then
    raise exception 'Give the template a name.' using errcode = '22023';
  end if;
  v_template := p_template_name is not null or (q.is_template and p_client is null);

  insert into public.quotes (company_id, client_id, property_id, is_template, title, message, discount_amount, tax_rate, deposit_amount, deposit_percent,
                             valid_until, roof_package_id, paint_package_id, section_ids, recurrence_rule, active_months, starts_on, ends_on, custom_fields,
                             every_job_items_left_off, payment_schedule, paint_presentation)
  select q.company_id,
         case when not v_template then coalesce(p_client, q.client_id) end,
         case when v_template then null when p_client is not null then p_property else q.property_id end,
         v_template,
         left(coalesce(nullif(btrim(p_template_name), ''), nullif(btrim(p_title), ''),
                       case when q.is_template and not v_template then q.title else q.title || ' (copy)' end), 200),
         q.message, q.discount_amount, q.tax_rate, q.deposit_amount, q.deposit_percent,
         case when v_template then null
              when q.is_template then (now() at time zone coalesce(c.timezone, 'UTC'))::date
                                      + coalesce((private.saved_settings(c.id) ->> 'quote_valid_days')::numeric::integer, 30)
              when q.valid_until > (now() at time zone coalesce(c.timezone, 'UTC'))::date then q.valid_until end,
         q.roof_package_id, q.paint_package_id, q.section_ids, q.recurrence_rule, q.active_months, q.starts_on, q.ends_on,
         case when p_client is not null and p_custom_fields is not null then p_custom_fields
              when v_template or q.is_template then q.custom_fields else '{}' end,
         case when q.is_template then q.every_job_items_left_off else '{}' end,
         private.schedule_for_copy(q.payment_schedule),
         q.paint_presentation
    from public.companies c where c.id = q.company_id
  returning id into v_new;

  for o in select * from public.quote_options where quote_id = p_quote order by sort, id loop
    insert into public.quote_options (company_id, quote_id, package_id, paint_package_id, name, tier, picture, picture_width, picture_height,
                                      style, highlights, warranty, section_ids, sort)
    values (o.company_id, v_new, o.package_id, o.paint_package_id, o.name, o.tier, o.picture, o.picture_width, o.picture_height,
            o.style, o.highlights, o.warranty, o.section_ids, o.sort)
    returning id into v_id;
    v_map := v_map || jsonb_build_object(o.id::text, v_id);
  end loop;
  if q.option_id is not null then
    update public.quotes set option_id = (v_map ->> q.option_id::text)::uuid
     where id = v_new and option_id is distinct from (v_map ->> q.option_id::text)::uuid;
  end if;

  insert into public.quote_line_items (company_id, quote_id, option_id, service_id, name, description, quantity, unit, unit_price,
                                       unit_cost, taxable, optional, selected, option_group, formula, sort, materials, material_cost, paint_detail)
  select l.company_id, v_new, (v_map ->> l.option_id::text)::uuid, l.service_id, l.name, l.description, l.quantity, l.unit, l.unit_price,
         l.unit_cost, l.taxable, l.optional, not l.optional, l.option_group, l.formula, l.sort, l.materials, l.material_cost, l.paint_detail
    from public.quote_line_items l where l.quote_id = p_quote
   order by l.sort;
  return v_new;
end $$;

notify pgrst, 'reload schema';
