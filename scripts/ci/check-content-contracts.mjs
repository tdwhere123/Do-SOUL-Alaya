#!/usr/bin/env node
import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_HISTORY_ROOT = path.resolve(process.cwd(), "docs/bench-history");
const BENCH_ROOTS = new Set([
  "self",
  "public",
  "public-multiturn",
  "public-crossquestion",
  "public-locomo",
  "live"
]);
const TIER1_ROOTS = new Set([
  "public",
  "public-multiturn",
  "public-crossquestion",
  "public-locomo"
]);
const LONGMEMEVAL_ROOTS = new Set(["public", "public-multiturn", "public-crossquestion"]);
const COMPACT_DIAGNOSTIC_FILENAMES = new Set([
  "longmemeval-diagnostics.json",
  "locomo-diagnostics.json"
]);
const POINTER_PATTERN = /^latest-(run|passing)(?:-[a-z0-9-]+)?\.json$/;
const COMPACT_DIAGNOSTIC_MAX_BYTES = 30 * 1024;

const args = parseArgs(process.argv.slice(2));
const errors = [];

try {
  await checkBenchHistory(args.historyRoot);
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
}

if (errors.length > 0) {
  for (const error of errors) {
    process.stderr.write(`content-contract: ${error}\n`);
  }
  process.exit(1);
}

process.stdout.write("bench-history content contracts OK\n");

function parseArgs(argv) {
  let historyRoot = DEFAULT_HISTORY_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--history-root") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--history-root requires a path");
      }
      historyRoot = path.resolve(value);
      index += 1;
    } else if (token === "--help" || token === "-h") {
      process.stdout.write(
        [
          "check-content-contracts -- validate committed bench-history pointers",
          "",
          "Usage:",
          "  node scripts/ci/check-content-contracts.mjs [--history-root <path>]",
          ""
        ].join("\n")
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return { historyRoot };
}

async function checkBenchHistory(historyRoot) {
  await access(historyRoot);
  const entries = await readdir(historyRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !BENCH_ROOTS.has(entry.name)) continue;
    await checkBenchRoot(historyRoot, entry.name);
  }
  await checkDiagnostics(historyRoot);
}

async function checkBenchRoot(historyRoot, benchName) {
  const benchRoot = path.join(historyRoot, benchName);
  const entries = await readdir(benchRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !POINTER_PATTERN.test(entry.name)) continue;
    await checkPointer({
      historyRoot,
      benchName,
      benchRoot,
      pointerFile: entry.name
    });
  }
}

async function checkPointer({ benchName, benchRoot, pointerFile }) {
  const pointerPath = path.join(benchRoot, pointerFile);
  const pointer = await readJson(pointerPath);
  const pointerLabel = `${benchName}/${pointerFile}`;
  if (!isObject(pointer)) {
    add(`${pointerLabel}: pointer is not a JSON object`);
    return;
  }
  const { slug, kpi_path: kpiPath } = pointer;
  if (typeof slug !== "string" || typeof kpiPath !== "string") {
    add(`${pointerLabel}: pointer must contain string slug and kpi_path`);
    return;
  }
  if (isUnsafeRelativePath(slug) || isUnsafeRelativePath(kpiPath)) {
    add(`${pointerLabel}: slug and kpi_path must be safe relative paths`);
    return;
  }

  const archiveRoot = path.join(benchRoot, slug);
  const expectedKpiPath = path.join(archiveRoot, "kpi.json");
  const resolvedKpiPath = path.join(benchRoot, kpiPath);
  if (path.normalize(resolvedKpiPath) !== path.normalize(expectedKpiPath)) {
    add(`${pointerLabel}: kpi_path must resolve to ${slug}/kpi.json`);
    return;
  }

  const kpi = await readJson(expectedKpiPath, pointerLabel);
  if (!isObject(kpi)) return;
  if (pointerFile.startsWith("latest-passing")) {
    await checkLatestPassingPointer({
      benchName,
      pointerFile,
      pointerLabel,
      archiveRoot,
      kpi
    });
  }
}

async function checkLatestPassingPointer({
  benchName,
  pointerFile,
  pointerLabel,
  archiveRoot,
  kpi
}) {
  if (await exists(path.join(archiveRoot, "findings.md"))) {
    add(`${pointerLabel}: latest-passing must not point to an archive with findings.md`);
  }

  if (TIER1_ROOTS.has(benchName) && !isReleaseGradeTier1(benchName, kpi)) {
    add(`${pointerLabel}: latest-passing must point to release-grade v0.3.11 coverage`);
  }

  if (LONGMEMEVAL_ROOTS.has(benchName)) {
    const extractionPath = kpi.kpi?.seed_extraction_path;
    if (!isObject(extractionPath)) {
      add(`${pointerLabel}: latest-passing LongMemEval archive is missing seed_extraction_path`);
    } else {
      checkOfficialSeedExtraction(pointerLabel, extractionPath);
    }
  } else if (isObject(kpi.kpi?.seed_extraction_path)) {
    checkOfficialSeedExtraction(pointerLabel, kpi.kpi.seed_extraction_path);
  }

  if (TIER1_ROOTS.has(benchName) && !isObject(kpi.kpi?.recall_token_economy)) {
    add(`${pointerLabel}: latest-passing release archive is missing recall_token_economy`);
  }

  checkTier1Threshold(pointerLabel, benchName, pointerFile, kpi);
  if (benchName === "live") {
    await checkLiveLatestPassing(pointerLabel, archiveRoot);
  }
}

