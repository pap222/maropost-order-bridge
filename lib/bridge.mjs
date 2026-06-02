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
  const rows = (await supa(`synced_orders?maropost_order_id=in.(${list})&select=maropost_order_id`)) || [];
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
  "OrderID", "Email", "SalesChannel",
  "BillFirstName", "BillLastName", "ShipFirstName", "ShipLastName",
  "ShipStreetLine1", "ShipStreetLine2", "ShipCity", "ShipState", "ShipPostCode",
  "ShipPhone", "BillPhone", "DatePlaced", "GrandTotal", "OrderPayment", "OrderLine",
];

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
  return orders.filter((o) => o.SalesChannel === "Website" && isPaid(o));
}

export async function fetchOneOrder(orderId) {
  const orders = await fetchWebsiteOrders({ OrderID: [String(orderId)] });
  return orders[0] || null;
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
    const entry = itemMap.get(sku);
    return {
      sku,
      product_name: l.ProductName || "",
      ordered_qty: orderedQty,
      mapped: !!entry,
      qb_code: entry ? entry.code : "",
      factor: entry ? entry.factor : 1,
      out_qty: entry ? Number((orderedQty * entry.factor).toFixed(3)) : null,
    };
  });
  return {
    order_id: String(order.OrderID),
    customer: customerInfo(order),
    lines: reviewed,
    unmapped_count: reviewed.filter((l) => !l.mapped).length,
  };
}

function customerInfo(order) {
  const name = [order.ShipFirstName || order.BillFirstName, order.ShipLastName || order.BillLastName]
    .filter(Boolean).join(" ") || "Web customer";
  const address = [order.ShipStreetLine1, order.ShipStreetLine2, order.ShipCity, order.ShipState, order.ShipPostCode]
    .filter(Boolean).join(", ");
  const phone = order.ShipPhone || order.BillPhone || "";
  return { name, phone, address, email: order.Email || "" };
}

// Build the QuickB2B payload. Unmapped lines are skipped and flagged in the
// comment (never sent as a raw SKU). Returns { payload, unmapped }.
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
    OrderDetail.push({ item_code: entry.code, quantity: Number((orderedQty * entry.factor).toFixed(3)) });
  }
  const ci = customerInfo(order);
  let comment = `WEB ORDER #${order.OrderID} | ${ci.name}`;
  if (ci.phone) comment += ` | ${ci.phone}`;
  if (ci.address) comment += ` | ${ci.address}`;
  if (unmapped.length) comment += ` | *** NOT IN QUICKB2B - PACK MANUALLY: ${unmapped.join("; ")} ***`;
  return { payload: { customer_code: cfg().webCustomer, comment, OrderDetail }, unmapped };
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
