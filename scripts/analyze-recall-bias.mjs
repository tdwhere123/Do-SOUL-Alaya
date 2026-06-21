#!/usr/bin/env node
// Aggregate gold[] sub-records across all questions in a
// longmemeval-diagnostics.json archive. Reports rank distributions,
// candidate_status splits, plane_winning_admission, and the
// lexical_rank -> final_rank drift that tells us whether the FTS
// plane is finding gold but a downstream scoring step is demoting it.
//
// Usage: node scripts/analyze-recall-bias.mjs <diagnostics.json>
//
// see also: docs/archive/v0.3-historical/v0.3.9/reports/v0.3.9-bench-diff.md (dimension
// sensitivity finding); scripts/compute-cohort-from-archive.mjs.

import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error("usage: analyze-recall-bias.mjs <diagnostics.json>");
  process.exit(2);
}

const diag = JSON.parse(readFileSync(argv[0], "utf8"));
const questions = diag.questions ?? [];

const allGold = [];
for (const q of questions) {
  for (const g of q.gold ?? []) {
    allGold.push({ ...g, question_id: q.question_id });
  }
}

const totalGold = allGold.length;
const delivered = allGold.filter((g) => g.candidate_status === "delivered");
const notDelivered = allGold.filter((g) => g.candidate_status !== "delivered");

console.log("# Gold[] aggregate analysis");
console.log(`Source: ${argv[0]}`);
console.log(`Questions: ${questions.length}`);
console.log(`Total gold entries: ${totalGold}`);
console.log(`  delivered: ${delivered.length} (${pct(delivered.length, totalGold)})`);
console.log(`  not delivered: ${notDelivered.length} (${pct(notDelivered.length, totalGold)})`);

// candidate_status breakdown
const statusCounts = bucketBy(allGold, (g) => g.candidate_status ?? "null");
console.log("\n## candidate_status");
for (const [status, count] of sortDesc(statusCounts)) {
  console.log(`  ${status.padEnd(35)} ${count} (${pct(count, totalGold)})`);
}

// final_rank distribution for delivered gold
console.log("\n## final_rank bucket (delivered gold only)");
const finalRankBuckets = ["1", "2-5", "6-10", "11-20", "21-50", "51-100", "100+"];
const finalRankCounts = new Map(finalRankBuckets.map((b) => [b, 0]));
for (const g of delivered) {
  const r = g.final_rank ?? null;
  if (r === null) continue;
  const bucket = r <= 1 ? "1" : r <= 5 ? "2-5" : r <= 10 ? "6-10" : r <= 20 ? "11-20" : r <= 50 ? "21-50" : r <= 100 ? "51-100" : "100+";
  finalRankCounts.set(bucket, (finalRankCounts.get(bucket) ?? 0) + 1);
}
for (const bucket of finalRankBuckets) {
  const c = finalRankCounts.get(bucket) ?? 0;
  console.log(`  rank ${bucket.padEnd(8)} ${c} (${pct(c, delivered.length)} of delivered)`);
}

// pre_budget_rank distribution for all gold
console.log("\n## pre_budget_rank bucket (all gold)");
const preBuckets = ["1", "2-5", "6-10", "11-20", "21-50", "51-100", "101-200", "200+"];
const preCounts = new Map(preBuckets.map((b) => [b, 0]));
let preNull = 0;
for (const g of allGold) {
  const r = g.pre_budget_rank ?? null;
  if (r === null) {
    preNull += 1;
    continue;
  }
  const bucket =
    r <= 1 ? "1" :
    r <= 5 ? "2-5" :
    r <= 10 ? "6-10" :
    r <= 20 ? "11-20" :
    r <= 50 ? "21-50" :
    r <= 100 ? "51-100" :
    r <= 200 ? "101-200" : "200+";
  preCounts.set(bucket, (preCounts.get(bucket) ?? 0) + 1);
}
for (const bucket of preBuckets) {
  const c = preCounts.get(bucket) ?? 0;
  console.log(`  rank ${bucket.padEnd(8)} ${c} (${pct(c, totalGold)})`);
}
console.log(`  null      ${preNull} (${pct(preNull, totalGold)})`);

// plane_winning_admission distribution for delivered gold
console.log("\n## plane_winning_admission (delivered gold)");
const planeCounts = bucketBy(delivered, (g) => g.plane_winning_admission ?? "null");
for (const [plane, count] of sortDesc(planeCounts)) {
  console.log(`  ${plane.padEnd(28)} ${count} (${pct(count, delivered.length)})`);
}

// lexical_rank -> final_rank drift
console.log("\n## lexical_rank -> final_rank drift (delivered gold with both fields)");
const drifts = [];
for (const g of delivered) {
  if (typeof g.lexical_rank !== "number" || typeof g.final_rank !== "number") continue;
  // lexical_rank is 0..1 (similarity, 1=best). final_rank is 1..K (position, 1=best).
  // To compare, convert lexical_rank to a position: best lexical -> position 1, worst -> position K.
  // We just collect (lexical_rank, final_rank) pairs.
  drifts.push({ lexical_rank: g.lexical_rank, final_rank: g.final_rank });
}
const lexicalTopButFinalLow = drifts.filter((d) => d.lexical_rank > 0.8 && d.final_rank > 5);
const lexicalTopAndFinalTop = drifts.filter((d) => d.lexical_rank > 0.8 && d.final_rank <= 5);
console.log(`  gold with lexical_rank > 0.8 and final_rank <= 5: ${lexicalTopAndFinalTop.length}`);
console.log(`  gold with lexical_rank > 0.8 and final_rank  > 5: ${lexicalTopButFinalLow.length}`);
if (lexicalTopButFinalLow.length > 0) {
  console.log(`  -> gold FTS-found but recall scoring demotes past top-5:`);
  for (const d of lexicalTopButFinalLow.slice(0, 10)) {
    console.log(`     lexical_rank=${d.lexical_rank.toFixed(3)} final_rank=${d.final_rank}`);
  }
  if (lexicalTopButFinalLow.length > 10) console.log(`     ... +${lexicalTopButFinalLow.length - 10} more`);
}

// structural_score distribution
console.log("\n## structural_score distribution (delivered gold)");
const struct = delivered.map((g) => g.structural_score).filter((v) => typeof v === "number");
if (struct.length > 0) {
  struct.sort((a, b) => a - b);
  const min = struct[0];
  const max = struct[struct.length - 1];
  const median = struct[Math.floor(struct.length / 2)];
  const mean = struct.reduce((s, v) => s + v, 0) / struct.length;
  console.log(`  count=${struct.length} min=${min.toFixed(3)} median=${median.toFixed(3)} mean=${mean.toFixed(3)} max=${max.toFixed(3)}`);
}

// budget_drop_reason distribution
console.log("\n## budget_drop_reason (not-delivered gold)");
const dropReasons = bucketBy(notDelivered, (g) => g.budget_drop_reason ?? "null");
for (const [reason, count] of sortDesc(dropReasons)) {
  console.log(`  ${reason.padEnd(40)} ${count} (${pct(count, notDelivered.length)})`);
}

function pct(num, denom) {
  if (denom === 0) return "0%";
  return `${((num / denom) * 100).toFixed(1)}%`;
}

function bucketBy(arr, keyFn) {
  const m = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function sortDesc(m) {
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
