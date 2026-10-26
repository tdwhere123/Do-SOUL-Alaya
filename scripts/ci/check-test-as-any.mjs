#!/usr/bin/env node
import { strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "@typescript/typescript6";

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
  const cases = [
    ["export type Fixture = Record<string, any>;", 1],
    ["const erased = value as any; const angle = <any>value;", 2],
    ["let values: any[]; type Result = Promise<any> | any;", 3],
    ["type Choice<T> = T extends string ? any : never;", 1],
    ["type Fields = { any: any; [key: string]: any };", 2],
    ["const result = { any: false, all: false }; expect(result).toEqual({ any: true });", 0],
    ["type Score = { any: boolean }; type Key = keyof Score;", 0],
    ["const any = false; const result = { any }; expect.any(String);", 0],
    ["// as any\nconst text = 'any'; const template = `any`; /* Record<string, any> */", 0],
    ["const template = `value: ${value as any}`;", 1],
    ["const element = <div any={value as any}>any</div>;", 1, "fixture.test.tsx"]
  ];
  for (const [source, count, file] of cases) strictEqual(countTypeAny(source, file), count, source);
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
    const count = countTypeAny(source, file);
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

function countTypeAny(source, filename = "test.ts") {
  // Property names such as { any: false } are identifiers, not type erasure.
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest);
  let count = 0;
  function visit(node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword) count += 1;
    ts.forEachChild(node, visit);
  }
  visit(file);
  return count;
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
