#!/usr/bin/env node
import path from "node:path";
import { resolveAlayaConfigDir, resolveConfiguredDatabasePath } from "./configured-paths.mjs";

const configDir = resolveAlayaConfigDir(process.env);
if (process.argv.includes("--config-dir")) {
  process.stdout.write(`${configDir}\n`);
} else {
  // Resolve before the installer changes into staging: relative paths belong to
  // the daemon's launch directory, never the install or configuration tree.
  const dbPath = resolveConfiguredDatabasePath(
    path.join(configDir, "alaya.toml"), process.env, path.join(configDir, "alaya.db")
  );
  process.stdout.write(`${configDir}\t${dbPath}\n`);
}
