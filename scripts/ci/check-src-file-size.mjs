#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_LINES = 500;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const files = execFileSync(
  "rg",
  [
    "--files",
    "-g",
    "**/src/**/*.ts",
    "-g",
    "**/src/**/*.tsx",
    "-g",
    "!**/__tests__/**",
    "-g",
    "!**/*.{test,spec}.ts",
    "-g",
    "!**/*.{test,spec}.tsx",
    "-g",
    "!**/dist/**",
    "-g",
    "!**/node_modules/**"
  ],
  { cwd: repoRoot, encoding: "utf8" }
)
  .trim()
  .split("\n")
  .filter(Boolean);

const oversized = [];
for (const rel of files) {
  const abs = path.join(repoRoot, rel);
  const text = readFileSync(abs, "utf8");
  const lines = text.length === 0 ? 0 : text.split(/\r?\n/).length;
  if (lines > MAX_LINES) {
    oversized.push({ rel, lines });
  }
}

if (oversized.length > 0) {
  oversized.sort((left, right) => right.lines - left.lines);
  console.error(`Production src files over ${MAX_LINES} lines:`);
  for (const file of oversized) {
    console.error(`  ${file.lines}\t${file.rel}`);
  }
  process.exit(1);
}

console.log(`check-src-file-size: ok (0 files over ${MAX_LINES} lines)`);
