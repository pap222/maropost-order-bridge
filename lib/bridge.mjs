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

export async function syncedSet(orderIds) {
  if (!orderIds.length) return new Set();
  const list = orderIds.map((id) => `"${id}"`).join(",");
  // Only REAL pushes block a re-push. Test-mode pushes are recorded (status
  // "test") but ignored here, so an order you tried in test can still be sent
  // for real. A subsequent real push upserts the row to status "created".
  const rows = (await supa(`synced_orders?maropost_order_id=in.(${list})&qb2b_status=neq.test&select=maropost_order_id`)) || [];
  return new Set(rows.map((r) => r.maropost_order_id));
}

export async function markSynced(orderId, status, payload) {
  await supa("synced_orders", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      maropost_order_id: String(orderId),
      qb2b_status: status,
      synced_at: new Date().toISOString(),
      payload,
    }),
  });
}

// --- Maropost / Neto -------------------------------------------------------
const ORDER_OUTPUT = [
  "OrderID", "Email", "Username", "SalesChannel",
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

export async function fetchWebsiteOrders(extraFilter = {}) {
  const c = cfg();
  const res = await fetch(c.netoUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Accept: "application/json",
      NETOAPI_ACTION: "GetOrder", NETOAPI_KEY: c.netoKey,
    },
    body: JSON.stringify({
      Filter: {
        OrderStatus: ["Pick", "Pack", "Pending Dispatch"],
        OutputSelector: ORDER_OUTPUT,
        Page: 0, Limit: 50,
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
  const filtered = orders.filter((o) => o.SalesChannel === "Website" && isPaid(o));
  return enrichOrders(filtered);
}

export async function fetchOneOrder(orderId) {
  const orders = await fetchWebsiteOrders({ OrderID: [String(orderId)] });
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
export function reviewOrder(order, itemMap) {
  const lines = Array.isArray(order.OrderLine) ? order.OrderLine : order.OrderLine ? [order.OrderLine] : [];
  const reviewed = lines.map((l) => {
    const sku = String(l.SKU || "");
    const orderedQty = Number(l.Quantity || 1);
    const unitPrice = Number(l.UnitPrice || 0);
    const entry = itemMap.get(sku);
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
    };
  });
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
  // and the customer name on both. (Wanted date rides on delivery_date.)
  let comment;
  if (isPickup) {
    comment = `PICK UP | ${ci.name}`;
  } else {
    comment = "DELIVERY";
    if (ci.address) comment += ` | ${ci.address}`;
    comment += ` | ${ci.name}`;
  }
  // Safety flag: any line we couldn't map must be packed by hand - keep this even
  // in the lean comment so items are never silently dropped.
  if (unmapped.length) comment += ` | *** NOT IN QUICKB2B - PACK MANUALLY: ${unmapped.join("; ")} ***`;
  // Put the customer's wanted date on QuickB2B's own delivery-date field (not just
  // in the comment) so it drives QuickB2B's scheduling. Formatted YYYY-MM-DD in
  // Wagga time so it never lands a day early.
  const payload = { customer_code: cfg().webCustomer, comment, OrderDetail };
  const deliveryDate = reqDateISO(order.DateRequired);
  if (deliveryDate) payload.delivery_date = deliveryDate;
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
