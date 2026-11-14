#!/usr/bin/env node
// must run after: pnpm build
// Usage: node apps/bench-runner/scripts/regen-reports.mjs [history-root]
// @anchor regen-reports — one-shot rewrite of report.md for every history
// entry under the local history root's {self,public}/. The bench harness
// already produced honest kpi.json artifacts; this script only re-renders
// the markdown so a scoring-contract section refresh (or any non-numeric
// renderReport change) can land without re-running the daemon. kpi.json
// content is NOT mutated.

import { readFile, writeFile } from "node:fs/promises";
import { AlayaError } from "@do-soul/alaya-protocol";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KpiPayloadSchema,
  listEntries,
  diffKpis,
  renderReport,
  resolveDefaultBenchHistoryRoot
} from "@do-soul/alaya-eval";

import { matchesHistoryQuery } from "../../../packages/eval/dist/history/history.js";
import { isRecallEvalArchive, sameRecallEvalBaselineIdentity } from
  "../dist/runs/lifecycle/recall-eval/recall-eval-archive-impl.js";
import { renderRecallEvalReport } from "../dist/runs/kpi/recall-eval-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
if (process.argv.length > 3) throw new AlayaError("VALIDATION", "usage: regen-reports.mjs [history-root]");
const HISTORY_ROOT = process.argv[2] === undefined
  ? resolveDefaultBenchHistoryRoot(resolve(__dirname, "../../..")) : resolve(process.argv[2]);

function sameReportCohort(previous, current) {
  if (isRecallEvalArchive(current)) {
    return isRecallEvalArchive(previous) && sameRecallEvalBaselineIdentity(previous, current);
  }
  return !isRecallEvalArchive(previous) && matchesHistoryQuery(previous, {
    split: current.split, policyShape: current.policy_shape ?? "stress",
    simulateReport: current.simulate_report ?? "none", embeddingProvider: current.embedding_provider
  });
}

async function readKpi(kpiPath) {
  const raw = await readFile(kpiPath, "utf8");
  const parsed = JSON.parse(raw);
  return KpiPayloadSchema.parse(parsed);
}

async function regenForBench(benchName) {
  const benchDir = join(HISTORY_ROOT, benchName);
  const dirs = await listEntries({ historyRoot: HISTORY_ROOT }, benchName);
  if (dirs.length === 0) {
    console.warn(`[regen-reports] no entries under ${benchDir}`);
    return;
  }

  const prior = [];
  for (const slug of dirs) {
    const entryDir = join(benchDir, slug);
    const kpiPath = join(entryDir, "kpi.json");
    const reportPath = join(entryDir, "report.md");
    const current = await readKpi(kpiPath);
    const previousPayload = prior.findLast(payload => sameReportCohort(payload, current)) ?? null;
    const diff = diffKpis(current, previousPayload);
    const render = isRecallEvalArchive(current) ? renderRecallEvalReport : renderReport;
    const report = render(current, previousPayload, diff);
    await writeFile(reportPath, report + "\n", "utf8");
    console.log(`[regen-reports] rewrote ${reportPath}`);
    prior.push(current);
  }
}

await regenForBench("self");
await regenForBench("public");
