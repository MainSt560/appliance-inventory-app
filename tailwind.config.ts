create extension if not exists pgcrypto;

create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  department text not null,
  section text not null default '',
  type text not null default '',
  model text not null,
  showroom_qty integer not null default 0,
  warehouse_qty integer not null default 0,
  reserved_qty integer not null default 0,
  sold_not_delivered_qty integer not null default 0,
  delivered_qty integer not null default 0,
  on_order_qty integer not null default 0,
  order_point integer not null default 1,
  target_stock integer not null default 2,
  otf boolean not null default false,
  status text not null default 'Available',
  price text not null default '',
  order_placed_date text,
  order_notes text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  model text not null,
  qty_change integer not null default 0,
  actor text not null default 'Shared Device',
  notes text not null default '',
  created_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

 drop trigger if exists inventory_items_set_updated_at on public.inventory_items;
 create trigger inventory_items_set_updated_at
 before update on public.inventory_items
 for each row
 execute procedure public.set_updated_at();

alter table public.inventory_items enable row level security;
alter table public.activity_log enable row level security;

-- Shared device / internal store mode.
-- This allows the public anon key to read and write.
-- For a more locked-down setup later, replace these with authenticated policies.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'inventory_items' and policyname = 'inventory_public_full_access'
  ) then
    create policy inventory_public_full_access on public.inventory_items for all using (true) with check (true);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'activity_log' and policyname = 'activity_public_full_access'
  ) then
    create policy activity_public_full_access on public.activity_log for all using (true) with check (true);
  end if;
end $$;
