-- Run this in Supabase (SQL editor) to enable the "not available" marks and
-- the Stripe refund ledger used by the order bridge.

-- One row per order line that's been flagged not available. Presence = flagged.
create table if not exists unavailable_lines (
  maropost_order_id text not null,
  sku               text not null,
  created_at        timestamptz not null default now(),
  primary key (maropost_order_id, sku)
);

-- Ledger of refunds we've issued via Stripe, so we never double-refund and can
-- show how much has already been returned for an order.
create table if not exists refunds (
  id               bigserial primary key,
  maropost_order_id text not null,
  stripe_refund_id  text,
  amount            numeric(10,2) not null default 0,
  status            text not null default 'succeeded',
  skus              text,
  created_at        timestamptz not null default now()
);

create index if not exists refunds_order_idx on refunds (maropost_order_id);

-- Rolling "Completed" working list for the dashboard. One row per order that's
-- been marked ready (status changed in Maropost, customer SMS fired). This is
-- NOT the system of record - Maropost is - so the cron auto-purges rows older
-- than a week (purgeOldFulfilled).
create table if not exists fulfilled_orders (
  maropost_order_id text primary key,
  mode              text,                 -- 'pickup' | 'delivery'
  status            text,                 -- e.g. 'Pending Pickup' | 'Dispatched'
  customer          text,
  shipping          text,
  total             numeric(10,2) not null default 0,
  fulfilled_at      timestamptz not null default now()
);

create index if not exists fulfilled_orders_at_idx on fulfilled_orders (fulfilled_at);
