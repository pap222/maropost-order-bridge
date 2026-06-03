// Shared bridge logic used by BOTH the scheduled cron and the review-page API
// functions, so there is a single source of truth for how orders are fetched,
// mapped, and pushed to QuickB2B.

export const cfg = () => ({
  netoUrl: process.env.NETO_API_URL,
  netoKey: process.env.NETO_API_KEY,
  qb2bBase: process.env.QB2B_BASE_URL || "https://go.quickb2b.com/rest/0.1",
  qb2bKey: process.env.QB2B_API_KEY,
  qb2bSupplier: process.env.QB2B_SUPPLIER_ID,
  webCustomer: process.env.QB2B_WEB_CUSTOMER_CODE || "WEB",
  supaUrl: process.env.SUPABASE_URL,
  supaKey: process.env.SUPABASE_SERVICE_KEY,
  reviewPassword: process.env.REVIEW_PASSWORD,
  // global default test mode for the cron; the page can override per request
  testMode: process.env.QB2B_TEST_MODE === "1",
  // Maropost order statuses. "Mark ready" moves an order to one of these, which
  // is what fires the customer SMS (configured in Maropost). Override via env if
  // a text doesn't trigger - the string must match the Maropost status exactly.
  deliveryStatus: process.env.MAROPOST_DELIVERY_STATUS || "Dispatched",
  pickupStatus: process.env.MAROPOST_PICKUP_STATUS || "Pending Pickup",
  // Statuses an order sits in while it still needs processing (the "To Process" tab).
  activeStatuses: (process.env.MAROPOST_ACTIVE_STATUSES || "Pick,Pack,Pending Dispatch")
    .split(",").map((s) => s.trim()).filter(Boolean),
});

