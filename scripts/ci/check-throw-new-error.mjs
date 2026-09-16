#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const allowlistPath = path.join(scriptDir, "production-throw-new-error-allowlist.json");
const selfTest = process.argv.includes("--self-test");
const writeAllowlist = process.argv.includes("--write-allowlist");

if (selfTest) {
  runSelfTest();
} else if (writeAllowlist) {
  writeCurrentAllowlist();
} else {
  const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
  const exitCode = reportThrows(scanProductionThrows(repoRoot), allowlist, repoRoot);
  process.exit(exitCode);
}

function runSelfTest() {
  const dir = mkdtempSync(path.join(tmpdir(), "alaya-throw-new-error-"));
  const production = path.join(dir, "apps", "core-daemon", "src", "example.ts");
  const testFile = path.join(dir, "apps", "core-daemon", "src", "__tests__", "example.test.ts");
  mkdirSync(path.dirname(production), { recursive: true });
  mkdirSync(path.dirname(testFile), { recursive: true });
  writeFileSync(production, 'throw new Error("boom");\n');
  writeFileSync(testFile, 'throw new Error("boom");\n');
  try {
    const matches = scanProductionThrows(dir);
    const productionHit = matches.some(
      (entry) => entry.file.endsWith("apps/core-daemon/src/example.ts") && entry.count === 1
    );
    const testHit = matches.some((entry) => entry.file.includes("__tests__"));
    if (!productionHit || testHit) {
      console.error("check-throw-new-error --self-test: expected one production hit and no test hits");
      process.exit(1);
    }
    const exitCode = reportThrows(matches, {}, dir);
    if (exitCode !== 1) {
      console.error(`check-throw-new-error --self-test: expected exit 1, got ${exitCode}`);
      process.exit(1);
    }
    console.log("check-throw-new-error --self-test: ok (production throw new Error exits 1)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeCurrentAllowlist() {
  const matches = scanProductionThrows(repoRoot);
  const allowlist = {};
  for (const entry of matches) {
    allowlist[entry.file] = {
      max: entry.count,
      reason: "remaining production throw new Error; convert to AlayaError family"
    };
  }
  writeFileSync(allowlistPath, `${JSON.stringify(allowlist, null, 2)}\n`);
  console.log(`wrote ${matches.length} allowlist file(s) to ${path.relative(repoRoot, allowlistPath)}`);
}

function scanProductionThrows(root) {
  const files = listProductionFiles(root);
  const matches = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const count = countThrowNewError(source);
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

function countThrowNewError(source) {
  const stripped = stripCommentsAndStrings(source);
  const pattern = /\bthrow\s+new\s+Error\s*\(/g;
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

function reportThrows(matches, allowlist, rootLabel) {
  const unused = new Set(Object.keys(allowlist));
  const violations = [];
  let total = 0;
  for (const entry of matches) {
    total += entry.count;
    const allowed = allowlist[entry.file];
    unused.delete(entry.file);
    if (allowed === undefined) {
      violations.push(`${entry.file}: ${entry.count} throw-new-Error (no allowlist reason)`);
      continue;
    }
    if (entry.count > allowed.max) {
      violations.push(
        `${entry.file}: ${entry.count} throw-new-Error exceeds allowlist max ${allowed.max} (${allowed.reason})`
      );
    }
  }
  for (const file of [...unused].sort()) {
    violations.push(`${file}: allowlist entry is unused; remove it (${allowlist[file].reason})`);
  }
  if (violations.length > 0) {
    console.error(`Forbidden production throw new Error (${rootLabel}):`);
    for (const line of violations) console.error(`  ${line}`);
    return 1;
  }
  console.log(
    `check-throw-new-error: ok (${matches.length} allowlisted file(s), ${total} remaining; convert to AlayaError family)`
  );
  return 0;
}