function checkOfficialSeedExtraction(pointerLabel, extractionPath) {
  if (extractionPath.path !== "official_api_compile") {
    add(`${pointerLabel}: latest-passing cannot use seed_extraction_path=${extractionPath.path}`);
  }
  for (const field of [
    "offline_fallbacks",
    "live_extraction_failures",
    "cached_extraction_failures"
  ]) {
    const value = extractionPath[field] ?? 0;
    if (value !== 0) {
      add(`${pointerLabel}: latest-passing requires ${field}=0, got ${value}`);
    }
  }
}

function checkTier1Threshold(pointerLabel, benchName, pointerFile, kpi) {
  const rAt5 = kpi.kpi?.r_at_5;
  if (typeof rAt5 !== "number") return;
  const embeddingOn = kpi.embedding_provider !== "none";
  if (benchName === "public" && kpi.split === "longmemeval-s" && !embeddingOn) {
    min(pointerLabel, rAt5, 0.9, "LongMemEval-S 500 embedding-off R@5");
  }
  if (
    (benchName === "public-multiturn" || benchName === "public-crossquestion") &&
    !embeddingOn
  ) {
    min(pointerLabel, rAt5, 0.9, `${benchName} 500 embedding-off R@5`);
  }
  if (benchName === "public-locomo") {
    min(pointerLabel, rAt5, embeddingOn ? 0.9 : 0.55, "LoCoMo full R@5");
  }
  if (pointerFile.includes("embedding-on") && !embeddingOn) {
    add(`${pointerLabel}: embedding-on pointer references embedding_provider=${kpi.embedding_provider}`);
  }
  if (pointerFile.includes("embedding-off") && embeddingOn) {
    add(`${pointerLabel}: embedding-off pointer references embedding_provider=${kpi.embedding_provider}`);
  }
}

function min(pointerLabel, value, target, label) {
  if (value < target) {
    add(`${pointerLabel}: ${label} ${value} is below ${target}`);
  }
}

function isReleaseGradeTier1(benchName, kpi) {
  const sampleSize = kpi.sample_size;
  const evaluatedCount = kpi.evaluated_count;
  if (typeof sampleSize !== "number" || typeof evaluatedCount !== "number") return false;
  if (evaluatedCount < sampleSize) return false;
  if (benchName === "public-locomo") return sampleSize >= 1982;
  return sampleSize >= 500;
}

async function checkLiveLatestPassing(pointerLabel, archiveRoot) {
  const gatesPath = path.join(archiveRoot, "live-gates.json");
  if (!(await exists(gatesPath))) {
    add(`${pointerLabel}: live latest-passing requires live-gates.json`);
    return;
  }
  const gates = await readJson(gatesPath, pointerLabel);
  if (!isObject(gates)) return;
  const status = gates.source_status ?? gates.status;
  if (status !== "pass") {
    add(`${pointerLabel}: live-gates source status must be pass`);
  }
}

async function checkDiagnostics(historyRoot) {
  const files = await walk(historyRoot);
  for (const filePath of files) {
    const filename = path.basename(filePath);
    if (!COMPACT_DIAGNOSTIC_FILENAMES.has(filename)) continue;
    const size = (await stat(filePath)).size;
    const relative = path.relative(historyRoot, filePath);
    if (size > COMPACT_DIAGNOSTIC_MAX_BYTES) {
      add(`${relative}: compact diagnostics exceeds ${COMPACT_DIAGNOSTIC_MAX_BYTES} bytes`);
      continue;
    }
    const diagnostics = await readJson(filePath, relative);
    if (!isObject(diagnostics)) continue;
    if (Array.isArray(diagnostics.questions)) {
      add(`${relative}: tracked full diagnostics are forbidden; commit compact sidecars only`);
    }
    const artifactPath = diagnostics.full_diagnostics_artifact_path;
    if (
      typeof artifactPath === "string" &&
      artifactPath.split(/[\\/]+/).includes("bench-history")
    ) {
      add(`${relative}: full_diagnostics_artifact_path must point outside docs/bench-history`);
    }
  }
}

async function walk(root) {
  const files = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function readJson(filePath, label = filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    add(`${label}: failed to read JSON (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isUnsafeRelativePath(value) {
  return (
    value.length === 0 ||
    path.isAbsolute(value) ||
    value.split(/[\\/]+/).includes("..")
  );
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function add(message) {
  errors.push(message);
}