// --- auth for the review API -----------------------------------------------
// Returns null if OK, or a Response (401) if the shared password is missing/wrong.
export function checkAuth(req) {
  const c = cfg();
  if (!c.reviewPassword) {
    return json({ error: "Server missing REVIEW_PASSWORD env var" }, 500);
  }
  const token = req.headers.get("x-review-token") || "";
  if (token !== c.reviewPassword) {
    return json({ error: "Unauthorized" }, 401);
  }
  return null;
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// --- Supabase --------------------------------------------------------------
export async function supa(path, opts = {}) {
  const c = cfg();
  const res = await fetch(`${c.supaUrl}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: c.supaKey,
      Authorization: `Bearer ${c.supaKey}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status} ${text}`);
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { throw new Error(`Supabase ${path}: non-JSON ${res.status}: ${text.slice(0, 200)}`); }
}

// --- app settings (live toggles the page can flip) -------------------------
// Stored in the app_settings table (key text primary key, value text).
// Reading is resilient: if the table is missing or unreachable we fall back to
// the provided default so the cron never crashes.
export async function getSetting(key, fallback = null) {
  try {
    const rows = (await supa(`app_settings?key=eq.${encodeURIComponent(key)}&select=value`)) || [];
    return rows.length ? rows[0].value : fallback;
  } catch {
    return fallback;
  }
}

export async function setSetting(key, value) {
  return supa("app_settings", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([{ key: String(key), value: String(value), updated_at: new Date().toISOString() }]),
  });
}

// True if automation is ON. Priority: live Supabase setting > AUTO_MODE env var.
export async function isAutoMode() {
  const v = await getSetting("auto_mode", null);
  if (v === "1" || v === "0") return v === "1";
  return process.env.AUTO_MODE === "1";
}

export async function loadItemMap() {
  const rows = (await supa("item_map?select=maropost_sku,qb2b_item_code,qty_factor")) || [];
  const m = new Map();
  for (const r of rows) {
    const f = Number(r.qty_factor);
    m.set(String(r.maropost_sku), { code: r.qb2b_item_code, factor: Number.isFinite(f) && f > 0 ? f : 1 });
  }
  return m;
}

export async function upsertMapping({ maropost_sku, qb2b_item_code, qty_factor }) {
  return supa("item_map", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([{
      maropost_sku: String(maropost_sku),
      qb2b_item_code: String(qb2b_item_code),
      qty_factor: Number(qty_factor) > 0 ? Number(qty_factor) : 1,
    }]),
  });
}

// Returns a Map<orderId, qb2bInvoice> for orders already pushed for REAL. The
// value is the QuickB2B invoice/order number ("" if we didn't capture one).
// Map.has() still works as the "already pushed?" check for callers.
export async function syncedSet(orderIds) {
  if (!orderIds.length) return new Map();
  const list = orderIds.map((id) => `"${id}"`).join(",");
  // Only REAL pushes block a re-push. Test-mode pushes are recorded (status
  // "test") but ignored here, so an order you tried in test can still be sent
  // for real. A subsequent real push upserts the row to status "created".
  let rows;
  try {
    rows = (await supa(`synced_orders?maropost_order_id=in.(${list})&qb2b_status=neq.test&select=maropost_order_id,qb2b_invoice`)) || [];
  } catch {
    // qb2b_invoice column not added yet -> fall back to the id-only select.
    rows = (await supa(`synced_orders?maropost_order_id=in.(${list})&qb2b_status=neq.test&select=maropost_order_id`)) || [];
  }
  return new Map(rows.map((r) => [r.maropost_order_id, r.qb2b_invoice || ""]));
}

export async function markSynced(orderId, status, payload, qb2bInvoice = null) {
  const base = {
    maropost_order_id: String(orderId),
    qb2b_status: status,
    synced_at: new Date().toISOString(),
    payload,
  };
  const body = qb2bInvoice ? { ...base, qb2b_invoice: String(qb2bInvoice) } : base;
  const post = (b) => supa("synced_orders", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(b),
  });
  try {
    await post(body);
  } catch (e) {
    // If the qb2b_invoice column doesn't exist yet, still record the push.
    if (qb2bInvoice && /qb2b_invoice|column|schema cache|PGRST/i.test(String(e.message || ""))) {
      await post(base);
    } else throw e;
  }
}

// Pull the QuickB2B invoice / order number out of a createOrder response. The
// exact field name varies, so we probe the common ones (top level + one nested
// level). Returns "" if none is present (UI then just shows "Sent to QuickB2B").
export function qb2bInvoiceNo(data) {
  const pick = (o) => {
    if (!o || typeof o !== "object") return "";
    for (const k of [
      "invoice", "invoice_number", "invoiceNumber", "invoice_no", "invoiceNo", "inv",
      "order_id", "orderId", "OrderID", "order_number", "orderNumber", "order_no",
      "docket", "docket_number", "reference", "ref", "id",
    ]) {
      const v = o[k];
      if (v != null && v !== "" && (typeof v === "string" || typeof v === "number")) return String(v);
    }
    return "";
  };
  if (!data || typeof data !== "object") return "";
  return pick(data) || pick(data.data) || pick(data.order) || pick(data.result) || "";
}

// --- "not available" line marks --------------------------------------------
// A line can be short-supplied: some units unavailable, the rest still sent.
// Each unavailable_lines row stores the unavailable QTY for an (order, sku).
// A row with qty NULL means the whole line is unavailable (legacy). Stored in
// Supabase so the marks survive a refresh.
// Returns a Map<orderId, Map<sku, qty>>; qty is a number, or null = whole line.
export async function unavailableMap(orderIds) {
  if (!orderIds.length) return new Map();
  const list = orderIds.map((id) => `"${id}"`).join(",");
  const rows = (await supa(`unavailable_lines?maropost_order_id=in.(${list})&select=maropost_order_id,sku,qty`)) || [];
  const m = new Map();
  for (const r of rows) {
    const id = String(r.maropost_order_id);
    if (!m.has(id)) m.set(id, new Map());
    m.get(id).set(String(r.sku), r.qty == null ? null : Number(r.qty));
  }
  return m;
}

// Map<sku, qty> of the unavailable units for one order.
export async function unavailableSet(orderId) {
  return (await unavailableMap([String(orderId)])).get(String(orderId)) || new Map();
}

// Set how many units of a line are not available. qty<=0 clears the mark.
export async function setUnavailable(orderId, sku, qty) {
  const n = Number(qty);
  if (n > 0) {
    return supa("unavailable_lines", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ maropost_order_id: String(orderId), sku: String(sku), qty: n }),
    });
  }
  return supa(
    `unavailable_lines?maropost_order_id=eq.${encodeURIComponent(orderId)}&sku=eq.${encodeURIComponent(sku)}`,
    { method: "DELETE" }
  );
}

// Total already refunded (in dollars) for an order, from our refunds ledger.
export async function refundedTotal(orderId) {
  const rows = (await supa(`refunds?maropost_order_id=eq.${encodeURIComponent(orderId)}&status=eq.succeeded&select=amount`)) || [];
  return Number(rows.reduce((s, r) => s + Number(r.amount || 0), 0).toFixed(2));
}

export async function recordRefund({ orderId, stripeRefundId, amount, status, skus }) {
  return supa("refunds", {
    method: "POST",
    body: JSON.stringify({
      maropost_order_id: String(orderId),
      stripe_refund_id: stripeRefundId || null,
      amount: Number(amount) || 0,
      status: String(status || "succeeded"),
      skus: skus || null,
    }),
  });
}

// --- fulfilled / completed log ---------------------------------------------
// When an order is "marked ready" we log it here for the Completed tab. This is
// just a working list - the real record stays in Maropost - so it's auto-purged
// weekly (see purgeOldFulfilled, called from the cron).
export async function markFulfilled(orderId, { mode, status, customer, shipping, total }) {
  return supa("fulfilled_orders", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      maropost_order_id: String(orderId),
      mode: mode || null,
      status: status || null,
      customer: customer || null,
      shipping: shipping || null,
      total: Number(total) || 0,
      fulfilled_at: new Date().toISOString(),
    }),
  });
}

export async function completedList(days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return (await supa(`fulfilled_orders?fulfilled_at=gte.${since}&order=fulfilled_at.desc&select=*`)) || [];
}

// Delete Completed-log rows older than `days` (the data lives on in Maropost).
export async function purgeOldFulfilled(days = 7) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  try { return await supa(`fulfilled_orders?fulfilled_at=lt.${encodeURIComponent(cutoff)}`, { method: "DELETE" }); }
  catch { return null; }
}

// --- fulfilment mode -------------------------------------------------------
// "pickup" if the order ships as in-store pick-up, else "delivery".
export function fulfilmentMode(order) {
  const ship = String(order?.ShippingOption || "");
  return /pick\s*-?\s*up/i.test(ship) ? "pickup" : "delivery";
}

// The Maropost status to set when this order is "marked ready". Changing the
// status is what triggers the customer SMS (via their TouchSMS webhook):
//   pickup   -> Pending Pickup ("your order is ready to collect")
//   delivery -> Dispatched     ("your order is on the way")
export function readyStatusFor(order) {
  const c = cfg();
  return fulfilmentMode(order) === "pickup" ? c.pickupStatus : c.deliveryStatus;
}

// Change an order's status in Maropost via UpdateOrder. The new status is what
// fires the customer SMS, so this is the core of "mark ready".
export async function updateOrderStatus(orderId, status) {
  const c = cfg();
  const res = await fetch(c.netoUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Accept: "application/json",
      NETOAPI_ACTION: "UpdateOrder", NETOAPI_KEY: c.netoKey,
    },
    body: JSON.stringify({ Order: [{ OrderID: String(orderId), OrderStatus: String(status) }] }),
  });
  if (!res.ok) throw new Error(`Neto UpdateOrder failed: ${res.status} ${await res.text()}`);
  const data = await res.json().catch(() => ({}));
  if (data.Ack !== "Success") {
    throw new Error(`Neto UpdateOrder Ack: ${data.Ack} ${JSON.stringify(data.Messages || {})}`);
  }
  return data;
}

// --- Maropost / Neto -------------------------------------------------------
const ORDER_OUTPUT = [
  "OrderID", "OrderStatus", "Email", "Username", "SalesChannel",
  "BillFirstName", "BillLastName", "ShipFirstName", "ShipLastName",
  "ShipStreetLine1", "ShipStreetLine2", "ShipCity", "ShipState", "ShipPostCode",
  "ShipPhone", "BillPhone", "DatePlaced", "GrandTotal", "OrderPayment",
  // Invoice totals + dates + the customer's delivery note.
  "ShippingTotal", "SurchargeTotal", "DateInvoiced", "DeliveryInstruction",
  // DateRequired = the date the customer wants it (can be next week);
  // ShippingOption tells pickup vs local delivery.
  "DateRequired", "ShippingOption",
  // OrderLine must be requested as nested fields, otherwise Neto only returns
  // SKU/Quantity/OrderLineID (no ProductName). UnitPrice feeds the printable
  // invoice.
  "OrderLine.SKU", "OrderLine.ProductName", "OrderLine.Quantity", "OrderLine.UnitPrice",
];

// Business identity for the printable invoice.
export const BUSINESS = { name: "Wagga Fruit Supply", abn: "53 151 280 091" };

// Format a Neto datetime as a plain Wagga-local date, e.g. "02/06/2026".
export function fmtDate(s) {
  if (!s) return "";
  const d = new Date(String(s).replace(" ", "T") + (String(s).includes(" ") ? "Z" : "T00:00:00Z"));
  if (isNaN(d)) return String(s).slice(0, 10);
  const p = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney", day: "2-digit", month: "2-digit", year: "numeric",
  }).formatToParts(d);
  const g = (t) => (p.find((x) => x.type === t) || {}).value || "";
  return `${g("day")}/${g("month")}/${g("year")}`;
}

// Build a Ship-to / Billed-to address block from the order (already enriched
// with the customer's Ship*/Bill* fields). prefix is "Ship" or "Bill".
function addressBlock(order, prefix) {
  const g = (k) => order[prefix + k] || "";
  const name = [g("FirstName"), g("LastName")].filter(Boolean).join(" ");
  const company = g("Company");
  const phone = g("Phone");
  const country = g("Country") === "AU" ? "Australia" : g("Country");
  const l1 = g("StreetLine1"), l2 = g("StreetLine2");
  const cityLine = [g("City"), g("State"), g("PostCode")].filter(Boolean).join(" ");
  const lines = [];
  if (l1) lines.push(l1);
  if (l2 && l2.toLowerCase() !== l1.toLowerCase()) lines.push(l2);
  if (cityLine) lines.push(cityLine);
  if (country) lines.push(country);
  return { name, company, phone, lines };
}

// Format a Neto datetime as a Wagga-local date, e.g. "Mon 01/06/2026".
// IMPORTANT: Neto's API returns these timestamps in UTC ("2026-05-31 14:00:00"),
// but the store operates in Wagga (Australia/Sydney, UTC+10/+11). So we must
// parse the value as UTC and then format it in the store's local zone, or the
// date can land a day early (14:00 UTC on 31 May is actually 1 Jun locally).
export function fmtReqDate(s) {
  if (!s) return "";
  const d = new Date(String(s).replace(" ", "T") + "Z");
  if (isNaN(d)) return String(s).slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    weekday: "short", day: "2-digit", month: "2-digit", year: "numeric",
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || "";
  return `${get("weekday")} ${get("day")}/${get("month")}/${get("year")}`;
}

// Same UTC->Wagga conversion as fmtReqDate, but returns a machine date string
// "YYYY-MM-DD" for QuickB2B's delivery-date field (so it never lands a day early).
export function reqDateISO(s) {
  if (!s) return "";
  const d = new Date(String(s).replace(" ", "T") + "Z");
  if (isNaN(d)) return String(s).slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Today's date in Wagga (Australia/Sydney) as "YYYY-MM-DD". Used as the QuickB2B
// delivery date so a pushed order lands on the day it was pushed, not the
// customer's wanted date (which QuickB2B was scheduling onto the next run).
export function todayISO() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Fetch Website orders. Options:
//   statuses     - OrderStatus list (defaults to the active "to process" set)
//   limit        - max rows (default 50)
//   requirePaid  - only keep paid orders (default true)
//   extraFilter  - extra Neto Filter keys (e.g. { OrderID: [...] })
// Results are sorted newest-first (by DatePlaced) so new orders load at the top.
export async function fetchWebsiteOrders(opts = {}) {
  const c = cfg();
  const {
    statuses = c.activeStatuses,
    limit = 50,
    requirePaid = true,
    extraFilter = {},
  } = opts;
  const res = await fetch(c.netoUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Accept: "application/json",
      NETOAPI_ACTION: "GetOrder", NETOAPI_KEY: c.netoKey,
    },
    body: JSON.stringify({
      Filter: {
        OrderStatus: statuses,
        OutputSelector: ORDER_OUTPUT,
        Page: 0, Limit: limit,
        ...extraFilter,
      },
    }),
  });
  if (!res.ok) throw new Error(`Neto GetOrder failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (data.Ack && data.Ack !== "Success") {
    throw new Error(`Neto GetOrder Ack: ${data.Ack} ${JSON.stringify(data.Messages || {})}`);
  }
  const orders = Array.isArray(data.Order) ? data.Order : [];
  const filtered = orders.filter((o) => o.SalesChannel === "Website" && (!requirePaid || isPaid(o)));
  filtered.sort((a, b) => String(b.DatePlaced || "").localeCompare(String(a.DatePlaced || "")));
  return enrichOrders(filtered);
}

export async function fetchOneOrder(orderId) {
  const c = cfg();
  // Look across active + post-fulfilment statuses so we can still find an order
  // after it's been marked ready (e.g. to refund a dispatched order).
  const statuses = [...new Set([...c.activeStatuses, c.deliveryStatus, c.pickupStatus, "Dispatched", "On Hold"])];
  const orders = await fetchWebsiteOrders({ statuses, extraFilter: { OrderID: [String(orderId)] } });
  return orders[0] || null;
}

// Web orders don't carry the buyer's name/address on the ORDER record itself —
// GetOrder returns only Email/OrderID for these. The real name + address live on
// the linked CUSTOMER (nested under ShippingAddress / BillingAddress). We fetch
// the customers in a single batched GetCustomer call (keyed by Username, falling
// back to Email) and flatten their address fields onto each order so the rest of
// the pipeline (customerInfo) can read order.ShipFirstName etc. unchanged.
export async function fetchCustomers({ usernames = [], emails = [] }) {
  const c = cfg();
  const uList = [...new Set(usernames.filter(Boolean).map(String))];
  const eList = [...new Set(emails.filter(Boolean).map(String))];
  if (!uList.length && !eList.length) return { byUsername: new Map(), byEmail: new Map() };
  const Filter = { OutputSelector: ["EmailAddress", "Username", "BillingAddress", "ShippingAddress"] };
  if (uList.length) Filter.Username = uList;
  if (eList.length) Filter.Email = eList;
  const res = await fetch(c.netoUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Accept: "application/json",
      NETOAPI_ACTION: "GetCustomer", NETOAPI_KEY: c.netoKey,
    },
    body: JSON.stringify({ Filter }),
  });
  const byUsername = new Map(), byEmail = new Map();
  if (!res.ok) return { byUsername, byEmail };
  const data = await res.json().catch(() => ({}));
  const list = Array.isArray(data.Customer) ? data.Customer : [];
  for (const cust of list) {
    if (cust.Username) byUsername.set(String(cust.Username), cust);
    const em = String(cust.EmailAddress || "").toLowerCase();
    if (em) byEmail.set(em, cust);
  }
  return { byUsername, byEmail };
}

