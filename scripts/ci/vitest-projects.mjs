import { createHash } from "node:crypto";
import durations from "./bench-test-durations.json" with { type: "json" };

/** Vitest projects Quality runs, and the floors checked after coverage is assembled. */

export const VITEST_PROJECTS = [
  "@do-soul/alaya-protocol",
  "@do-soul/alaya-graph-algorithms",
  "@do-soul/alaya-cjk-segmentation",
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

const HEAVY = new Set([
  "@do-soul/alaya-core-daemon",
  "@do-soul/alaya-bench-runner"
]);

/** One machine was summing these projects past the 60 minute job cap. */
export const VITEST_PROJECT_GROUPS = {
  libraries: VITEST_PROJECTS.filter((project) => !HEAVY.has(project)),
  "core-daemon": ["@do-soul/alaya-core-daemon"],
  "bench-runner": ["@do-soul/alaya-bench-runner"]
};

// Floors sit 3 points under isolated json-summary so a drop in one package
// cannot hide behind a stronger sibling. engine-gateway was already pinned.
export const PROJECT_COVERAGE = {
  "@do-soul/alaya-protocol": {
    include: "packages/protocol/src/**",
    statements: 88, lines: 89, functions: 81, branches: 72
  },
  "@do-soul/alaya-graph-algorithms": {
    include: "packages/graph-algorithms/src/**",
    statements: 78, lines: 79, functions: 83, branches: 69
  },
  "@do-soul/alaya-cjk-segmentation": {
    include: "packages/cjk-segmentation/src/**",
    statements: 91, lines: 91, functions: 89, branches: 83
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
    statements: 65, lines: 65, functions: 52, branches: 45
  }
};

export function sanitizeProjectName(project) {
  return project.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function projectsForGroup(group) {
  if (group === undefined) return VITEST_PROJECTS;
  const selected = VITEST_PROJECT_GROUPS[group];
  if (selected === undefined) {
    throw new Error(`unknown vitest project group ${group}`);
  }
  return selected;
}

export function parseShard(shard) {
  const match = /^(\d+)\/(\d+)$/u.exec(shard ?? "");
  if (match === null) return undefined;
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (!Number.isSafeInteger(count) || count < 1 || index < 1 || index > count) return undefined;
  return { index, count };
}

export function benchShardPaths({ index, count }) {
  const name = `bench-${index}-of-${count}`;
  return {
    partition: `.cache/ci-shards/${name}.json`,
    reports: `.cache/ci-shards/${name}-coverage`,
    blob: `coverage/${name}.json`
  };
}

export function filesDigest(files) {
  return createHash("sha256").update(JSON.stringify([...files].sort())).digest("hex");
}

export function partitionBenchFiles(files, count, weights = durations.weights, unknownWeight = durations.unknownFileSeconds) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("invalid shard count");
  if (new Set(files).size !== files.length) throw new Error("duplicate test file");
  const entries = files.map((file) => ({ file, weight: weights[file] ?? unknownWeight }));
  if (entries.some(({ weight }) => !Number.isFinite(weight) || weight <= 0)) {
    throw new Error("invalid test duration weight");
  }
  entries.sort((a, b) => b.weight - a.weight || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const bins = Array.from({ length: count }, () => ({ files: [], weight: 0 }));
  for (const { file, weight } of entries) {
    const lightest = bins.reduce((a, b) => a.weight <= b.weight ? a : b);
    lightest.files.push(file);
    lightest.weight += weight;
  }
  return bins.map(({ files: assigned }) => assigned);
}

export function createVitestEnv(coverageEnabled, source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_")) delete env[key];
  }
  // vitest.config.mjs budgets ~3.5 GiB/worker (~7 GiB under coverage). Node's
  // default old-space is ~2 GiB and coverage + live daemon fixtures exceed it.
  delete env.ALAYA_SHARD_PROJECTS;
  if (!/(?:^|\s)--max-old-space-size=/.test(env.NODE_OPTIONS ?? "")) {
    const heapMb = coverageEnabled ? 6144 : 3584;
    env.NODE_OPTIONS = [env.NODE_OPTIONS, `--max-old-space-size=${heapMb}`]
      .filter((part) => part !== undefined && part.length > 0)
      .join(" ");
  }
  return env;
}
