#!/usr/bin/env node
// Compute cohort attribution from a longmemeval-diagnostics.json
// archive. Reads delivered_results[].plane_winning_admission and
// reports per-plane hit count + share + the gold-membership filter.
// Usage: node scripts/compute-cohort-from-archive.mjs <path-to-diagnostics.json>
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error("usage: compute-cohort-from-archive.mjs <diagnostics.json>");
  process.exit(2);
}

const diag = JSON.parse(readFileSync(argv[0], "utf8"));
const questions = diag.questions ?? [];

const planeHits = new Map();
let totalDelivered = 0;
let goldHits = 0;
let goldHitsByPlane = new Map();

for (const q of questions) {
  const goldSet = new Set(q.gold_memory_ids ?? []);
  for (const dr of q.delivered_results ?? []) {
    totalDelivered += 1;
    const plane = dr.plane_winning_admission ?? null;
    const key = plane === null ? "null" : plane;
    planeHits.set(key, (planeHits.get(key) ?? 0) + 1);
    if (goldSet.has(dr.object_id)) {
      goldHits += 1;
      goldHitsByPlane.set(key, (goldHitsByPlane.get(key) ?? 0) + 1);
    }
  }
}

const rows = [...planeHits.entries()]
  .map(([plane, hits]) => ({
    plane,
    delivered_hits: hits,
    delivered_share: hits / totalDelivered,
    gold_hits: goldHitsByPlane.get(plane) ?? 0,
    gold_share: (goldHitsByPlane.get(plane) ?? 0) / Math.max(goldHits, 1)
  }))
  .sort((a, b) => b.delivered_hits - a.delivered_hits);

console.log("Total delivered:", totalDelivered);
console.log("Total gold hits:", goldHits);
console.log();
console.log("Per-plane attribution:");
console.log("plane                       delivered          gold");
console.log("-".repeat(60));
for (const row of rows) {
  const planeStr = row.plane.padEnd(28);
  const delStr = `${row.delivered_hits} (${(row.delivered_share * 100).toFixed(1)}%)`.padEnd(18);
  const goldStr = `${row.gold_hits} (${(row.gold_share * 100).toFixed(1)}%)`;
  console.log(`${planeStr}${delStr}${goldStr}`);
}

const domination = rows.find((r) => r.gold_share > 0.5);
if (domination !== undefined && domination.plane !== "null") {
  console.log();
  console.log(`COHORT DOMINATION FLAG: plane "${domination.plane}" > 50% of gold hits.`);
}
