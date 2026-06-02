// Local runner: invokes the bridge handler exactly like Netlify would,
// but on your machine. Env comes from `.env` via `node --env-file=.env`.
//
//   cd "C:\Users\User\Downloads\New folder"
//   node --env-file=.env run_test.mjs
//
import handler from "./netlify/functions/maropost-to-quickb2b.js";

const res = await handler();
const text = await res.text();

console.log("\n================ RESULT ================");
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}
console.log("========================================\n");