function mergeCustomer(order, cust) {
  if (!cust) return order;
  const fields = { ...(cust.BillingAddress || {}), ...(cust.ShippingAddress || {}) };
  for (const [k, v] of Object.entries(fields)) {
    if ((order[k] == null || order[k] === "") && v != null && v !== "") order[k] = v;
  }
  return order;
}

export async function enrichOrders(orders) {
  if (!orders.length) return orders;
  const { byUsername, byEmail } = await fetchCustomers({
    usernames: orders.map((o) => o.Username),
    emails: orders.map((o) => o.Email),
  });
  for (const o of orders) {
    const cust = (o.Username && byUsername.get(String(o.Username)))
      || (o.Email && byEmail.get(String(o.Email).toLowerCase()))
      || null;
    mergeCustomer(o, cust);
  }
  return orders;
}

export function isPaid(order) {
  const pays = order.OrderPayment;
  if (!pays) return false;
  const arr = Array.isArray(pays) ? pays : [pays];
  return arr.some((p) => Number(p.Amount) > 0 && !!p.DatePaid);
}

// --- mapping / payload -----------------------------------------------------
// Returns a review-friendly view of one order: customer info + each line with
// its mapping resolved (or flagged unmapped) and the converted quantity.
export function reviewOrder(order, itemMap, unavailable = new Map()) {
  const lines = Array.isArray(order.OrderLine) ? order.OrderLine : order.OrderLine ? [order.OrderLine] : [];
  const reviewed = lines.map((l) => {
    const sku = String(l.SKU || "");
    const orderedQty = Number(l.Quantity || 1);
    const unitPrice = Number(l.UnitPrice || 0);
    const entry = itemMap.get(sku);
    // How many units are short-supplied. A stored qty of null means "whole line"
    // (legacy mark); otherwise clamp the stored qty to what was ordered.
    const rawNa = unavailable.has(sku) ? unavailable.get(sku) : 0;
    const naQty = rawNa == null ? orderedQty : Math.min(Math.max(Number(rawNa) || 0, 0), orderedQty);
    return {
      sku,
      product_name: l.ProductName || "",
      ordered_qty: orderedQty,
      unit_price: unitPrice,
      line_total: Number((orderedQty * unitPrice).toFixed(2)),
      mapped: !!entry,
      qb_code: entry ? entry.code : "",
      factor: entry ? entry.factor : 1,
      out_qty: entry ? Number((orderedQty * entry.factor).toFixed(3)) : null,
      // Short-supply: na_qty units unavailable, refund_line = their value.
      na_qty: naQty,
      unavailable: naQty > 0,
      refund_line: Number((naQty * unitPrice).toFixed(2)),
    };
  });
  // What we should refund = value of the unavailable units (GST-inclusive,
  // since the prices already include GST).
  const refundTotal = Number(reviewed.reduce((s, l) => s + l.refund_line, 0).toFixed(2));
  // --- invoice totals (mirror Maropost's breakdown) ---
  const productSubtotal = Number(reviewed.reduce((s, l) => s + l.line_total, 0).toFixed(2));
  const shippingTotal = Number(order.ShippingTotal || 0);
  const surchargeTotal = Number(order.SurchargeTotal || 0);
  const grandTotal = Number(order.GrandTotal || 0);
  const gst = Number((grandTotal - productSubtotal - shippingTotal - surchargeTotal).toFixed(2));
  const payArr = Array.isArray(order.OrderPayment) ? order.OrderPayment : order.OrderPayment ? [order.OrderPayment] : [];
  const amountPaid = Number(payArr.reduce((s, p) => s + Number(p.Amount || 0), 0).toFixed(2));
  const payments = payArr
    .filter((p) => Number(p.Amount) > 0)
    .map((p) => ({
      date: fmtDate(p.DatePaid),
      // The API doesn't expose the payment method; a surcharge implies a card.
      method: surchargeTotal > 0 ? "Card" : "Payment",
      amount: Number(p.Amount || 0),
    }));

  return {
    order_id: String(order.OrderID),
    customer: customerInfo(order),
    ship_to: addressBlock(order, "Ship"),
    bill_to: addressBlock(order, "Bill"),
    lines: reviewed,
    unmapped_count: reviewed.filter((l) => !l.mapped).length,
    unavailable_count: reviewed.filter((l) => l.unavailable).length,
    refund_total: refundTotal,
    required_date: fmtReqDate(order.DateRequired),
    placed_date: fmtReqDate(order.DatePlaced),
    shipping: order.ShippingOption || "",
    instructions: order.DeliveryInstruction || "",
    // invoice fields
    business: BUSINESS,
    date_placed: fmtDate(order.DatePlaced),
    date_invoiced: fmtDate(order.DateInvoiced),
    product_subtotal: productSubtotal,
    shipping_total: shippingTotal,
    surcharge_total: surchargeTotal,
    gst,
    grand_total: grandTotal,
    amount_paid: amountPaid,
    balance_due: Number((grandTotal - amountPaid).toFixed(2)),
    paid: amountPaid + 0.001 >= grandTotal && grandTotal > 0,
    payments,
  };
}

