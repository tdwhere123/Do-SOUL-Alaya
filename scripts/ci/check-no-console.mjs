#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Remaining production console.*/stderr.write sites owned by other workstreams.
// Shrink this list; do not add new entries. Guard wiring into package.json /
// CI workflows is owned by the ci-docs-install stream.
const ALLOWED_RELATIVE_PATHS = new Set([
  "packages/storage/src/sqlite/db.ts",
  "packages/eval/src/history/history.ts",
  "packages/eval/src/cli/cli.ts",
  "packages/soul/src/garden/scheduling/wall-clock-timeout.ts",
  "packages/soul/src/garden/triage/local-heuristics.ts",
  "packages/soul/src/garden/materialization/materialization-router/memory-routes.ts",
  "packages/soul/src/garden/materialization/materialization-router/path-side-effects.ts",
  "packages/soul/src/garden/ingestion/compute-provider.ts",
  "packages/soul/src/garden/ingestion/official-api/request-diagnostic.ts",
  "packages/core/src/memory/signal-service.ts",
  "apps/core-daemon/src/mcp/tool-runtime/tool-runtime.ts",
  "apps/core-daemon/src/garden/runtime/runtime.ts",
  "apps/core-daemon/src/mcp/catalog/mcp-catalog-parsing.ts",
  "apps/core-daemon/src/routes/shared/shared.ts",
  "apps/core-daemon/src/routes/workspace/run-snapshot/run-snapshot.ts",
  "apps/core-daemon/src/services/config/config-service.ts",
  "apps/core-daemon/src/runtime/daemon/lifecycle/daemon-runtime-lifecycle.ts",
  "apps/core-daemon/src/runtime/recall-read-worker/unexpected-queue-failure.ts"
]);

const patterns = [
  String.raw`console\.(log|warn|error|info|debug|trace)\s*\(`,
  String.raw`process\.stderr\.write\s*\(`
];

let raw = "";
try {
  raw = execFileSync(
    "rg",
    [
      "-n",
      "--glob", "packages/**/*.ts",
      "--glob", "apps/core-daemon/src/**/*.ts",
      "--glob", "!**/*.test.ts",
      "--glob", "!**/*.test-support.ts",
      "--glob", "!**/__tests__/**",
      "--glob", "!**/dist/**",
      "--glob", "!**/node_modules/**",
      ...patterns.flatMap((pattern) => ["-e", pattern]),
      "."
    ],
    { cwd: repoRoot, encoding: "utf8" }
  );
} catch (error) {
  const status = error && typeof error === "object" && "status" in error ? error.status : null;
  if (status !== 1) {
    throw error;
  }
}

const violations = raw
  .trim()
  .split("\n")
  .filter(Boolean)
  .filter((line) => {
    const split = line.indexOf(":");
    if (split === -1) {
      return false;
    }
    const file = line.slice(0, split).replace(/^\.\//, "");
    const rest = line.slice(split + 1);
    const second = rest.indexOf(":");
    const content = second === -1 ? rest : rest.slice(second + 1);
    const trimmed = content.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      return false;
    }
    return !ALLOWED_RELATIVE_PATHS.has(file);
  });

if (violations.length > 0) {
  console.error("Forbidden console.* / process.stderr.write in production sources:");
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("check-no-console: ok");
