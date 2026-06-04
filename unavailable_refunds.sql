-- Run this in Supabase (SQL editor) to enable the "not available" marks and
-- the Stripe refund ledger used by the order bridge.

-- One row per short-supplied order line. `qty` = how many units are NOT
-- available (the rest are still sent). qty NULL = whole line unavailable.
create table if not exists unavailable_lines (
  maropost_order_id text not null,
  sku               text not null,
  qty               numeric(10,3),
  created_at        timestamptz not null default now(),
  primary key (maropost_order_id, sku)
);

-- If the table already existed without the qty column, add it.
alter table unavailable_lines add column if not exists qty numeric(10,3);

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

-- Store the QuickB2B invoice / order number returned when an order is pushed,
-- so the dashboard can show "Sent to QuickB2B inv XXX" instead of a generic
-- "pushed" badge. (Safe to run even if synced_orders already exists.)
alter table synced_orders add column if not exists qb2b_invoice text;

-- Dedup ledger for the Slack "needs mapping" alerts: one row per order we've
-- already pinged about, so the 5-minute cron never re-alerts the same order.
-- `kind` lets us reuse the table for other alert types later.
create table if not exists notified_orders (
  maropost_order_id text not null,
  kind              text not null default 'needs_map',
  created_at        timestamptz not null default now(),
  primary key (maropost_order_id, kind)
);