function customerInfo(order) {
  const realName = [order.ShipFirstName || order.BillFirstName, order.ShipLastName || order.BillLastName]
    .filter(Boolean).join(" ");
  const company = order.ShipCompany || order.BillCompany || "";
  const email = order.Email || "";
  // These web orders often carry only an email (no name/company/address in
  // Maropost), so fall back to company, then email, as the customer identifier.
  const name = realName || company || email || "Web customer";
  // Dedupe consecutive identical parts (Neto sometimes copies StreetLine1 into
  // StreetLine2) so the address doesn't read "59 Avocet Drive, 59 Avocet Drive".
  const parts = [];
  for (const p of [order.ShipStreetLine1, order.ShipStreetLine2, order.ShipCity, order.ShipState, order.ShipPostCode]) {
    const v = (p == null ? "" : String(p)).trim();
    if (v && v.toLowerCase() !== (parts[parts.length - 1] || "").toLowerCase()) parts.push(v);
  }
  const address = parts.join(", ");
  const phone = order.ShipPhone || order.BillPhone || "";
  return { name, company, phone, address, email };
}

// QuickB2B item codes that are generic catch-alls (e.g. MISCELLANEOUS ITEM).
// Anything mapped to one of these has no real description on the docket, so we
// spell out the actual product + qty in the comment. Configurable via env.
const MISC_CODES = new Set(
  (process.env.QB2B_MISC_CODES || "MISC,MISCELLANEOUS")
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
);
export function isMiscCode(code) {
  return MISC_CODES.has(String(code || "").trim().toUpperCase());
}

