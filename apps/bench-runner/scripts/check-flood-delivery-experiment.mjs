#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const REQUIRED_EMBEDDING_MODE = "env";

function usage() {
  return [
    "Usage:",
    `  node ${basename(process.argv[1])} [--diagnostics <longmemeval-diagnostics.json>] [--embedding env|disabled]`,
    "",
    "Checks the safe Card E flood-supply experiment preconditions:",
    "answers_with/flood is always on; benchmark --embedding env is required.",
    "When diagnostics are provided, reports flood_fuel_coverage blocks if present."
  ].join("\n");
}

function parseArgs(argv) {
  const args = { diagnostics: null, embedding: null };
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--diagnostics") {
      args.diagnostics = argv[++index] ?? null;
      continue;
    }
    if (arg.startsWith("--diagnostics=")) {
      args.diagnostics = arg.slice("--diagnostics=".length);
      continue;
    }
    if (arg === "--embedding") {
      args.embedding = argv[++index] ?? null;
      continue;
    }
    if (arg.startsWith("--embedding=")) {
      args.embedding = arg.slice("--embedding=".length);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function collectFuelCoverage(value, rows = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectFuelCoverage(item, rows);
    return rows;
  }
  if (!isObject(value)) return rows;
  if (isObject(value.flood_fuel_coverage)) {
    rows.push(value.flood_fuel_coverage);
  }
  for (const child of Object.values(value)) collectFuelCoverage(child, rows);
  return rows;
}

function summarizeFuelCoverage(rows) {
  if (rows.length === 0) {
    return {
      available: false,
      blocks: 0,
      candidates_total: null,
      fuel_verified_count: null,
      fuel_verified_rate: null,
      path_active_count: null,
      evidence_active_count: null,
      slice_active_count: null,
      cold_start_count: null
    };
  }
  const totals = {
    candidates_total: 0,
    fuel_verified_count: 0,
    path_active_count: 0,
    evidence_active_count: 0,
    slice_active_count: 0,
    cold_start_count: 0
  };
  for (const row of rows) {
    totals.candidates_total += numberOrZero(row.candidates_total);
    totals.fuel_verified_count += numberOrZero(row.fuel_verified_count);
    totals.path_active_count += numberOrZero(row.path_active_count);
    totals.evidence_active_count += numberOrZero(row.evidence_active_count);
    totals.slice_active_count += numberOrZero(row.slice_active_count);
    totals.cold_start_count += numberOrZero(row.cold_start_count);
  }
  return {
    available: true,
    blocks: rows.length,
    ...totals,
    fuel_verified_rate:
      totals.candidates_total === 0
        ? null
        : totals.fuel_verified_count / totals.candidates_total
  };
}

async function readSidecar(path) {
  if (path === null) return null;
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const args = parseArgs(process.argv);
  const sidecar = await readSidecar(args.diagnostics);
  const sidecarEmbeddingMode =
    typeof sidecar?.embedding_mode === "string" ? sidecar.embedding_mode : null;
  const requestedEmbeddingMode = args.embedding ?? null;
  const effectiveEmbeddingMode = sidecarEmbeddingMode ?? requestedEmbeddingMode;
  // Flood/answers_with is hard-enabled in runtime; env is informational only.
  const answersWith = process.env.ALAYA_RECALL_ANSWERS_WITH ?? "always-on";
  const embeddingOk =
    sidecar === null
      ? effectiveEmbeddingMode === REQUIRED_EMBEDDING_MODE
      : sidecarEmbeddingMode === REQUIRED_EMBEDDING_MODE;
  const fuelCoverageRows = sidecar === null ? [] : collectFuelCoverage(sidecar);
  const fuelCoverage = summarizeFuelCoverage(fuelCoverageRows);
  const fuelVerifiedOk =
    sidecar === null
      ? null
      : fuelCoverage.fuel_verified_count !== null && fuelCoverage.fuel_verified_count > 0;
  const report = {
    schema_version: "flood-delivery-experiment-check.v1",
    ok: embeddingOk && (fuelVerifiedOk ?? true),
    required: {
      answers_with: "always-on",
      embedding_mode: REQUIRED_EMBEDDING_MODE
    },
    observed: {
      ALAYA_RECALL_ANSWERS_WITH: answersWith,
      embedding_mode: effectiveEmbeddingMode,
      requested_embedding_mode: requestedEmbeddingMode,
      sidecar_embedding_mode: sidecarEmbeddingMode,
      diagnostics_path: args.diagnostics
    },
    checks: {
      answers_with_env_ok: true,
      embedding_env_ok: embeddingOk,
      fuel_verified_ok: fuelVerifiedOk
    },
    command_hint:
      "rtk pnpm exec alaya-bench-runner longmemeval --embedding env ...",
    fuel_coverage: fuelCoverage,
    diagnostics_note:
      fuelCoverageRows.length === 0
        ? "No flood_fuel_coverage blocks were present; this script does not infer fuel coverage from other fields."
        : "Aggregated explicit flood_fuel_coverage blocks from diagnostics."
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exit(1);
});
