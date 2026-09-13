#!/usr/bin/env node
// Packages-only knip exports/types audit with a shrinking baseline.
// New unused exports fail; removals are allowed (update the baseline when convenient).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const baselinePath = path.join(
  repoRoot,
  "scripts/ci/unused-package-exports-baseline.json"
);
const writeBaseline = process.argv.includes("--write-baseline");

const knip = spawnSync(
  "pnpm",
  [
    "exec",
    "knip",
    "--config",
    "knip.json",
    "--include",
    "exports,types",
    "--no-progress",
    "--no-config-hints",
    "--reporter",
    "json"
  ],
  { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, shell: process.platform === "win32" }
);

if (knip.error) {
  console.error(`unused-package-exports: failed to start knip: ${knip.error.message}`);
  process.exit(1);
}

const report = parseKnipJson(knip.stdout);
if (report === null) {
  console.error("unused-package-exports: knip did not emit JSON");
  if (knip.stderr) console.error(knip.stderr.trim());
  process.exit(knip.status === 0 ? 1 : knip.status ?? 1);
}

const current = collectPackageSignatures(report);
if (writeBaseline) {
  writeFileSync(baselinePath, `${JSON.stringify({ signatures: current }, null, 2)}\n`);
  console.log(`unused-package-exports: wrote ${current.length} signatures to ${path.relative(repoRoot, baselinePath)}`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const allowed = new Set(baseline.signatures);
const added = current.filter((signature) => !allowed.has(signature));
const removed = baseline.signatures.filter((signature) => !current.includes(signature));

if (added.length > 0) {
  console.error(`unused-package-exports: ${added.length} new unused package export(s)/type(s):`);
  for (const signature of added.slice(0, 50)) console.error(`  ${signature}`);
  if (added.length > 50) console.error(`  … ${added.length - 50} more`);
  process.exit(1);
}

console.log(
  `unused-package-exports: ok (${current.length} signatures, baseline ${baseline.signatures.length}${removed.length > 0 ? `, ${removed.length} can be dropped from the baseline` : ""})`
);

function parseKnipJson(stdout) {
  if (typeof stdout !== "string") return null;
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
}

function collectPackageSignatures(report) {
  const signatures = [];
  for (const issue of report.issues ?? []) {
    const file = issue.file ?? "";
    if (!file.startsWith("packages/")) continue;
    if (file.includes("/__tests__/") || file.includes(".test.ts") || file.includes(".test.tsx")) continue;
    for (const item of issue.exports ?? []) signatures.push(`export:${file}:${item.name}`);
    for (const item of issue.types ?? []) signatures.push(`type:${file}:${item.name}`);
  }
  signatures.sort();
  return signatures;
}
