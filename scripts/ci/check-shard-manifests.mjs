#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROJECT_COVERAGE, VITEST_PROJECT_GROUPS, VITEST_PROJECTS, benchShardPaths, createVitestEnv, filesDigest, parseShard, sanitizeProjectName } from "./vitest-projects.mjs";

const GROUPS = Object.keys(VITEST_PROJECT_GROUPS);

if (import.meta.main) {
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
}

export function checkShards({ label, shardDir, coverageDir, needsResult, commit = currentCommit() }) {
  const failures = [];
  if (needsResult !== undefined && needsResult !== "success") {
    failures.push(`test shards finished as ${needsResult}`);
  }
  const manifests = loadManifests(shardDir, failures);
  const seen = new Map();
  for (const group of manifests.keys()) {
    if (!GROUPS.includes(group)) failures.push(`unknown shard group ${group}`);
  }
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
      if (manifest.commit !== commit) failures.push(`${group} manifest commit differs from ${commit}`);
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
  if (coverageDir !== undefined && failures.length === 0) {
    mergeBenchCoverage(manifests.get("bench-runner"), coverageDir, label, failures);
    if (failures.length === 0) checkCoverage(coverageDir, failures);
  }
  return failures;
}

function checkCoverage(coverageDir, failures) {
  const found = new Map();
  for (const summary of findSummaries(coverageDir, failures)) {
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

function findSummaries(root, failures) {
  const summaries = [];
  const visit = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSafe(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name === "coverage-summary.json") {
        const project = projectFromSummary(full);
        if (project === undefined) failures.push(`unknown coverage summary ${full}`);
        else summaries.push({ project, total: readTotal(full) });
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
  return partitionFailuresForShards(group, manifests);
}

function partitionFailuresForShards(group, manifests) {
  const partitions = manifests.map((manifest) => manifest.partition);
  if (group !== "bench-runner" || partitions.some((part) => part?.algorithm !== "duration-lpt"
    || !Number.isSafeInteger(part.count) || part.count < 1 || !/^[a-f0-9]{64}$/u.test(part.digest)
    || !Array.isArray(part.files) || part.files.some((file) => typeof file !== "string"))) {
    return [`${group} partition metadata is missing or invalid`];
  }
  const first = partitions[0];
  const files = partitions.flatMap((part) => part.files);
  if (partitions.some((part) => part.count !== first.count || part.digest !== first.digest)
    || new Set(files).size !== files.length || files.length !== first.count
    || filesDigest(files) !== first.digest) return [`${group} partition is incomplete, duplicated, or inconsistent`];
  return [];
}

function currentCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function mergeBenchCoverage(manifests, coverageDir, label, failures) {
  if (manifests[0].shard === undefined) return;
  const project = "@do-soul/alaya-bench-runner";
  const destination = path.join(coverageDir, "merged", sanitizeProjectName(project));
  const blobs = mkdtempSync(path.join(tmpdir(), "vitest-coverage-"));
  try {
    rmSync(path.join(coverageDir, "merged"), { recursive: true, force: true });
    const expectedArtifacts = new Set([
      ...GROUPS.filter((group) => group !== "bench-runner").map((group) => `coverage-${label}-${group}`),
      ...manifests.map((manifest) => {
        const shard = parseShard(manifest.shard);
        return `coverage-${label}-bench-runner-${shard.index}-of-${shard.count}`;
      })
    ]);
    for (const entry of readdirSafe(coverageDir)) {
      if (!entry.isDirectory() || !expectedArtifacts.has(entry.name)) throw new Error(`unexpected coverage artifact ${entry.name}`);
    }
    for (const manifest of manifests) {
      const shard = parseShard(manifest.shard);
      const name = path.basename(benchShardPaths(shard).blob);
      const dir = path.join(coverageDir, `coverage-${label}-bench-runner-${shard.index}-of-${shard.count}`);
      const files = readdirSafe(dir);
      if (files.length !== 1 || files[0].name !== name || !files[0].isFile()) {
        throw new Error(`coverage artifact missing or unexpected for bench shard ${manifest.shard}`);
      }
      const source = path.join(dir, name);
      verifyCoverageBlob(source, manifest);
      copyFileSync(source, path.join(blobs, name));
    }
    const floor = PROJECT_COVERAGE[project];
    const cli = path.join(path.dirname(fileURLToPath(import.meta.resolve("vitest/package.json"))), "vitest.mjs");
    const result = spawnSync(process.execPath, [
      cli, "run", "--config=vitest.config.mjs", `--project=${project}`, `--merge-reports=${blobs}`,
      "--coverage.enabled", `--coverage.include=${floor.include}`, `--coverage.reportsDirectory=${destination}`,
      "--coverage.reporter=text-summary", "--coverage.reporter=json-summary", "--coverage.reporter=lcov",
      ...["statements", "lines", "functions", "branches"].map((metric) => `--coverage.thresholds.${metric}=${floor[metric]}`)
    ], { stdio: "inherit", env: createVitestEnv(true, { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" }) });
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(`native coverage merge failed: ${result.error?.message ?? result.status}`);
    }
  } catch (error) {
    failures.push(error.message);
  } finally {
    rmSync(blobs, { recursive: true, force: true });
  }
}

function verifyCoverageBlob(file, manifest) {
  const content = readFileSync(file);
  if (manifest.coverage?.format !== "vitest-blob"
    || createHash("sha256").update(content).digest("hex") !== manifest.coverage.sha256) {
    throw new Error(`coverage blob digest differs for shard ${manifest.shard}`);
  }
  // Vitest 4.1.11 has no public blob reader. Reject unknown envelope/version
  // shapes here; native Vitest alone decodes and merges the coverage maps.
  const encoded = JSON.parse(content.toString("utf8"));
  const entry = (reference) => typeof reference === "string" && /^\d+$/u.test(reference) ? encoded[reference] : undefined;
  const [versionRef, testsRef, errorsRef, coverageRef] = Array.isArray(encoded[0]) ? encoded[0] : [];
  const tests = entry(testsRef);
  const errors = entry(errorsRef);
  const coverage = entry(coverageRef);
  const require = createRequire(import.meta.url);
  if (entry(versionRef) !== require("vitest/package.json").version || !Array.isArray(tests)
    || !Array.isArray(errors) || errors.length > 0 || coverage === null || typeof coverage !== "object"
    || Object.keys(coverage).length === 0) throw new Error(`coverage blob is incomplete or incompatible for shard ${manifest.shard}`);
  const testFiles = tests.map((reference) => {
    const test = entry(reference);
    const file = entry(test?.filepath);
    if (entry(test?.projectName) !== "@do-soul/alaya-bench-runner" || typeof file !== "string") {
      throw new Error(`coverage blob has unexpected tests for shard ${manifest.shard}`);
    }
    return path.relative(process.cwd(), file).replaceAll("\\", "/");
  });
  if (testFiles.length !== manifest.partition.files.length
    || filesDigest(testFiles) !== filesDigest(manifest.partition.files)) {
    throw new Error(`coverage blob tests differ from partition for shard ${manifest.shard}`);
  }
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
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
    catch { failures.push(`unreadable shard manifest ${manifestPath}`); continue; }
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
    const { complete, partial } = fileShardFailures(root);
    const failures = { partition, ok, cancelled, missing, skipped, overlap, below, complete, partial };
    if (partition.length > 0 || ok.length !== 0 || cancelled.length === 0 || missing.length === 0
      || skipped.length === 0 || overlap.length === 0 || below.length === 0
      || complete.length > 0 || partial.length === 0) {
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

function fileShardFailures(root) {
  const shardDir = path.join(root, "file-shards");
  mkdirSync(shardDir, { recursive: true });
  for (const [group, projects] of Object.entries(VITEST_PROJECT_GROUPS)) {
    const count = group === "bench-runner" ? 4 : 1;
    for (let index = 1; index <= count; index += 1) {
      const dir = path.join(shardDir, `${group}-${index}`);
      mkdirSync(dir);
      writeFileSync(path.join(dir, "shard-manifest.json"), JSON.stringify({
        label: "windows-node24",
        group,
        status: "success",
        projects,
        commit: currentCommit(),
        ...(group === "bench-runner" ? {
          shard: `${index}/${count}`,
          partition: {
            algorithm: "duration-lpt", count, digest: filesDigest(["1", "2", "3", "4"]), files: [String(index)]
          }
        } : {})
      }));
    }
  }
  const complete = checkShards({
    label: "windows-node24", shardDir, needsResult: "success"
  });
  rmSync(path.join(shardDir, "bench-runner-4"), { recursive: true });
  const partial = checkShards({
    label: "windows-node24", shardDir, needsResult: "success"
  }).filter((line) => line.includes("incomplete"));
  return { complete, partial };
}

function writeGood(root) {
  const shardDir = path.join(root, "shards");
  mkdirSync(shardDir, { recursive: true });
  for (const [group, projects] of Object.entries(VITEST_PROJECT_GROUPS)) {
    const dir = path.join(shardDir, group);
    mkdirSync(dir);
    writeFileSync(path.join(dir, "shard-manifest.json"), JSON.stringify({
      label: "ubuntu-node24", group, status: "success", projects, commit: currentCommit()
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
