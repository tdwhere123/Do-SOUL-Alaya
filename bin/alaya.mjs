#!/usr/bin/env node
import { realpathSync } from "node:fs";
import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAlayaCliModuleLoaders,
  loadAlayaCliModules,
  runAlayaCli,
  SOFTWARE_EXIT_FALLBACK,
  resolveAlayaCliDistPaths
} from "../apps/core-daemon/dist/cli/module-loader.js";

export {
  createAlayaCliModuleLoaders,
  loadAlayaCliModules,
  runAlayaCli,
  SOFTWARE_EXIT_FALLBACK,
  resolveAlayaCliDistPaths
};

function isDirectExecution() {
  if (process.argv[1] === undefined) {
    return false;
  }
  return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
}

if (isDirectExecution()) {
  const exitCode = await runAlayaCli();
  // invariant: flush stdout/stderr before exit. macOS pipe buffers are small and a bare
  // process.exit() drops un-drained output, truncating large --json payloads (e.g. the
  // 16-tool `tools list --json`). write("",cb) fires after the stream buffer flushes.
  let pending = 2;
  const finish = () => {
    pending -= 1;
    if (pending === 0) process.exit(exitCode);
  };
  process.stdout.write("", finish);
  process.stderr.write("", finish);
}
