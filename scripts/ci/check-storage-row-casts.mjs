#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const allowlistPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "storage-identity-row-parser-allowlist.json");

const IDENTITY_PARSER = String.raw`parse:\s*\(value(?::\s*unknown)?\)\s*=>\s*value as \w+Row`;
const ARRAY_CAST = String.raw`as \w+Row\[\]`;

const arrayCastRaw = rgOrEmpty(["-n", ARRAY_CAST, "packages/storage/src", "--glob", "!**/__tests__/**", "--glob", "!**/dist/**"]);
const arrayCastViolations = arrayCastRaw
  .trim()
  .split("\n")
  .filter(Boolean)
  .filter((line) => !line.includes("value as "));

if (arrayCastViolations.length > 0) {
  console.error("Forbidden unvalidated `as *Row[]` in storage production sources (use parseRows):");
  console.error(arrayCastViolations.join("\n"));
  process.exit(1);
}

const identityRaw = rgOrEmpty([
  "-n",
  IDENTITY_PARSER,
  "packages/storage/src",
  "--glob",
  "!**/__tests__/**",
  "--glob",
  "!**/dist/**"
]);
const identityHits = identityRaw
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const file = line.split(":")[0] ?? line;
    return { file, line };
  });

const allowlist = new Set(JSON.parse(readFileSync(allowlistPath, "utf8")));
const hitsByFile = new Map();
for (const hit of identityHits) {
  const list = hitsByFile.get(hit.file) ?? [];
  list.push(hit.line);
  hitsByFile.set(hit.file, list);
}

const violations = [];
for (const [file, lines] of [...hitsByFile.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  if (!allowlist.has(file)) {
    violations.push(`${file}: identity parseRows callback is forbidden (convert to a field parser):\n  ${lines.join("\n  ")}`);
  }
}

for (const file of [...allowlist].sort()) {
  if (!hitsByFile.has(file)) {
    violations.push(`${file}: identity-parser allowlist entry is unused; remove it`);
  }
}

if (violations.length > 0) {
  console.error("Forbidden identity `value as *Row` parseRows callbacks:");
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log(
  `check-storage-row-casts: ok (identity-parser allowlist ${allowlist.size} file(s); shrink toward zero)`
);

function rgOrEmpty(args) {
  try {
    return execFileSync("rg", args, { cwd: repoRoot, encoding: "utf8" });
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error ? error.status : null;
    if (status !== 1) throw error;
    return "";
  }
}
