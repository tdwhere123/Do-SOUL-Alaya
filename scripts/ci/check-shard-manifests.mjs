#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROJECT_COVERAGE, VITEST_PROJECT_GROUPS, VITEST_PROJECTS, sanitizeProjectName } from "./vitest-projects.mjs";

const GROUPS = Object.keys(VITEST_PROJECT_GROUPS);

if (process.argv.includes("--self-test")) {
  process.exit(runSelfTest());
}

const label = requiredArg("--label");
const shardDir = requiredArg("--shards");
const coverageDir = argValue("--coverage");
const needsResult = argValue("--needs-result");
const failures = checkShards({ label, shardDir, coverageDir, needsResult });
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`shard manifests ok for ${label}`);

export function checkShards({ label, shardDir, coverageDir, needsResult }) {
  const failures = [];
  if (needsResult !== undefined && needsResult !== "success") {
    failures.push(`test shards finished as ${needsResult}`);
  }
  const manifests = loadManifests(shardDir, failures);
  const seen = new Map();
  for (const group of GROUPS) {
    const groupManifests = manifests.get(group) ?? [];
    if (groupManifests.length === 0) {
      failures.push(`${label} missing shard ${group}`);
      continue;
    }
    const shardFailures = shardSetFailures(group, groupManifests);
    failures.push(...shardFailures);
    if (shardFailures.length > 0) continue;
    for (const manifest of groupManifests) {
      if (manifest.label !== label) failures.push(`${group} manifest label is ${manifest.label}`);
      if (manifest.status !== "success") failures.push(`${label} ${group} status is ${manifest.status}`);
      const projects = Array.isArray(manifest.projects) ? manifest.projects : [];
      const expected = VITEST_PROJECT_GROUPS[group];
      if (!sameList(projects, expected)) {
        failures.push(`${label} ${group} projects differ from the group`);
      }
      for (const project of projects) {
        if (seen.has(project) && manifest.shard === undefined) {
          failures.push(`${project} ran in both ${seen.get(project)} and ${group}`);
        } else seen.set(project, group);
      }
    }
  }
  for (const project of VITEST_PROJECTS) {
    if (!seen.has(project)) failures.push(`${label} did not run ${project}`);
  }
  if (coverageDir !== undefined) checkCoverage(coverageDir, failures);
  return failures;
}

function checkCoverage(coverageDir, failures) {
  const found = new Map();
  for (const summary of findSummaries(coverageDir)) {
    const project = summary.project;
    if (found.has(project)) failures.push(`coverage for ${project} arrived more than once`);
    found.set(project, summary.total);
  }
  for (const project of VITEST_PROJECTS) {
    const total = found.get(project);
    const floor = PROJECT_COVERAGE[project];
    if (total === undefined || floor === undefined) {
      failures.push(`coverage summary missing for ${project}`);
      continue;
    }
    for (const metric of ["statements", "lines", "functions", "branches"]) {
      const pct = total[metric]?.pct;
      if (typeof pct !== "number" || pct < floor[metric]) {
        failures.push(`${project} ${metric} ${pct} is below ${floor[metric]}`);
      }
    }
  }
}

function findSummaries(root) {
  const summaries = [];
  const visit = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSafe(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name === "coverage-summary.json") {
        const project = projectFromSummary(full);
        if (project !== undefined) summaries.push({ project, total: readTotal(full) });
      }
    }
  };
  visit(root);
  return summaries;
}

function projectFromSummary(file) {
  const directory = path.basename(path.dirname(file));
  return VITEST_PROJECTS.find((project) => sanitizeProjectName(project) === directory);
}

function readTotal(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8")).total ?? {};
  } catch {
    return {};
  }
}

function shardSetFailures(group, manifests) {
  const shards = manifests.map((manifest) => manifest.shard).filter((shard) => shard !== undefined && shard !== "");
  if (shards.length === 0) {
    return manifests.length === 1 ? [] : [`duplicate shard manifest for ${group}`];
  }
  if (shards.length !== manifests.length) return [`${group} mixed a full run with a file shard`];
  const parsed = shards.map(parseShard);
  if (parsed.some((shard) => shard === undefined)) return [`${group} has an unreadable file shard`];
  const count = parsed[0].count;
  if (parsed.some((shard) => shard.count !== count)) return [`${group} file shard widths differ`];
  const indexes = new Set(parsed.map((shard) => shard.index));
  if (indexes.size !== count || parsed.length !== count) {
    return [`${group} file shard set is incomplete`];
  }
  for (let index = 1; index <= count; index += 1) {
    if (!indexes.has(index)) return [`${group} missing file shard ${index}/${count}`];
  }
  return [];
}

function parseShard(shard) {
  const match = /^(\d+)\/(\d+)$/u.exec(shard);
  if (match === null) return undefined;
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (count < 1 || index < 1 || index > count) return undefined;
  return { index, count };
}

