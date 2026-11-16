#!/usr/bin/env node
import { runDirectAlayaCli } from "../dist/cli/support/module-loader.js";

// The private package launcher shares the installed distribution's CLI authority.
export {
  createAlayaCliModuleLoaders,
  loadAlayaCliModules,
  runAlayaCli,
  SOFTWARE_EXIT_FALLBACK,
  resolveAlayaCliDistPaths
} from "../dist/cli/support/module-loader.js";

await runDirectAlayaCli(import.meta.url);
