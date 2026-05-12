import { existsSync, rmSync } from "node:fs";
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

for (const project of projects) {
  rmSync(join(project, "dist"), { recursive: true, force: true });
  rmSync(join(project, "tsconfig.tsbuildinfo"), { force: true });
}

const result = spawnSync(
  process.execPath,
  ["./node_modules/typescript/bin/tsc", "-b", ...projects],
  { stdio: "inherit" },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

// Storage migrations are SQL files that tsc does not copy. Without this, a
// release/source build cannot bootstrap a fresh DB.
const copyMigrations = spawnSync(
  process.execPath,
  ["./scripts/copy-migrations.mjs"],
  { stdio: "inherit" },
);

if (copyMigrations.status !== 0) {
  process.exit(copyMigrations.status ?? 1);
}

// Inspector SPA frontend lives in apps/inspector/web — separate Vite build.
// Without it, the release-built Inspector server serves an empty bundle.
const inspectorWebDir = "apps/inspector/web";
if (existsSync(join(inspectorWebDir, "package.json"))) {
  const inspectorWebBuild = spawnSync(
    "pnpm",
    ["--dir", inspectorWebDir, "build"],
    { stdio: "inherit" },
  );
  if (inspectorWebBuild.status !== 0) {
    process.exit(inspectorWebBuild.status ?? 1);
  }
}

process.exit(0);
