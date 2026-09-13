#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const allowlistPath = path.join(scriptDir, "test-as-any-allowlist.json");
const selfTest = process.argv.includes("--self-test");

if (selfTest) {
  runSelfTest();
} else {
  const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
  const exitCode = reportTypeAny(scanTypeAny(repoRoot), allowlist, repoRoot);
  process.exit(exitCode);
}

function runSelfTest() {
  const dir = mkdtempSync(path.join(tmpdir(), "alaya-test-as-any-"));
  const fixture = path.join(dir, "record-string-any.test.ts");
  writeFileSync(fixture, "export type Fixture = Record<string, any>;\n");
  try {
    const matches = scanTypeAny(dir);
    const hit = matches.some((entry) => entry.file.endsWith("record-string-any.test.ts") && entry.count > 0);
    if (!hit) {
      console.error("check-test-as-any --self-test: Record<string, any> was not detected");
      process.exit(1);
    }
    const exitCode = reportTypeAny(matches, {}, dir);
    if (exitCode !== 1) {
      console.error(`check-test-as-any --self-test: expected exit 1, got ${exitCode}`);
      process.exit(1);
    }
    console.log("check-test-as-any --self-test: ok (Record<string, any> exits 1)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function scanTypeAny(root) {
  const files = listTestFiles(root);
  const matches = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const count = countTypeAny(source);
    if (count > 0) {
      matches.push({ file: path.relative(root, file).split(path.sep).join("/"), count });
    }
  }
  return matches.sort((left, right) => left.file.localeCompare(right.file));
}

function listTestFiles(root) {
  try {
    return execFileSync(
      "rg",
      [
        "--files",
        "-g",
        "*test*.ts",
        "-g",
        "*test*.tsx",
        "-g",
        "**/__tests__/**/*.ts",
        "-g",
        "**/__tests__/**/*.tsx",
        "-g",
        "!**/node_modules/**",
        "-g",
        "!**/dist/**",
        "."
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

function countTypeAny(source) {
  const stripped = stripCommentsAndStrings(source);
  const pattern = /(?<![\w$])any(?![\w$])/g;
  let count = 0;
  let match;
  while ((match = pattern.exec(stripped)) !== null) {
    if (isTypeAny(stripped, match.index)) count += 1;
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

function isTypeAny(source, index) {
  const before = source.slice(0, index).trimEnd();
  const after = source.slice(index + 3).trimStart();
  const beforeChar = before.slice(-1);
  const afterChar = after.slice(0, 1);
  return (
    /\bas$/u.test(before) ||
    ":<|&,=([".includes(beforeChar) ||
    ":>|&,)][".includes(afterChar) ||
    after.startsWith("[]")
  );
}

function reportTypeAny(matches, allowlist, rootLabel) {
  const unused = new Set(Object.keys(allowlist));
  const violations = [];
  for (const entry of matches) {
    const allowed = allowlist[entry.file];
    unused.delete(entry.file);
    if (allowed === undefined) {
      violations.push(`${entry.file}: ${entry.count} type-any token(s) (no allowlist reason)`);
      continue;
    }
    if (entry.count > allowed.max) {
      violations.push(
        `${entry.file}: ${entry.count} type-any token(s) exceeds allowlist max ${allowed.max} (${allowed.reason})`
      );
    }
  }
  for (const file of [...unused].sort()) {
    violations.push(`${file}: allowlist entry is unused; remove it (${allowlist[file].reason})`);
  }
  if (violations.length > 0) {
    console.error(`Forbidden type erasure in test files (${rootLabel}):`);
    for (const line of violations) console.error(`  ${line}`);
    return 1;
  }
  console.log(`check-test-as-any: ok (${matches.length} allowlisted file(s), 0 unreasoned type-any tokens)`);
  return 0;
}
