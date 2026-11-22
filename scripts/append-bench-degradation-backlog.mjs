#!/usr/bin/env node

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// Baseline-diff degradation gate. Works uniformly across the four bench
// surfaces (public / public-multiturn / public-crossquestion / public-locomo):
// each writes the same KpiPayload.diff_vs_previous block, so one r_at_5
// threshold check covers all of them. --bench selects the surface.
const KNOWN_BENCHES = new Set([
  "public",
  "public-multiturn",
  "public-crossquestion",
  "public-locomo"
]);

const args = parseArgs(process.argv.slice(2));
const historyRoot = args["history-root"] ?? loadDefaultHistoryRoot();
const benchName = args.bench ?? "public";
const backlogPath = args.backlog ?? path.join(historyRoot, "degradation-backlog.md");
const thresholdPp = Number.parseFloat(args["threshold-pp"] ?? "5");

if (!KNOWN_BENCHES.has(benchName)) {
  console.error(
    `unknown --bench '${benchName}'; expected one of ${[...KNOWN_BENCHES].join(", ")}`
  );
  process.exit(2);
}

const latest = readLatestPayload(historyRoot, benchName);
if (latest === null) {
  emitJsonAndExit({ action: "noop", reason: "latest_payload_missing" });
}

const delta = readNumber(latest.payload.diff_vs_previous?.r_at_5_delta_pp);
if (delta === null || delta > -thresholdPp) {
  emitJsonAndExit({ action: "noop", reason: "threshold_not_met", slug: latest.slug, delta });
}

const marker = `bench-degradation:auto ${benchName}/${latest.slug}`;
mkdirSync(path.dirname(backlogPath), { recursive: true });
const lockPath = `${backlogPath}.lock`;
withExclusiveLock(lockPath, () => {
  const original = existsSync(backlogPath) ? readFileSync(backlogPath, "utf8") : [
    "# Benchmark degradation backlog", "", "**Next available number**: `#BL-001`",
    "", "## Open Issues", "", "No open `#BL-*` issues at this time.", ""
  ].join("\n");
  if (original.includes(marker)) {
    emitJson({ action: "noop", reason: "already_recorded", slug: latest.slug, delta });
    return;
  }

  const issueNumber = readNextIssueNumber(original);
  const nextIssueNumber = issueNumber + 1;
  const issueId = formatIssueId(issueNumber);
  const nextIssueId = formatIssueId(nextIssueNumber);
  const issue = renderIssue({
    issueId,
    benchName,
    slug: latest.slug,
    delta,
    thresholdPp,
    archivePath: path.resolve(historyRoot, benchName, latest.slug),
    payload: latest.payload,
    marker
  });

  let updated = original.replace(
    /\*\*Next available number\*\*: `#BL-\d{3,}`/,
    `**Next available number**: \`${nextIssueId}\``
  );
  updated = insertOpenIssue(updated, issue);
  writeFileSync(backlogPath, updated, "utf8");
  emitJson({ action: "opened", issue: issueId, slug: latest.slug, delta });
});

function emitJson(payload) {
  writeFileSync(1, `${JSON.stringify(payload)}\n`, "utf8");
}

function emitJsonAndExit(payload) {
  emitJson(payload);
  process.exit(0);
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = next;
      index += 1;
    }
  }
  return out;
}

function loadDefaultHistoryRoot() {
  // Keep the eval dist import off the --history-root path used by tests.
  const require = createRequire(import.meta.url);
  return require("../packages/eval/dist/index.js").resolveDefaultBenchHistoryRoot();
}

function readLatestPayload(root, bench) {
  const benchRoot = path.join(root, bench);
  if (!existsSync(benchRoot)) return null;
  const pointerPath = path.join(benchRoot, "latest-run.json");
  let slug = null;
  let kpiRelPath = null;
  if (existsSync(pointerPath)) {
    const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
    slug = typeof pointer.slug === "string" ? pointer.slug : null;
    // The pointer carries kpi_path (slug-relative); prefer it so a future
    // archive layout change does not break this consumer.
    kpiRelPath =
      typeof pointer.kpi_path === "string" ? pointer.kpi_path : null;
  }
  if (slug === null) {
    const slugs = readdirSync(benchRoot)
      .filter((name) => /^\d{4}-\d{2}-\d{2}T\d{6}Z-[0-9a-f]{7,40}$/.test(name))
      .sort();
    slug = slugs.at(-1) ?? null;
  }
  if (slug === null) return null;
  const kpiPath = resolveContainedKpiPath(root, benchRoot, slug, kpiRelPath);
  if (!existsSync(kpiPath)) return null;
  return { slug, payload: JSON.parse(readFileSync(kpiPath, "utf8")) };
}

