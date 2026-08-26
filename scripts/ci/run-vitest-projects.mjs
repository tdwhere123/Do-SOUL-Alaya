#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const PROJECTS = [
  "@do-soul/alaya-protocol",
  "@do-soul/alaya-graph-algorithms",
  "@do-soul/alaya-storage",
  "@do-soul/alaya-core",
  "@do-soul/alaya-soul",
  "@do-soul/alaya-engine-gateway",
  "@do-soul/alaya-eval",
  "@do-soul/alaya-core-daemon",
  "@do-soul/alaya-inspector",
  "@do-soul/alaya-inspector-web",
  "@do-soul/alaya-bench-runner"
];

const extraArgs = process.argv.slice(2);
const isWindows = process.platform === "win32";
const childEnv = createChildEnv();
const coverageEnabled = extraArgs.some(
  (arg) => arg === "--coverage.enabled" || arg.startsWith("--coverage.enabled=")
);
const hasCoverageReportsDirectoryArg = extraArgs.some(
  (arg) =>
    arg === "--coverage.reportsDirectory" || arg.startsWith("--coverage.reportsDirectory=")
);
const hasCoverageIncludeArg = extraArgs.some(
  (arg) => arg === "--coverage.include" || arg.startsWith("--coverage.include=")
);
const hasCoverageThresholdArg = extraArgs.some((arg) => arg.startsWith("--coverage.thresholds."));

// Floors sit 3 points under isolated json-summary so a drop in one package
// cannot hide behind a stronger sibling. engine-gateway was already pinned.
const PROJECT_COVERAGE = {
  "@do-soul/alaya-protocol": {
    include: "packages/protocol/src/**",
    statements: 88, lines: 89, functions: 81, branches: 72
  },
  "@do-soul/alaya-graph-algorithms": {
    include: "packages/graph-algorithms/src/**",
    statements: 78, lines: 79, functions: 83, branches: 69
  },
  "@do-soul/alaya-storage": {
    include: "packages/storage/src/**",
    statements: 72, lines: 72, functions: 82, branches: 63
  },
  "@do-soul/alaya-core": {
    include: "packages/core/src/**",
    statements: 85, lines: 86, functions: 90, branches: 77
  },
  "@do-soul/alaya-soul": {
    include: "packages/soul/src/**",
    statements: 88, lines: 89, functions: 92, branches: 82
  },
  "@do-soul/alaya-engine-gateway": {
    include: "packages/engine-gateway/src/**",
    statements: 88, lines: 90, functions: 95, branches: 74
  },
  "@do-soul/alaya-eval": {
    include: "packages/eval/src/**",
    statements: 83, lines: 85, functions: 91, branches: 80
  },
  "@do-soul/alaya-core-daemon": {
    include: "apps/core-daemon/src/**",
    statements: 75, lines: 76, functions: 81, branches: 66
  },
  "@do-soul/alaya-inspector": {
    include: "apps/inspector/src/**",
    statements: 77, lines: 80, functions: 87, branches: 60
  },
  "@do-soul/alaya-inspector-web": {
    include: "apps/inspector/web/src/**",
    statements: 79, lines: 80, functions: 82, branches: 66
  },
  "@do-soul/alaya-bench-runner": {
    include: "apps/bench-runner/src/**",
    statements: 40, lines: 40, functions: 30, branches: 20
  }
};

for (const project of PROJECTS) {
  console.log(`\n==> vitest project: ${project}`);
  const result = spawnSync(
    "pnpm",
    buildVitestArgs(project),
    {
      env: childEnv,
      stdio: "inherit",
      shell: isWindows
    }
  );

  if (result.error) {
    console.error(`failed to start vitest for ${project}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function createChildEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_")) {
      delete env[key];
    }
  }
  return env;
}

function buildVitestArgs(project) {
  return [
    "exec",
    "vitest",
    "run",
    "--config",
    "vitest.config.mjs",
    "--project",
    project,
    ...extraArgs,
    ...buildCoverageArgs(project)
  ];
}

function buildCoverageArgs(project) {
  if (!coverageEnabled) {
    return [];
  }
  const config = PROJECT_COVERAGE[project];
  const args = [];
  if (!hasCoverageReportsDirectoryArg) {
    args.push("--coverage.reportsDirectory", `coverage/${sanitizeProjectName(project)}`);
  }
  if (!hasCoverageIncludeArg && config?.include !== undefined) {
    args.push(`--coverage.include=${config.include}`);
  }
  if (!hasCoverageThresholdArg && config !== undefined) {
    args.push(
      `--coverage.thresholds.statements=${config.statements}`,
      `--coverage.thresholds.lines=${config.lines}`,
      `--coverage.thresholds.functions=${config.functions}`,
      `--coverage.thresholds.branches=${config.branches}`
    );
  }
  return args;
}

function sanitizeProjectName(project) {
  return project.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
