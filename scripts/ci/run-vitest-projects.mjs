#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const PROJECTS = [
  "@do-soul/alaya-protocol",
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

for (const project of PROJECTS) {
  console.log(`\n==> vitest project: ${project}`);
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.config.mjs",
      "--project",
      project,
      ...extraArgs
    ],
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