function resolveContainedKpiPath(historyRoot, benchRoot, slug, kpiRelPath) {
  const relative = kpiRelPath ?? slugKpiRelPath(slug);
  const historyResolved = path.resolve(historyRoot);
  if (
    relative.includes("\0")
    || path.isAbsolute(relative)
    || relative.split(/[\\/]/u).includes("..")
  ) {
    throw new Error(`kpi_path escapes repository root: ${relative}`);
  }
  const resolved = path.resolve(benchRoot, relative);
  assertInsideRoot(historyResolved, resolved, relative);
  if (existsSync(historyResolved)) {
    const realRoot = realpathSync(historyResolved);
    const probe = existsSync(resolved) ? realpathSync(resolved) : resolved;
    assertInsideRoot(realRoot, probe, relative);
  }
  return resolved;
}

function slugKpiRelPath(slug) {
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9._-]*$/iu.test(slug)) {
    throw new Error(`invalid latest-run slug: ${slug}`);
  }
  return `${slug}/kpi.json`;
}

function assertInsideRoot(root, candidate, kpiRelPath) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`kpi_path escapes repository root: ${kpiRelPath}`);
  }
}

function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatIssueId(issueNumber) {
  return `#BL-${String(issueNumber).padStart(3, "0")}`;
}

function readNextIssueNumber(markdown) {
  const match = markdown.match(/\*\*Next available number\*\*: `#BL-(\d{3,})`/);
  if (match === null) {
    throw new Error("backlog next issue number marker not found");
  }
  return Number.parseInt(match[1], 10);
}

function renderIssue({ issueId, benchName, slug, delta, thresholdPp, archivePath, payload, marker }) {
  const previousRun = payload.diff_vs_previous?.previous_run ?? "unknown";
  const planeLines = renderPlaneCoverageLines(payload);
  return [
    `### ${issueId} — Bench degradation: ${benchName} ${slug}`,
    "",
    "**Status**: Open.",
    "",
    `**Detected by**: \`apps/bench-runner/scripts/run-daily-public-bench.sh\`.`,
    "",
    `**Trigger**: R@5 changed by ${formatPp(delta)}pp against \`${previousRun}\`, crossing the ${thresholdPp.toFixed(1)}pp daily degradation threshold.`,
    "",
    `**Scope**: Inspect \`${archivePath}\` and the prior archive, identify whether the loss is scoring, ingestion, provider, or dataset noise, then close with a verified bench rerun.`,
    ...planeLines,
    "",
    `<!-- ${marker} -->`,
    ""
  ].join("\n");
}

function renderPlaneCoverageLines(payload) {
  const coverage = payload.kpi?.quality_metrics?.per_plane_recall_coverage;
  if (coverage === undefined || coverage === null) return [];
  const planes = Object.keys(coverage).sort();
  if (planes.length === 0) return [];
  const rows = planes.map((plane) => {
    const entry = coverage[plane];
    const rate = readNumber(entry?.hit_at_5_rate);
    const rendered = rate === null ? "n/a" : (rate * 100).toFixed(1) + "%";
    return `- \`${plane}\`: ${rendered} (${entry?.hit_at_5_count ?? 0}/${entry?.gold_count ?? 0})`;
  });
  return ["", "**Per-plane recall@5 coverage (current run)**:", ...rows];
}

function insertOpenIssue(markdown, issue) {
  const openHeader = "## Open Issues\n";
  const openStart = markdown.indexOf(openHeader);
  if (openStart === -1) {
    throw new Error("Open Issues section not found");
  }
  const afterHeader = openStart + openHeader.length;
  const nextHeader = markdown.indexOf("\n## ", afterHeader);
  const openBody = nextHeader === -1 ? markdown.slice(afterHeader) : markdown.slice(afterHeader, nextHeader);
  const replacementBody = openBody.includes("No open `#BL-*` issues at this time.")
    ? `\n${issue}`
    : `${openBody.trimEnd()}\n\n${issue}`;
  return nextHeader === -1
    ? `${markdown.slice(0, afterHeader)}${replacementBody}`
    : `${markdown.slice(0, afterHeader)}${replacementBody}${markdown.slice(nextHeader)}`;
}

function formatPp(value) {
  return value.toFixed(1);
}

function withExclusiveLock(lockPath, fn) {
  let fd;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      console.error(`backlog lock exists: ${lockPath}`);
      process.exit(1);
    }
    throw error;
  }
  try {
    fn();
  } finally {
    closeSync(fd);
    unlinkSync(lockPath);
  }
}
