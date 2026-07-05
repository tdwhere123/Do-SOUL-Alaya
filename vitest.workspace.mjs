import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

const sharedAlias = {
  "@do-soul/alaya-protocol": path.resolve(rootDir, "packages/protocol/src/index.ts"),
  "@do-soul/alaya-graph-algorithms": path.resolve(rootDir, "packages/graph-algorithms/src/index.ts"),
  "@do-soul/alaya-storage": path.resolve(rootDir, "packages/storage/src/index.ts"),
  "@do-soul/alaya-core": path.resolve(rootDir, "packages/core/src/index.ts"),
  "@do-soul/alaya-soul": path.resolve(rootDir, "packages/soul/src/index.ts"),
  "@do-soul/alaya-engine-gateway": path.resolve(rootDir, "packages/engine-gateway/src/index.ts")
};

// see also: apps/bench-runner — bench-runner-only aliases; cross-app import boundary
// Subpath aliases must come before the bare @do-soul/alaya entry so the more
// specific keys match first (Vite resolves alias entries in array order).
const benchRunnerAlias = [
  ...Object.entries(sharedAlias).map(([find, replacement]) => ({ find, replacement })),
  { find: "@do-soul/alaya/mcp-server", replacement: path.resolve(rootDir, "apps/core-daemon/src/mcp/mcp-server.ts") },
  { find: "@do-soul/alaya/cli/bridge", replacement: path.resolve(rootDir, "apps/core-daemon/src/cli/bridge.ts") },
  { find: "@do-soul/alaya/cli/register", replacement: path.resolve(rootDir, "apps/core-daemon/src/cli/register.ts") },
  {
    find: "@do-soul/alaya/recall/bound-execution",
    replacement: path.resolve(rootDir, "apps/core-daemon/src/recall/recall-bound-execution.ts")
  },
  { find: "@do-soul/alaya", replacement: path.resolve(rootDir, "apps/core-daemon/src/index.ts") },
  { find: "@do-soul/alaya-eval", replacement: path.resolve(rootDir, "packages/eval/src/index.ts") }
];

function packageProject(name, packageDir, options = {}) {
  const packageRoot = path.resolve(rootDir, packageDir);
  const testDir = path.resolve(rootDir, packageDir, "src/__tests__");
  if (!existsSync(path.resolve(packageRoot, "package.json"))) {
    return null;
  }

  return defineProject({
    resolve: {
      alias: sharedAlias
    },
    test: {
      name,
      environment: "node",
      include: [path.resolve(testDir, "**/*.{test,spec}.ts")],
      exclude: ["**/dist/**"],
      ...options
    }
  });
}

function appProject(name, appDir) {
  const appRoot = path.resolve(rootDir, appDir);
  const testDir = path.resolve(rootDir, appDir, "src/__tests__");
  if (!existsSync(path.resolve(appRoot, "package.json"))) {
    return null;
  }

  return defineProject({
    resolve: {
      alias: sharedAlias
    },
    test: {
      name,
      environment: "node",
      include: [path.resolve(testDir, "**/*.{test,spec}.ts")],
      exclude: ["**/dist/**"]
    }
  });
}

export default [
  packageProject("@do-soul/alaya-protocol", "packages/protocol"),
  packageProject("@do-soul/alaya-graph-algorithms", "packages/graph-algorithms"),
  packageProject("@do-soul/alaya-storage", "packages/storage"),
  packageProject("@do-soul/alaya-core", "packages/core", {
    setupFiles: [path.resolve(rootDir, "packages/core/vitest.setup.ts")]
  }),
  packageProject("@do-soul/alaya-soul", "packages/soul"),
  packageProject("@do-soul/alaya-engine-gateway", "packages/engine-gateway"),
  packageProject("@do-soul/alaya-eval", "packages/eval"),
  appProject("@do-soul/alaya-core-daemon", "apps/core-daemon"),
  appProject("@do-soul/alaya-inspector", "apps/inspector"),
  // see also: apps/inspector/web/vitest.config.ts — jsdom env + RTL setup
  path.resolve(rootDir, "apps/inspector/web/vitest.config.ts"),
  (() => {
    const appRoot = path.resolve(rootDir, "apps/bench-runner");
    const testDir = path.resolve(rootDir, "apps/bench-runner/src/__tests__");
    if (!existsSync(path.resolve(appRoot, "package.json"))) return null;
    return defineProject({
      resolve: { alias: benchRunnerAlias },
      test: {
        name: "@do-soul/alaya-bench-runner",
        environment: "node",
        setupFiles: [path.resolve(appRoot, "src/__tests__/vitest-setup.ts")],
        include: [path.resolve(testDir, "**/*.{test,spec}.ts")],
        exclude: ["**/dist/**"]
      }
    });
  })()
].filter(Boolean);
