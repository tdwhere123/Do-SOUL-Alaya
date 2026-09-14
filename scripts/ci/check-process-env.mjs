#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Scoped guard for packages + daemon. Edge modules may bind process.env once;
// shrink this list as call sites accept EnvLookup.
const SCOPED_ROOTS = [
  "packages/core/src",
  "packages/storage/src",
  "packages/engine-gateway/src",
  "packages/soul/src",
  "apps/core-daemon/src"
];

const ALLOWED_RELATIVE_PATHS = new Set([
  // Core/config edge: unfrozen getCoreConfig falls back to process env once.
  "packages/core/src/runtime/config/install-core-config.ts",
  // Campaign flags mutate process env for cross-boundary detection.
  "packages/core/src/recall/runtime/zero-live-extraction.ts",
  // Child-process spawn must clone the OS environment.
  "packages/core/src/embedding-recall/local-onnx-process/ipc-client.ts",
  // Child isolate binds the inherited OS environment once for ONNX session/lock knobs.
  "packages/core/src/embedding-recall/local-onnx-process/child.ts",
  // Platform machine-key path uses APPDATA / XDG_CONFIG_HOME.
  "packages/storage/src/repos/control/api-key-cipher.ts",
  // Daemon entry constructs EnvLookup once for the process.
  "apps/core-daemon/src/index.ts",
  // Daemon EnvLookup authority + processEnvLookup bind.
  "apps/core-daemon/src/runtime/config/daemon-config-environment.ts"
]);

const pattern = String.raw`process\.env`;

let raw = "";
try {
  raw = execFileSync(
    "rg",
    [
      "-n",
      ...SCOPED_ROOTS.flatMap((root) => ["--glob", `${root}/**/*.ts`]),
      "--glob", "!**/*.test.ts",
      "--glob", "!**/*.test-support.ts",
      "--glob", "!**/__tests__/**",
      "--glob", "!**/dist/**",
      "--glob", "!**/node_modules/**",
      "-e",
      pattern,
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
  console.error("Forbidden raw process.env in scoped packages (use EnvLookup injection):");
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log(`check-process-env: ok (allowlist ${ALLOWED_RELATIVE_PATHS.size})`);
