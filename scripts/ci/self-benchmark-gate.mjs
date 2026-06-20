#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");

const opts = parseArgs(process.argv.slice(2));
const historyRoot = path.resolve(repoRoot, opts.historyRoot ?? "docs/bench-history");
const benchName = opts.benchName ?? "self";
const split = opts.split ?? "synthetic";
const minRAt5 = Number(opts.minRAt5 ?? process.env.ALAYA_CI_SELF_BENCH_MIN_R_AT_5 ?? "0.95");
const maxDropPp = Number(opts.maxDropPp ?? process.env.ALAYA_CI_SELF_BENCH_MAX_R_AT_5_DROP_PP ?? "5");

if (!Number.isFinite(minRAt5) || minRAt5 < 0 || minRAt5 > 1) {
  fail(`invalid --min-r-at-5 ${String(opts.minRAt5)}`);
}
if (!Number.isFinite(maxDropPp) || maxDropPp < 0) {
  fail(`invalid --max-r-at-5-drop-pp ${String(opts.maxDropPp)}`);
}

const benchRoot = path.join(historyRoot, benchName);
const current = readLatestRun(benchRoot);
if (current.payload.bench_name !== benchName || current.payload.split !== split) {
  fail(
    `latest ${benchName} run is not the expected split`,
    `bench_name=${current.payload.bench_name} split=${current.payload.split}`
  );
}

const currentRAt5 = readRAt5(current.payload, "current");
if (currentRAt5 < minRAt5) {
  fail(
    `self benchmark R@5 ${formatPct(currentRAt5)} is below ${formatPct(minRAt5)}`,
    `current=${current.path}`
  );
}

const previous = readPreviousComparable(benchRoot, current.slug, split);
if (previous === null) {
  console.log(
    `[self-benchmark-gate] OK: R@5=${formatPct(currentRAt5)}; no previous ${benchName}/${split} baseline found`
  );
  process.exit(0);
}

const previousRAt5 = readRAt5(previous.payload, "previous");
const dropPp = (previousRAt5 - currentRAt5) * 100;
if (dropPp > maxDropPp) {
  fail(
    `self benchmark R@5 dropped ${dropPp.toFixed(2)}pp, threshold ${maxDropPp.toFixed(2)}pp`,
    `current=${current.path}\nprevious=${previous.path}`
  );
}

console.log(
  `[self-benchmark-gate] OK: R@5=${formatPct(currentRAt5)} previous=${formatPct(previousRAt5)} delta=${(-dropPp).toFixed(2)}pp`
);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--history-root") parsed.historyRoot = readValue(argv, ++index, token);
    else if (token.startsWith("--history-root=")) parsed.historyRoot = token.slice("--history-root=".length);
    else if (token === "--bench-name") parsed.benchName = readValue(argv, ++index, token);
    else if (token.startsWith("--bench-name=")) parsed.benchName = token.slice("--bench-name=".length);
    else if (token === "--split") parsed.split = readValue(argv, ++index, token);
    else if (token.startsWith("--split=")) parsed.split = token.slice("--split=".length);
    else if (token === "--min-r-at-5") parsed.minRAt5 = readValue(argv, ++index, token);
    else if (token.startsWith("--min-r-at-5=")) parsed.minRAt5 = token.slice("--min-r-at-5=".length);
    else if (token === "--max-r-at-5-drop-pp") parsed.maxDropPp = readValue(argv, ++index, token);
    else if (token.startsWith("--max-r-at-5-drop-pp=")) parsed.maxDropPp = token.slice("--max-r-at-5-drop-pp=".length);
    else fail(`unknown argument: ${token}`);
  }
  return parsed;
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    fail(`${flag} requires a value`);
  }
  return value;
}

function readLatestRun(benchRootPath) {
  const pointerPath = path.join(benchRootPath, "latest-run.json");
  if (!existsSync(pointerPath)) {
    fail(`missing latest-run pointer for ${benchName}`, pointerPath);
  }
  const pointer = readJson(pointerPath);
  if (typeof pointer.slug !== "string" || pointer.slug.length === 0) {
    fail("latest-run pointer has no slug", pointerPath);
  }
  const kpiPath = typeof pointer.kpi_path === "string" && pointer.kpi_path.length > 0
    ? path.resolve(benchRootPath, pointer.kpi_path)
    : path.join(benchRootPath, pointer.slug, "kpi.json");
  return { slug: pointer.slug, path: kpiPath, payload: readJson(kpiPath) };
}

function readPreviousComparable(benchRootPath, currentSlug, expectedSplit) {
  if (!existsSync(benchRootPath)) {
    return null;
  }
  const slugs = readdirSync(benchRootPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^\d{4}-\d{2}-\d{2}T\d{6}Z-/.test(name))
    .sort()
    .reverse();

  for (const slug of slugs) {
    if (slug === currentSlug) {
      continue;
    }
    const kpiPath = path.join(benchRootPath, slug, "kpi.json");
    if (!existsSync(kpiPath)) {
      continue;
    }
    const payload = readJson(kpiPath);
    if (payload.bench_name === benchName && payload.split === expectedSplit) {
      return { slug, path: kpiPath, payload };
    }
  }
  return null;
}

function readRAt5(payload, label) {
  const value = payload?.kpi?.r_at_5;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${label} kpi.r_at_5 is invalid`, JSON.stringify(value));
  }
  return value;
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`failed to read JSON: ${filePath}`, error instanceof Error ? error.message : String(error));
  }
}

function formatPct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function fail(message, detail) {
  console.error(`[self-benchmark-gate] FAIL: ${message}`);
  if (detail !== undefined && detail !== "") {
    console.error(detail);
  }
  process.exit(1);
}
