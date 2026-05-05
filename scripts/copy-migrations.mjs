#!/usr/bin/env node
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const src = join(repoRoot, "packages", "storage", "src", "migrations");
const dest = join(repoRoot, "packages", "storage", "dist", "migrations");

if (!existsSync(src)) {
  console.error(`Migrations source missing: ${src}`);
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`Copied SQL migrations: ${src} -> ${dest}`);
