import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const projectDirs = [
  "packages/protocol",
  "packages/graph-algorithms",
  "packages/eval",
  "packages/core",
  "packages/soul",
  "packages/engine-gateway",
  "packages/storage",
  "apps/core-daemon",
  "apps/inspector",
  "apps/bench-runner",
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

// Stamp build-info.json next to the built daemon. doctor.ts reads it so
// operators can tell which binary the running daemon was built from.
// git_head falls back to "unknown" when no .git is available (e.g. when
// users install from a release tarball that contains no .git directory).
const daemonDistDir = "apps/core-daemon/dist";
if (existsSync(daemonDistDir)) {
  const daemonPkg = JSON.parse(
    readFileSync("apps/core-daemon/package.json", "utf8")
  );
  const headResult = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  const gitHead =
    headResult.status === 0 && typeof headResult.stdout === "string"
      ? headResult.stdout.trim()
      : "unknown";
  const builtAt = resolveBuiltAt();
  const buildInfo = {
    version: typeof daemonPkg.version === "string" ? daemonPkg.version : "unknown",
    git_head: gitHead,
    built_at: builtAt
  };
  mkdirSync(daemonDistDir, { recursive: true });
  writeFileSync(
    join(daemonDistDir, "build-info.json"),
    `${JSON.stringify(buildInfo, null, 2)}\n`
  );
}

// Inspector SPA frontend lives in apps/inspector/web — separate Vite build.
// Without it, the release-built Inspector server serves an empty bundle.
const inspectorWebDir = "apps/inspector/web";
if (existsSync(join(inspectorWebDir, "package.json"))) {
  const inspectorWebBuild = spawnSync(
    "pnpm",
    ["--dir", inspectorWebDir, "build"],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  if (inspectorWebBuild.status !== 0) {
    process.exit(inspectorWebBuild.status ?? 1);
  }
}

process.exit(0);

function resolveBuiltAt() {
  const sourceDateEpoch = parseSourceDateEpoch(process.env.SOURCE_DATE_EPOCH);
  if (sourceDateEpoch !== null) {
    return sourceDateEpoch;
  }

  const commitTimestampResult = spawnSync("git", ["show", "-s", "--format=%cI", "HEAD"], {
    encoding: "utf8"
  });
  if (commitTimestampResult.status === 0 && typeof commitTimestampResult.stdout === "string") {
    const commitTimestamp = commitTimestampResult.stdout.trim();
    if (commitTimestamp.length > 0) {
      return commitTimestamp;
    }
  }

  return "unknown";
}

function parseSourceDateEpoch(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }

  const epoch = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(epoch)) {
    return null;
  }

  const epochMs = trimmed.length > 10 ? epoch : epoch * 1000;
  const builtAt = new Date(epochMs);
  return Number.isNaN(builtAt.getTime()) ? null : builtAt.toISOString();
}
