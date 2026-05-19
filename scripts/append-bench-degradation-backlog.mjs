#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const historyRoot = args["history-root"] ?? "docs/bench-history";
const benchName = args.bench ?? "public";
const backlogPath = args.backlog ?? "docs/handbook/backlog.md";
const thresholdPp = Number.parseFloat(args["threshold-pp"] ?? "5");

const latest = readLatestPayload(historyRoot, benchName);
if (latest === null) {
  console.log(JSON.stringify({ action: "noop", reason: "latest_payload_missing" }));
  process.exit(0);
}

const delta = readNumber(latest.payload.diff_vs_previous?.r_at_5_delta_pp);
if (delta === null || delta > -thresholdPp) {
  console.log(JSON.stringify({ action: "noop", reason: "threshold_not_met", slug: latest.slug, delta }));
  process.exit(0);
}

const marker = `bench-degradation:auto ${benchName}/${latest.slug}`;
const original = readFileSync(backlogPath, "utf8");
if (original.includes(marker)) {
  console.log(JSON.stringify({ action: "noop", reason: "already_recorded", slug: latest.slug, delta }));
  process.exit(0);
}

const issueNumber = readNextIssueNumber(original);
const nextIssueNumber = issueNumber + 1;
const issueId = `#BL-${String(issueNumber).padStart(3, "0")}`;
const nextIssueId = `#BL-${String(nextIssueNumber).padStart(3, "0")}`;
const issue = renderIssue({
  issueId,
  benchName,
  slug: latest.slug,
  delta,
  thresholdPp,
  payload: latest.payload,
  marker
});

let updated = original.replace(
  /\*\*Next available number\*\*: `#BL-\d{3}`/,
  `**Next available number**: \`${nextIssueId}\``
);
updated = insertOpenIssue(updated, issue);
writeFileSync(backlogPath, updated, "utf8");
console.log(JSON.stringify({ action: "opened", issue: issueId, slug: latest.slug, delta }));

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

function readLatestPayload(root, bench) {
  const benchRoot = path.join(root, bench);
  if (!existsSync(benchRoot)) return null;
  const pointerPath = path.join(benchRoot, "latest-baseline.json");
  let slug = null;
  if (existsSync(pointerPath)) {
    const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
    slug = typeof pointer.slug === "string" ? pointer.slug : null;
  }
  if (slug === null) {
    const slugs = readdirSync(benchRoot)
      .filter((name) => /^\d{4}-\d{2}-\d{2}T\d{6}Z-[0-9a-f]{7,40}$/.test(name))
      .sort();
    slug = slugs.at(-1) ?? null;
  }
  if (slug === null) return null;
  const kpiPath = path.join(benchRoot, slug, "kpi.json");
  if (!existsSync(kpiPath)) return null;
  return { slug, payload: JSON.parse(readFileSync(kpiPath, "utf8")) };
}

function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNextIssueNumber(markdown) {
  const match = markdown.match(/\*\*Next available number\*\*: `#BL-(\d{3})`/);
  if (match === null) {
    throw new Error("backlog next issue number marker not found");
  }
  return Number.parseInt(match[1], 10);
}

function renderIssue({ issueId, benchName, slug, delta, thresholdPp, payload, marker }) {
  const previousRun = payload.diff_vs_previous?.previous_run ?? "unknown";
  return [
    `### ${issueId} — Bench degradation: ${benchName} ${slug}`,
    "",
    "**Status**: Open.",
    "",
    `**Detected by**: \`apps/bench-runner/scripts/run-daily-public-bench.sh\`.`,
    "",
    `**Trigger**: R@5 changed by ${formatPp(delta)}pp against \`${previousRun}\`, crossing the ${thresholdPp.toFixed(1)}pp daily degradation threshold.`,
    "",
    `**Scope**: Inspect \`docs/bench-history/${benchName}/${slug}/\` and the prior archive, identify whether the loss is scoring, ingestion, provider, or dataset noise, then close with a verified bench rerun.`,
    "",
    `<!-- ${marker} -->`,
    ""
  ].join("\n");
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
