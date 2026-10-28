#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAlayaCli } from "../dist/cli/support/module-loader.js";

// The private package launcher shares the installed distribution's CLI authority.
export {
  createAlayaCliModuleLoaders,
  loadAlayaCliModules,
  runAlayaCli,
  SOFTWARE_EXIT_FALLBACK,
  resolveAlayaCliDistPaths
} from "../dist/cli/support/module-loader.js";

if (process.argv[1] !== undefined &&
    realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  const exitCode = await runAlayaCli();
  let pending = 2;
  const finish = () => {
    pending -= 1;
    if (pending === 0) process.exit(exitCode);
  };
  process.stdout.write("", finish);
  process.stderr.write("", finish);
}
