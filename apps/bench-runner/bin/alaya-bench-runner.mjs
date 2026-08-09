#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { planBenchCliEnvProxyBootstrap } from "../dist/cli/proxy-bootstrap.js";

const argv = process.argv.slice(2);
const proxyPlan = planBenchCliEnvProxyBootstrap({
  argv,
  env: process.env,
  execArgv: process.execArgv,
  entryPath: fileURLToPath(import.meta.url),
  supportsEnvProxy: process.allowedNodeEnvironmentFlags.has("--use-env-proxy")
});

if (proxyPlan !== null) {
  process.exitCode = await runProxyBootstrap(proxyPlan);
} else {
  const { runCli } = await import("../dist/cli/index.js");
  process.exitCode = await runCli(argv);
}

function runProxyBootstrap(plan) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, plan.argv, {
      stdio: "inherit",
      env: plan.env
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
