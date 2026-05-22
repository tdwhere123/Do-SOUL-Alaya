#!/usr/bin/env node
// Compute cohort attribution from a longmemeval-diagnostics.json
// archive. Reads delivered_results[] plane fields when present; old
// archives fall back to gold[] plane fields for gold-hit attribution.
// Usage: node scripts/compute-cohort-from-archive.mjs <path-to-diagnostics.json>
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error("usage: compute-cohort-from-archive.mjs <diagnostics.json>");
  process.exit(2);
}

const diag = JSON.parse(readFileSync(argv[0], "utf8"));
const questions = diag.questions ?? [];

let totalDelivered = 0;
let goldHits = 0;
const firstAdmitted = createPlaneCounters();
const winningAdmission = createPlaneCounters();

for (const q of questions) {
  const goldSet = new Set(q.gold_memory_ids ?? []);
  const goldByObjectId = new Map(
    (q.gold ?? [])
      .filter((gold) => typeof gold?.object_id === "string")
      .map((gold) => [gold.object_id, gold])
  );
  for (const dr of q.delivered_results ?? []) {
    totalDelivered += 1;
    const gold = goldByObjectId.get(dr.object_id);
    const isGoldHit = goldSet.has(dr.object_id);
    if (isGoldHit) {
      goldHits += 1;
    }
    countPlane(
      firstAdmitted,
      readPlane(dr, gold, "plane_first_admitted"),
      isGoldHit
    );
    countPlane(
      winningAdmission,
      readPlane(dr, gold, "plane_winning_admission"),
      isGoldHit
    );
  }
}

console.log("Total delivered:", totalDelivered);
console.log("Total gold hits:", goldHits);
console.log();
printTable("plane_first_admitted", buildRows(firstAdmitted));
console.log();
printTable("plane_winning_admission", buildRows(winningAdmission));

function createPlaneCounters() {
  return {
    delivered: new Map(),
    gold: new Map()
  };
}

function countPlane(counters, plane, isGoldHit) {
  const key = plane === null ? "null" : plane;
  counters.delivered.set(key, (counters.delivered.get(key) ?? 0) + 1);
  if (isGoldHit) {
    counters.gold.set(key, (counters.gold.get(key) ?? 0) + 1);
  }
}

function readPlane(deliveredResult, goldDiagnostic, field) {
  return (
    normalizePlane(deliveredResult?.[field]) ??
    normalizePlane(goldDiagnostic?.[field])
  );
}

function normalizePlane(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function buildRows(counters) {
  return [...counters.delivered.entries()]
    .map(([plane, hits]) => ({
      plane,
      delivered_hits: hits,
      delivered_share: share(hits, totalDelivered),
      gold_hits: counters.gold.get(plane) ?? 0,
      gold_share: share(counters.gold.get(plane) ?? 0, goldHits)
    }))
    .sort((a, b) => b.delivered_hits - a.delivered_hits);
}

function share(count, total) {
  return total === 0 ? 0 : count / total;
}

function printTable(label, rows) {
  console.log(`Per-plane attribution by ${label}:`);
  console.log("plane                       delivered          gold");
  console.log("-".repeat(60));
  for (const row of rows) {
    const planeStr = row.plane.padEnd(28);
    const delStr = `${row.delivered_hits} (${(row.delivered_share * 100).toFixed(1)}%)`.padEnd(
      18
    );
    const goldStr = `${row.gold_hits} (${(row.gold_share * 100).toFixed(1)}%)`;
    console.log(`${planeStr}${delStr}${goldStr}`);
  }

  const domination = rows.find((r) => r.gold_share > 0.5);
  if (domination !== undefined && domination.plane !== "null") {
    console.log();
    console.log(
      `COHORT DOMINATION FLAG (${label}): plane "${domination.plane}" > 50% of gold hits.`
    );
  }
}
