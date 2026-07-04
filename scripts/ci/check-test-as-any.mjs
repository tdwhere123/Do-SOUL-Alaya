#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const patterns = [String.raw`\bas any\b`];

let files = [];
try {
  files = execFileSync(
    "rg",
    [
      "--files-with-matches",
      "-g",
      "*test*.ts",
      "-g",
      "!**/node_modules/**",
      "-g",
      "!**/dist/**",
      ...patterns.flatMap((pattern) => ["-e", pattern]),
      "."
    ],
    { cwd: repoRoot, encoding: "utf8" }
  )
    .trim()
    .split("\n")
    .filter(Boolean);
} catch (error) {
  const status = error && typeof error === "object" && "status" in error ? error.status : null;
  if (status !== 1) {
    throw error;
  }
}

if (files.length > 0) {
  const details = execFileSync(
    "rg",
    [
      "-n",
      "-g",
      "*test*.ts",
      "-g",
      "!**/node_modules/**",
      "-g",
      "!**/dist/**",
      ...patterns.flatMap((pattern) => ["-e", pattern]),
      "."
    ],
    { cwd: repoRoot, encoding: "utf8" }
  ).trim();

  console.error("Forbidden type erasure in test files:");
  console.error(details);
  process.exit(1);
}

console.log("check-test-as-any: ok (0 matches in *test*.ts)");