function loadManifests(shardDir, failures) {
  const manifests = new Map();
  if (!existsSync(shardDir)) {
    failures.push(`shard directory missing: ${shardDir}`);
    return manifests;
  }
  for (const entry of readdirSafe(shardDir)) {
    const manifestPath = entry.isDirectory()
      ? path.join(shardDir, entry.name, "shard-manifest.json")
      : entry.name === "shard-manifest.json" ? path.join(shardDir, entry.name) : undefined;
    if (manifestPath === undefined || !existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const groupManifests = manifests.get(manifest.group) ?? [];
    groupManifests.push(manifest);
    manifests.set(manifest.group, groupManifests);
  }
  return manifests;
}

function readdirSafe(dir) {
  // A single download lands files directly; several artifacts arrive as child directories.
  return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [];
}

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requiredArg(name) {
  const value = argValue(name);
  if (value === undefined) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

function argValue(name) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found?.slice(prefix.length);
}

function runSelfTest() {
  const root = mkdtempSync(path.join(tmpdir(), "shard-manifests-"));
  try {
    const partition = partitionFailures();
    writeGood(root);
    const shardDir = path.join(root, "shards");
    const coverageDir = path.join(root, "coverage");
    const ok = checkShards({
      label: "ubuntu-node24", shardDir, coverageDir, needsResult: "success"
    });
    const cancelled = checkShards({
      label: "ubuntu-node24", shardDir, needsResult: "cancelled"
    });
    const missing = checkShards({
      label: "ubuntu-node24", shardDir: path.join(root, "missing"), needsResult: "success"
    });
    const skipped = statusFailures(shardDir, "skipped");
    const overlap = overlapFailures(shardDir);
    const below = belowFloorFailures(shardDir, coverageDir);
    const partial = partialShardFailures(root);
    const failures = { partition, ok, cancelled, missing, skipped, overlap, below, partial };
    if (partition.length > 0 || ok.length !== 0 || cancelled.length === 0 || missing.length === 0
      || skipped.length === 0 || overlap.length === 0 || below.length === 0 || partial.length === 0) {
      console.error("check-shard-manifests --self-test failed", failures);
      return 1;
    }
    console.log("check-shard-manifests --self-test: ok");
    return 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function partitionFailures() {
  const seen = new Set();
  const failures = [];
  for (const group of GROUPS) {
    for (const project of VITEST_PROJECT_GROUPS[group]) {
      if (seen.has(project)) failures.push(`${project} is in more than one group`);
      seen.add(project);
    }
  }
  for (const project of VITEST_PROJECTS) {
    if (!seen.has(project)) failures.push(`${project} is in no group`);
  }
  if (seen.size !== VITEST_PROJECTS.length) failures.push("group membership does not cover every project once");
  return failures;
}

function statusFailures(shardDir, status) {
  const manifestPath = path.join(shardDir, "libraries", "shard-manifest.json");
  const original = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(original);
  manifest.status = status;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const failures = checkShards({ label: "ubuntu-node24", shardDir, needsResult: "success" });
  writeFileSync(manifestPath, original);
  return failures.filter((line) => line.includes(status));
}

function overlapFailures(shardDir) {
  const manifestPath = path.join(shardDir, "libraries", "shard-manifest.json");
  const original = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(original);
  manifest.projects = [...manifest.projects, "@do-soul/alaya-bench-runner"];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const failures = checkShards({ label: "ubuntu-node24", shardDir, needsResult: "success" });
  writeFileSync(manifestPath, original);
  return failures.filter((line) => line.includes("ran in both"));
}

function belowFloorFailures(shardDir, coverageDir) {
  const project = VITEST_PROJECTS[0];
  const summaryPath = path.join(coverageDir, sanitizeProjectName(project), "coverage-summary.json");
  const original = readFileSync(summaryPath, "utf8");
  writeFileSync(summaryPath, JSON.stringify({
    total: { statements: { pct: 0 }, lines: { pct: 0 }, functions: { pct: 0 }, branches: { pct: 0 } }
  }));
  const failures = checkShards({
    label: "ubuntu-node24", shardDir, coverageDir, needsResult: "success"
  });
  writeFileSync(summaryPath, original);
  return failures.filter((line) => line.includes("below"));
}

function partialShardFailures(root) {
  const shardDir = path.join(root, "partial");
  mkdirSync(shardDir, { recursive: true });
  for (const [group, projects] of Object.entries(VITEST_PROJECT_GROUPS)) {
    const dir = path.join(shardDir, group);
    mkdirSync(dir);
    writeFileSync(path.join(dir, "shard-manifest.json"), JSON.stringify({
      label: "windows-node24",
      group,
      status: "success",
      projects,
      ...(group === "bench-runner" ? { shard: "1/2" } : {})
    }));
  }
  return checkShards({
    label: "windows-node24", shardDir, needsResult: "success"
  }).filter((line) => line.includes("incomplete"));
}

function writeGood(root) {
  const shardDir = path.join(root, "shards");
  mkdirSync(shardDir, { recursive: true });
  for (const [group, projects] of Object.entries(VITEST_PROJECT_GROUPS)) {
    const dir = path.join(shardDir, group);
    mkdirSync(dir);
    writeFileSync(path.join(dir, "shard-manifest.json"), JSON.stringify({
      label: "ubuntu-node24", group, status: "success", projects
    }));
  }
  for (const project of VITEST_PROJECTS) {
    const dir = path.join(root, "coverage", sanitizeProjectName(project));
    mkdirSync(dir, { recursive: true });
    const floor = PROJECT_COVERAGE[project];
    writeFileSync(path.join(dir, "coverage-summary.json"), JSON.stringify({
      total: {
        statements: { pct: floor.statements },
        lines: { pct: floor.lines },
        functions: { pct: floor.functions },
        branches: { pct: floor.branches }
      }
    }));
  }
}
