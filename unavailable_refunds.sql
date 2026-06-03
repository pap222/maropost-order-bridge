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
