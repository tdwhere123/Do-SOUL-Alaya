#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const allowlistPath = path.join(scriptDir, "production-unknown-as-allowlist.json");
const selfTest = process.argv.includes("--self-test");

if (selfTest) {
  runSelfTest();
} else {
  const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
  const exitCode = reportUnknownAs(scanProductionUnknownAs(repoRoot), allowlist, repoRoot);
  process.exit(exitCode);
}

function runSelfTest() {
  const dir = mkdtempSync(path.join(tmpdir(), "alaya-production-unknown-as-"));
  const production = path.join(dir, "apps", "core-daemon", "src", "example.ts");
  const testFile = path.join(dir, "apps", "core-daemon", "src", "__tests__", "example.test.ts");
  mkdirSync(path.dirname(production), { recursive: true });
  mkdirSync(path.dirname(testFile), { recursive: true });
  writeFileSync(production, "export const value = 1 as unknown as string;\n");
  writeFileSync(testFile, "export const value = 1 as unknown as string;\n");
  try {
    const matches = scanProductionUnknownAs(dir);
    const productionHit = matches.some(
      (entry) => entry.file.endsWith("apps/core-daemon/src/example.ts") && entry.count === 1
    );
    const testHit = matches.some((entry) => entry.file.includes("__tests__"));
    if (!productionHit || testHit) {
      console.error(
        "check-production-unknown-as --self-test: expected one production hit and no test hits"
      );
      process.exit(1);
    }
    const exitCode = reportUnknownAs(matches, {}, dir);
    if (exitCode !== 1) {
      console.error(`check-production-unknown-as --self-test: expected exit 1, got ${exitCode}`);
      process.exit(1);
    }
    console.log("check-production-unknown-as --self-test: ok (production as unknown as exits 1)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function scanProductionUnknownAs(root) {
  const files = listProductionFiles(root);
  const matches = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const count = countUnknownAs(source);
    if (count > 0) {
      matches.push({ file: path.relative(root, file).split(path.sep).join("/"), count });
    }
  }
  return matches.sort((left, right) => left.file.localeCompare(right.file));
}

function listProductionFiles(root) {
  const roots = ["packages", "apps"].filter((entry) => existsSync(path.join(root, entry)));
  if (roots.length === 0) {
    return [];
  }
  try {
    return execFileSync(
      "rg",
      [
        "--files",
        "-g",
        "*.ts",
        "-g",
        "*.tsx",
        "-g",
        "*.mts",
        "-g",
        "*.cts",
        "-g",
        "*.js",
        "-g",
        "*.mjs",
        "-g",
        "!**/node_modules/**",
        "-g",
        "!**/dist/**",
        "-g",
        "!**/coverage/**",
        "-g",
        "!**/__tests__/**",
        "-g",
        "!**/*.test.ts",
        "-g",
        "!**/*.test.tsx",
        "-g",
        "!**/*.test-support.ts",
        "-g",
        "!**/src/test/**",
        ...roots
      ],
      { cwd: root, encoding: "utf8" }
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((file) => path.resolve(root, file));
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error ? error.status : null;
    if (status === 1) return [];
    throw error;
  }
}

function countUnknownAs(source) {
  const stripped = stripCommentsAndStrings(source);
  const pattern = /\bas unknown as\b/g;
  let count = 0;
  while (pattern.exec(stripped) !== null) {
    count += 1;
  }
  return count;
}

function stripCommentsAndStrings(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => " ".repeat(block.length))
    .replace(/(^|[^:])\/\/.*$/gm, (line, prefix) => `${prefix}${" ".repeat(line.length - prefix.length)}`)
    .replace(/`(?:\\.|[^\\`])*`/g, (block) => " ".repeat(block.length))
    .replace(/"(?:\\.|[^"\\])*"/g, (block) => " ".repeat(block.length))
    .replace(/'(?:\\.|[^'\\])*'/g, (block) => " ".repeat(block.length));
}

function reportUnknownAs(matches, allowlist, rootLabel) {
  const unused = new Set(Object.keys(allowlist));
  const violations = [];
  let total = 0;
  for (const entry of matches) {
    total += entry.count;
    const allowed = allowlist[entry.file];
    unused.delete(entry.file);
    if (allowed === undefined) {
      violations.push(`${entry.file}: ${entry.count} as-unknown-as (no allowlist reason)`);
      continue;
    }
    if (entry.count > allowed.max) {
      violations.push(
        `${entry.file}: ${entry.count} as-unknown-as exceeds allowlist max ${allowed.max} (${allowed.reason})`
      );
    }
  }
  for (const file of [...unused].sort()) {
    violations.push(`${file}: allowlist entry is unused; remove it (${allowlist[file].reason})`);
  }
  if (violations.length > 0) {
    console.error(`Forbidden production as-unknown-as (${rootLabel}):`);
    for (const line of violations) console.error(`  ${line}`);
    return 1;
  }
  console.log(
    `check-production-unknown-as: ok (${matches.length} allowlisted file(s), ${total} remaining; tests are out of scope)`
  );
  return 0;
}
