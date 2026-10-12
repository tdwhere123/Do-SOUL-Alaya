#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { PROJECT_COVERAGE, projectsForGroup, sanitizeProjectName } from "./vitest-projects.mjs";

const parsed = parseArgs(process.argv.slice(2));
const selected = projectsForGroup(parsed.group);
const isWindows = process.platform === "win32";
const childEnv = createChildEnv(parsed.coverageEnabled);
const completed = [];

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
  const deferThresholds = argv.includes("--defer-coverage-thresholds");
  const vitestArgs = argv.filter((arg) => arg !== "--defer-coverage-thresholds" && !arg.startsWith("--group="));
  return {
    group: groupArg?.slice("--group=".length),
    deferThresholds,
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
    projectsFile: process.env.ALAYA_SHARD_PROJECTS
  };
}

function recordCompleted(projectsFile, projects) {
  if (projectsFile === undefined) return;
  writeFileSync(projectsFile, `${JSON.stringify({ projects })}\n`);
}

function createChildEnv(coverageEnabled) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_")) delete env[key];
  }
  // vitest.config.mjs budgets ~3.5 GiB/worker (~7 GiB under coverage). Node's
  // default old-space is ~2 GiB and coverage + live daemon fixtures exceed it.
  if (!/(?:^|\s)--max-old-space-size=/.test(env.NODE_OPTIONS ?? "")) {
    const heapMb = coverageEnabled ? 6144 : 3584;
    env.NODE_OPTIONS = [env.NODE_OPTIONS, `--max-old-space-size=${heapMb}`]
      .filter((part) => part !== undefined && part.length > 0)
      .join(" ");
  }
  return env;
}

function buildVitestArgs(project, parsed) {
  return [
    "exec", "vitest", "run", "--config", "vitest.config.mjs", "--project", project,
    ...parsed.vitestArgs,
    ...buildCoverageArgs(project, parsed),
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
    args.push("--coverage.reportsDirectory", `coverage/${sanitizeProjectName(project)}`);
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
