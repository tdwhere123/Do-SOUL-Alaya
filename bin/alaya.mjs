#!/usr/bin/env node
import { runDirectAlayaCli } from "../apps/core-daemon/dist/cli/support/module-loader.js";

export {
  createAlayaCliModuleLoaders,
  loadAlayaCliModules,
  runAlayaCli,
  SOFTWARE_EXIT_FALLBACK,
  resolveAlayaCliDistPaths
} from "../apps/core-daemon/dist/cli/support/module-loader.js";

await runDirectAlayaCli(import.meta.url);