// Build the QuickB2B payload. Unmapped lines are skipped and flagged in the
// order comment (never sent as a raw SKU). Lines mapped to a generic MISC item
// get their real description on that line's own per-item comment so it shows up
// next to the item on the docket. Returns { payload, unmapped }.
export function buildPayload(order, itemMap) {
  const lines = Array.isArray(order.OrderLine) ? order.OrderLine : order.OrderLine ? [order.OrderLine] : [];
  const unmapped = [];
  const OrderDetail = [];
  for (const l of lines) {
    const sku = String(l.SKU || "");
    const orderedQty = Number(l.Quantity || 1);
    const entry = itemMap.get(sku);
    if (!entry) {
      unmapped.push(`${sku} x${orderedQty}${l.ProductName ? " (" + l.ProductName + ")" : ""}`);
      continue;
    }
    const qty = Number((orderedQty * entry.factor).toFixed(3));
    const detail = { item_code: entry.code, quantity: qty };
    // Generic MISC line: the docket would just read "MISCELLANEOUS ITEM xN", so
    // attach what it actually is as a per-line comment on the item itself
    // (not the order-level comment) so it sits next to the line on the docket.
    if (isMiscCode(entry.code)) detail.comment = l.ProductName || sku;
    OrderDetail.push(detail);
  }
  const ci = customerInfo(order);
  const ship = order.ShippingOption || "";
  // Pickup vs delivery: "Free Pick-up In Store" -> pickup; anything else (e.g.
  // "Wagga Local Delivery") is a delivery that needs the address on the docket.
  const isPickup = /pick\s*-?\s*up/i.test(ship);
  // Keep the order comment lean: PICK UP / DELIVERY, the address on deliveries,
  // and the customer name on both. The delivery-date field now carries the push
  // date, so the customer's wanted date goes in the comment instead.
  let comment;
  if (isPickup) {
    comment = `PICK UP | ${ci.name}`;
  } else {
    comment = "DELIVERY";
    if (ci.address) comment += ` | ${ci.address}`;
    comment += ` | ${ci.name}`;
  }
  const wanted = fmtReqDate(order.DateRequired);
  if (wanted) comment += ` | Wanted: ${wanted}`;
  // Safety flag: any line we couldn't map must be packed by hand - keep this even
  // in the lean comment so items are never silently dropped.
  if (unmapped.length) comment += ` | *** NOT IN QUICKB2B - PACK MANUALLY: ${unmapped.join("; ")} ***`;
  // QuickB2B's delivery-date field drives its scheduling. Stamp it with the push
  // date (today, Wagga time) so the order lands on the day it's pushed instead of
  // being scheduled onto the next delivery run from the customer's wanted date.
  // The customer's wanted date still rides on the docket via DateRequired.
  const payload = { customer_code: cfg().webCustomer, comment, OrderDetail };
  payload.delivery_date = todayISO();
  return { payload, unmapped };
}

