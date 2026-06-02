// Local dev server for the review page + API functions. No Netlify CLI needed.
// Run:  node --env-file=.env local_server.mjs
// Then open http://localhost:8910
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

import ordersFn from "./netlify/functions/orders.mjs";
import saveFn from "./netlify/functions/save-mapping.mjs";
import pushFn from "./netlify/functions/push-order.mjs";
import settingsFn from "./netlify/functions/settings.mjs";

const ROUTES = {
  "/api/orders": ordersFn,
  "/api/save-mapping": saveFn,
  "/api/push-order": pushFn,
  "/api/settings": settingsFn,
};
const PORT = 8910;

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFile(new URL("./public/index.html", import.meta.url));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    const fn = ROUTES[url.pathname];
    if (!fn) { res.writeHead(404); res.end("Not found"); return; }

    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const hasBody = chunks.length && req.method !== "GET" && req.method !== "HEAD";
    const webReq = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    });

    const webRes = await fn(webReq, {});
    const text = await webRes.text();
    res.writeHead(webRes.status, { "Content-Type": webRes.headers.get("content-type") || "application/json" });
    res.end(text);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, () => console.log(`\nReview page running:  http://localhost:${PORT}\n(Ctrl+C to stop)`));
