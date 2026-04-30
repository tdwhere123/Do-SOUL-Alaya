import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const projectDirs = [
  "packages/protocol",
  "packages/core",
  "packages/soul",
  "packages/engine-gateway",
  "packages/storage",
  "apps/core-daemon",
  "apps/inspector",
];

const projects = projectDirs.filter((dir) => existsSync(join(dir, "tsconfig.json")));

if (projects.length === 0) {
  console.log("No package tsconfig files found; build is a no-op until port cards land.");
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  ["./node_modules/typescript/bin/tsc", "-b", ...projects],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
