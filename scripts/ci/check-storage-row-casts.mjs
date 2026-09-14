#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let raw = "";
try {
  raw = execFileSync(
    "rg",
    [
      "-n",
      String.raw`as \w+Row\[\]`,
      "packages/storage/src",
      "--glob", "!**/__tests__/**",
      "--glob", "!**/dist/**"
    ],
    { cwd: repoRoot, encoding: "utf8" }
  );
} catch (error) {
  const status = error && typeof error === "object" && "status" in error ? error.status : null;
  if (status !== 1) throw error;
}

const violations = raw
  .trim()
  .split("\n")
  .filter(Boolean)
  .filter((line) => !line.includes("value as ") && !line.includes("parse: (value"));

if (violations.length > 0) {
  console.error("Forbidden unvalidated `as *Row[]` in storage production sources (use parseRows/selectRows):");
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("check-storage-row-casts: ok");
