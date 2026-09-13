#!/usr/bin/env node
// pnpm audit at moderate, minus an explicit exemption list. New findings fail;
// unused exemptions fail so the list can only shrink.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const exemptions = JSON.parse(
  readFileSync(path.join(repoRoot, "scripts/ci/audit-exemptions.json"), "utf8")
);
const blockedSeverities = new Set(["moderate", "high", "critical"]);

const result = spawnSync(
  "pnpm",
  ["audit", "--json", "--registry=https://registry.npmjs.org/"],
  { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, shell: process.platform === "win32" }
);

if (result.error) {
  console.error(`audit: failed to start pnpm: ${result.error.message}`);
  process.exit(1);
}

const report = parseAuditJson(result.stdout);
if (report === null) {
  console.error("audit: pnpm audit did not emit JSON");
  if (result.stderr) console.error(result.stderr.trim());
  process.exit(1);
}

const advisories = Object.values(report.advisories ?? {});
const used = new Set();
const blocked = [];
for (const advisory of advisories) {
  const ghsa = advisory.github_advisory_id;
  const severity = advisory.severity;
  if (!blockedSeverities.has(severity)) continue;
  if (typeof ghsa === "string" && exemptions[ghsa] !== undefined) {
    used.add(ghsa);
    continue;
  }
  blocked.push(
    `${severity} ${advisory.module_name} ${ghsa ?? advisory.url ?? advisory.title}`
  );
}

const unused = Object.keys(exemptions).filter((id) => !used.has(id));
if (blocked.length > 0 || unused.length > 0) {
  for (const line of blocked) console.error(`audit: unexempted ${line}`);
  for (const id of unused) console.error(`audit: unused exemption ${id} (${exemptions[id]})`);
  process.exit(1);
}

console.log(
  `check-audit: ok (moderate+ findings exempted: ${used.size}; ${advisories.length} advisory object(s))`
);

function parseAuditJson(stdout) {
  if (typeof stdout !== "string") return null;
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
}