// --- QuickB2B --------------------------------------------------------------
export async function createQb2bOrder(payload, testMode) {
  const c = cfg();
  const endpoint = testMode ? `${c.qb2bBase}/createOrder/test.json` : `${c.qb2bBase}/createOrder.json`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": c.qb2bKey,
      "supplier-id": c.qb2bSupplier,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data = {};
  if (text) { try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 200) }; } }
  return { ok: res.ok && data.status === 1, status: res.status, data };
}

// --- Stripe (refunds) ------------------------------------------------------
// We talk to Stripe's REST API directly (no SDK dependency). The secret key is
// server-side only (STRIPE_SECRET_KEY). Refunds are partial: only the value of
// the items marked "not available".
const STRIPE_API = "https://api.stripe.com/v1";

function stripeHeaders(extra = {}) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Server missing STRIPE_SECRET_KEY env var");
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/x-www-form-urlencoded",
    ...extra,
  };
}

async function stripeGet(path) {
  const res = await fetch(`${STRIPE_API}${path}`, { headers: stripeHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Stripe ${path}: ${res.status} ${data?.error?.message || ""}`.trim());
  return data;
}

// Shape a PaymentIntent / Charge / Checkout Session into our standard result.
function shapePI(pi, how) {
  return { paymentIntentId: pi.id, chargeId: pi.latest_charge || null, amount: pi.amount, currency: pi.currency, refunded: 0, matchedBy: how };
}
function shapeCharge(ch, how) {
  return { paymentIntentId: ch.payment_intent || null, chargeId: ch.id, amount: ch.amount, currency: ch.currency, refunded: ch.amount_refunded || 0, matchedBy: how };
}

// Resolve a Stripe id the user pasted directly (pi_… / ch_… / py_… / cs_…).
async function resolveStripeId(id) {
  const s = String(id || "").trim();
  if (!s) return null;
  try {
    if (s.startsWith("pi_")) return shapePI(await stripeGet(`/payment_intents/${s}`), "explicit-pi");
    if (s.startsWith("ch_") || s.startsWith("py_")) return shapeCharge(await stripeGet(`/charges/${s}`), "explicit-charge");
    if (s.startsWith("cs_")) {
      const sess = await stripeGet(`/checkout/sessions/${s}`);
      if (sess.payment_intent) return shapePI(await stripeGet(`/payment_intents/${sess.payment_intent}`), "explicit-session");
    }
  } catch { /* fall through to null */ }
  return null;
}

// Does a Stripe charge/intent look like it belongs to this customer?
// Checks the billing name, billing/receipt email, and the description text.
function payerMatches(obj, hints) {
  if (!obj) return false;
  const bd = obj.billing_details || {};
  const hay = [bd.name, bd.email, obj.receipt_email, obj.description]
    .map((s) => String(s || "").toLowerCase()).join(" | ");
  const name = String(hints.name || "").toLowerCase().trim();
  const email = String(hints.email || "").toLowerCase().trim();
  if (email && hay.includes(email)) return true;
  if (name && name.length >= 3 && hay.includes(name)) return true;
  return false;
}

// Find the Stripe payment for a Maropost order. Strategy, in order:
//   1. An explicit id the user pasted (pi_/ch_/py_/cs_).
//   2. Order id in metadata — only if STRIPE_ORDER_ID_META_KEY is configured.
//   3. Amount + customer name/email: search charges of the exact order total and
//      match the payer. Covers all history and is robust to description wording.
//   4. Last resort: scan recent charges/intents for the order number in the
//      description or metadata.
// hints = { amountCents, name, email } sharpen steps 3 & 4.
// Returns { paymentIntentId, chargeId, amount, currency, refunded, matchedBy } or null.
export async function findStripePayment(orderId, explicitId = null, hints = {}) {
  if (explicitId) {
    const direct = await resolveStripeId(explicitId);
    if (direct) return direct;
  }

  const raw = String(orderId);
  const digits = raw.replace(/\D/g, ""); // "27575" from "N27575"
  const ids = [...new Set([raw, digits].filter(Boolean))];
  const amountCents = Number(hints.amountCents) || 0;

  // 2. Targeted metadata search — ONLY when the operator has told us which
  //    metadata key holds the order id (STRIPE_ORDER_ID_META_KEY). The old code
  //    probed a dozen guessed keys × 3 endpoints = ~78 sequential Stripe calls,
  //    which blew past Netlify's 10s function limit (the function then returns an
  //    HTML error page -> "Unexpected token '<'"). This Neto/Stripe setup stores
  //    the id in the charge DESCRIPTION, not metadata, so the bounded scan in
  //    step 3 is what actually finds it.
  const metaKey = process.env.STRIPE_ORDER_ID_META_KEY;
  if (metaKey) {
    for (const idv of ids) {
      const q = encodeURIComponent(`metadata['${metaKey}']:'${idv}'`);
      for (const kind of ["payment_intents", "charges", "checkout/sessions"]) {
        let data;
        try { data = await stripeGet(`/${kind}/search?query=${q}&limit=1`); }
        catch { continue; }
        const hit = (data.data || [])[0];
        if (!hit) continue;
        if (kind === "payment_intents") return shapePI(hit, `metadata:${metaKey}`);
        if (kind === "charges") return shapeCharge(hit, `metadata:${metaKey}`);
        // checkout session -> resolve its PaymentIntent
        if (hit.payment_intent) {
          try { return shapePI(await stripeGet(`/payment_intents/${hit.payment_intent}`), `session.metadata:${metaKey}`); } catch { /* */ }
        }
      }
    }
  }

  // 3. Amount + customer match. Search charges for the exact order total, then
  //    pick the one whose payer matches. "Very rare to have two people with the
  //    same total" — so a unique amount is taken on its own; otherwise the payer
  //    name/email disambiguates. Uses Stripe Search so it covers all history.
  if (amountCents > 0) {
    const q = encodeURIComponent(`amount:${amountCents}`);
    try {
      const data = await stripeGet(`/charges/search?query=${q}&limit=100`);
      const rows = (data.data || []).filter((ch) => (ch.status === "succeeded" || ch.paid));
      const named = rows.filter((ch) => payerMatches(ch, hints));
      // Prefer a payer match; fall back to a single charge of this exact amount.
      const pick = named.length === 1 ? named[0]
        : named.length > 1 ? named.sort((a, b) => (b.created || 0) - (a.created || 0))[0]
        : rows.length === 1 ? rows[0]
        : null;
      if (pick) return shapeCharge(pick, named.length ? "amount+payer" : "amount-unique");
    } catch { /* search not available / errored -> fall through to scan */ }
  }

  // 4. Brute-force fallback: scan recent payments and match the order number in
  //    metadata/description, OR the exact amount + payer. The Neto/Stripe plugin
  //    writes the id into the charge description (e.g. "Charge for N27575 (...)").
  const idSet = new Set(ids.map((x) => x.toLowerCase()));
  // Word-boundary regex on the digits so "27575" doesn't match "127575".
  const digitRe = digits ? new RegExp(`(^|[^0-9])${digits}([^0-9]|$)`, "i") : null;
  const matches = (obj) => {
    if (!obj) return false;
    for (const v of Object.values(obj.metadata || {})) {
      if (idSet.has(String(v || "").toLowerCase())) return true;
    }
    const desc = String(obj.description || "");
    if (raw && desc.toLowerCase().includes(raw.toLowerCase())) return true;
    if (digitRe && digitRe.test(desc)) return true;
    // Exact amount + matching payer name/email.
    if (amountCents > 0 && Number(obj.amount) === amountCents && payerMatches(obj, hints)) return true;
    return false;
  };
  // Scan up to ~500 recent records per type (5 pages of 100), newest first.
  // Charges first: the Neto/Stripe plugin writes the order id into the charge
  // description, so the match is usually found on the very first page.
  for (const kind of ["charges", "payment_intents"]) {
    let after = "";
    for (let page = 0; page < 5; page++) {
      let data;
      try { data = await stripeGet(`/${kind}?limit=100${after ? `&starting_after=${after}` : ""}`); }
      catch { break; }
      const rows = data.data || [];
      const hit = rows.find(matches);
      if (hit) return kind === "payment_intents" ? shapePI(hit, "scan") : shapeCharge(hit, "scan");
      if (!data.has_more || !rows.length) break;
      after = rows[rows.length - 1].id;
    }
  }

  return null;
}

// Issue a partial refund. amountCents is the smallest currency unit (e.g. cents).
// idempotencyKey guards against accidental double-submits. Returns the refund.
export async function stripeRefund({ paymentIntentId, chargeId, amountCents, idempotencyKey, reason }) {
  const body = new URLSearchParams();
  if (paymentIntentId) body.set("payment_intent", paymentIntentId);
  else if (chargeId) body.set("charge", chargeId);
  else throw new Error("No Stripe payment_intent or charge to refund");
  body.set("amount", String(amountCents));
  if (reason) body.set("metadata[reason]", reason);
  const headers = stripeHeaders(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {});
  const res = await fetch(`${STRIPE_API}/refunds`, { method: "POST", headers, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status, message: data?.error?.message || `HTTP ${res.status}`, data };
  return { ok: data.status === "succeeded" || data.status === "pending", status: res.status, data };
}
