import fs from "node:fs";
import { config } from "./config.mjs";

const STOP = new Set(["the","a","an","of","to","in","on","at","by","for","vs","v","and","or","will","be","win","winner","match","odds","market","yes","no","before","after","2024","2025","2026","2027"]);
const ALIASES = [
  [/\bman utd\b|\bmanchester united\b/g, "manutd"], [/\bman city\b|\bmanchester city\b/g, "mancity"],
  [/\bspurs\b|\btottenham hotspur\b/g, "tottenham"], [/\bpsg\b|\bparis saint[- ]germain\b/g, "psg"],
  [/\bus\b|\busa\b|\bunited states\b/g, "usa"], [/\buk\b|\bunited kingdom\b/g, "uk"],
  [/\bpresidential election\b/g, "president"], [/\bgeneral election\b/g, "election"],
];

export function normalize(s) {
  let t = (s ?? "").toLowerCase().replace(/[’']/g, "");
  for (const [re, rep] of ALIASES) t = t.replace(re, rep);
  return t.replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
}

export function tokenSet(s) { return new Set(normalize(s)); }

/** Jaccard-ish similarity biased toward the shorter string being contained in the longer. */
export function similarity(a, b) {
  const A = tokenSet(a), Bs = tokenSet(b);
  if (!A.size || !Bs.size) return 0;
  let inter = 0;
  for (const w of A) if (Bs.has(w)) inter++;
  const jaccard = inter / (A.size + Bs.size - inter);
  const containment = inter / Math.min(A.size, Bs.size);
  return 0.5 * jaccard + 0.5 * containment;
}

const daysApart = (a, b) => (a && b ? Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000 : 0);

/**
 * Pair Polymarket outcomes with Betfair runners.
 * Returns [{ pm, pmOutcome, bf, bfRunner, score, source: "manual"|"auto" }]
 */
export function matchMarkets(pmMarkets, bfMarkets, threshold = config.matchThreshold) {
  const pairs = [];
  const pmBySlug = new Map(pmMarkets.map((m) => [m.slug, m]));
  const bfById = new Map(bfMarkets.map((m) => [m.id, m]));

  // 1. Manual mappings (trusted).
  for (const map of loadMappings()) {
    const pm = pmBySlug.get(map.polymarketSlug), bf = bfById.get(map.betfairMarketId);
    if (!pm || !bf) continue;
    const pmOutcome = pm.outcomes.find((o) => o.name.toLowerCase() === String(map.polymarketOutcome).toLowerCase());
    const bfRunner = bf.outcomes.find((o) => o.selectionId === Number(map.betfairSelectionId));
    if (pmOutcome && bfRunner) pairs.push({ pm, pmOutcome, bf, bfRunner, score: 1, source: "manual" });
  }
  const seen = new Set(pairs.map((p) => `${p.pm.id}:${p.pmOutcome.tokenId}`));

  // 2. Fuzzy: event title similarity, then outcome name similarity (or binary Yes vs runner).
  for (const pm of pmMarkets) {
    let best = null;
    for (const bf of bfMarkets) {
      if (daysApart(pm.endDate, bf.endDate) > 45) continue;
      const s = Math.max(similarity(pm.question, bf.question), similarity(pm.eventTitle, bf.eventTitle));
      if (s >= threshold && (!best || s > best.score)) best = { bf, score: s };
    }
    if (!best) continue;
    const isBinary = pm.outcomes.length === 2 && pm.outcomes.some((o) => /^yes$/i.test(o.name));
    for (const pmOutcome of pm.outcomes) {
      if (seen.has(`${pm.id}:${pmOutcome.tokenId}`)) continue;
      let bfRunner = null, rs = 0;
      if (isBinary) {
        if (!/^yes$/i.test(pmOutcome.name)) continue; // only pair the YES leg; NO is implied
        // The Polymarket question names the subject ("Will X win ..."); find that runner.
        for (const r of best.bf.outcomes) { const s = similarity(pm.question, r.name); if (s > rs) { rs = s; bfRunner = r; } }
        if (rs < 0.34) continue;
      } else {
        for (const r of best.bf.outcomes) { const s = similarity(pmOutcome.name, r.name); if (s > rs) { rs = s; bfRunner = r; } }
        if (rs < 0.5) continue;
      }
      pairs.push({ pm, pmOutcome, bf: best.bf, bfRunner, score: Math.min(best.score, 0.5 + rs / 2), source: "auto" });
    }
  }
  return pairs;
}

export function loadMappings() {
  try {
    return JSON.parse(fs.readFileSync(config.mappingsFile, "utf8")).filter((m) => m.polymarketSlug && !/^example-/.test(m.polymarketSlug));
  } catch { return []; }
}
