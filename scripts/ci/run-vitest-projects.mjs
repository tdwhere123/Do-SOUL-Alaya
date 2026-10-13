#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PROJECT_COVERAGE, benchShardPaths, createVitestEnv, parseShard, projectsForGroup, sanitizeProjectName } from "./vitest-projects.mjs";

const parsed = parseArgs(process.argv.slice(2));
const selected = projectsForGroup(parsed.group);
const isWindows = process.platform === "win32";
const childEnv = createVitestEnv(parsed.coverageEnabled);
const completed = [];
if (parsed.shard !== undefined) {
  const paths = benchShardPaths(parsed.shard);
  rmSync(paths.partition, { force: true });
  rmSync(paths.blob, { force: true });
}
recordCompleted(parsed.projectsFile, completed);

for (const project of selected) {
  console.log(`\n==> vitest project: ${project}`);
  const result = spawnSync(
    "pnpm",
    buildVitestArgs(project, parsed),
    { env: childEnv, stdio: "inherit", shell: isWindows }
  );
  if (result.error) {
    console.error(`failed to start vitest for ${project}: ${result.error.message}`);
    recordCompleted(parsed.projectsFile, completed);
    process.exit(1);
  }
  if (result.status !== 0) {
    recordCompleted(parsed.projectsFile, completed);
    process.exit(result.status ?? 1);
  }
  completed.push(project);
  recordCompleted(parsed.projectsFile, completed);
}

function parseArgs(argv) {
  const groupArg = argv.find((arg) => arg.startsWith("--group="));
  const projectsFileArg = argv.find((arg) => arg.startsWith("--projects-file="));
  const deferThresholds = argv.includes("--defer-coverage-thresholds");
  const shardIndex = argv.findIndex((arg) => arg === "--shard" || arg.startsWith("--shard="));
  const shardArg = argv[shardIndex];
  const shard = shardIndex < 0 ? undefined : parseShard(shardArg === "--shard"
    ? argv[shardIndex + 1] : shardArg.slice("--shard=".length));
  if (shardIndex >= 0 && (shard === undefined || groupArg !== "--group=bench-runner")) {
    throw new Error("file sharding requires --group=bench-runner and a valid --shard=index/count");
  }
  const vitestArgs = argv.filter((arg) => arg !== "--defer-coverage-thresholds"
    && !arg.startsWith("--group=")
    && !arg.startsWith("--projects-file="));
  return {
    group: groupArg?.slice("--group=".length),
    deferThresholds,
    shard,
    vitestArgs,
    coverageEnabled: vitestArgs.some(
      (arg) => arg === "--coverage.enabled" || arg.startsWith("--coverage.enabled=")
    ),
    hasCoverageReportsDirectoryArg: vitestArgs.some(
      (arg) => arg === "--coverage.reportsDirectory" || arg.startsWith("--coverage.reportsDirectory=")
    ),
    hasCoverageIncludeArg: vitestArgs.some(
      (arg) => arg === "--coverage.include" || arg.startsWith("--coverage.include=")
    ),
    hasCoverageThresholdArg: vitestArgs.some((arg) => arg.startsWith("--coverage.thresholds.")),
    projectsFile: projectsFileArg?.slice("--projects-file=".length) ?? process.env.ALAYA_SHARD_PROJECTS
  };
}

function recordCompleted(projectsFile, projects) {
  if (projectsFile === undefined) return;
  const result = { projects };
  if (parsed.shard !== undefined && projects.length > 0) {
    const paths = benchShardPaths(parsed.shard);
    result.partition = JSON.parse(readFileSync(paths.partition, "utf8"));
    if (parsed.coverageEnabled) {
      result.coverage = {
        format: "vitest-blob",
        sha256: createHash("sha256").update(readFileSync(paths.blob)).digest("hex")
      };
    }
  }
  writeFileSync(projectsFile, `${JSON.stringify(result)}\n`);
}

function buildVitestArgs(project, parsed) {
  return [
    "exec", "vitest", "run", "--config", "vitest.config.mjs", "--project", project,
    ...parsed.vitestArgs,
    ...buildCoverageArgs(project, parsed),
    ...(parsed.shard === undefined || !parsed.coverageEnabled ? [] : [
      "--reporter=default", "--reporter=blob", `--outputFile.blob=${benchShardPaths(parsed.shard).blob}`
    ]),
    ...windowsStorageWorkerArgs(project)
  ];
}

function windowsStorageWorkerArgs(project) {
  // Two forks still saturate NTFS on file-backed schema upgrades, so the
  // Quality windows-node24 storage project must run one file at a time.
  if (isWindows && project === "@do-soul/alaya-storage") return ["--maxWorkers=1"];
  return [];
}

function buildCoverageArgs(project, parsed) {
  if (!parsed.coverageEnabled) return [];
  const config = PROJECT_COVERAGE[project];
  const args = [];
  if (!parsed.hasCoverageReportsDirectoryArg) {
    args.push("--coverage.reportsDirectory", parsed.shard === undefined
      ? `coverage/${sanitizeProjectName(project)}` : benchShardPaths(parsed.shard).reports);
  }
  if (!parsed.hasCoverageIncludeArg && config?.include !== undefined) {
    args.push(`--coverage.include=${config.include}`);
  }
  if (!parsed.deferThresholds && !parsed.hasCoverageThresholdArg && config !== undefined) {
    args.push(
      `--coverage.thresholds.statements=${config.statements}`,
      `--coverage.thresholds.lines=${config.lines}`,
      `--coverage.thresholds.functions=${config.functions}`,
      `--coverage.thresholds.branches=${config.branches}`
    );
  }
  return args;
}
