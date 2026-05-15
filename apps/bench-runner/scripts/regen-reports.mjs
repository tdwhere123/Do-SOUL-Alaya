#!/usr/bin/env node
// must run after: rtk pnpm --filter @do-soul/alaya-eval build
// @anchor regen-reports — one-shot rewrite of report.md for every history
// entry under docs/bench-history/{self,public}/. The bench harness
// already produced honest kpi.json artifacts; this script only re-renders
// the markdown so a scoring-contract section refresh (or any non-numeric
// renderReport change) can land without re-running the daemon. kpi.json
// content is NOT mutated.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KpiPayloadSchema,
  diffKpis,
  renderReport
} from "@do-soul/alaya-eval";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_ROOT = resolve(__dirname, "../../../docs/bench-history");

async function listEntryDirs(benchDir) {
  const names = await readdir(benchDir).catch(() => []);
  return names
    .filter((name) => /^\d{4}-\d{2}-\d{2}T\d{6}Z-[0-9a-f]+$/.test(name))
    .sort(); // lex sort = chronological
}

async function readKpi(kpiPath) {
  const raw = await readFile(kpiPath, "utf8");
  const parsed = JSON.parse(raw);
  return KpiPayloadSchema.parse(parsed);
}

async function regenForBench(benchName) {
  const benchDir = join(HISTORY_ROOT, benchName);
  const dirs = await listEntryDirs(benchDir);
  if (dirs.length === 0) {
    console.warn(`[regen-reports] no entries under ${benchDir}`);
    return;
  }

  let previousPayload = null;
  for (const slug of dirs) {
    const entryDir = join(benchDir, slug);
    const kpiPath = join(entryDir, "kpi.json");
    const reportPath = join(entryDir, "report.md");
    const current = await readKpi(kpiPath);
    const diff = diffKpis(current, previousPayload);
    const report = renderReport(current, previousPayload, diff);
    await writeFile(reportPath, report + "\n", "utf8");
    console.log(`[regen-reports] rewrote ${reportPath}`);
    previousPayload = current;
  }
}

await regenForBench("self");
await regenForBench("public");
