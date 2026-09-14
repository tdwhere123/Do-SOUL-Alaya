#!/usr/bin/env node
// Light handbook guard: backtick `docs/**` paths must exist, and invariant §24
// must list the live CLI verbs from apps/core-daemon/src/cli.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_CLI_VERBS = Object.freeze([
  "attach",
  "backup",
  "detach",
  "doctor",
  "export",
  "import",
  "inspect",
  "install",
  "mcp",
  "review",
  "source-grounding-defers",
  "status",
  "temporal-cutover",
  "tools",
  "update"
]);

const errors = [];
checkDocPaths();
checkCliVerbs();

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`doc-links: ${error}\n`);
  process.exit(1);
}

console.log(
  `check-doc-links: ok (${LIVE_CLI_VERBS.length} CLI verbs, backtick docs/** paths exist)`
);

function checkDocPaths() {
  const files = listMarkdownFiles(repoRoot);
  const seen = new Set();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/`((?:docs|scripts)\/[^`]+)`/g)) {
      const raw = match[1];
      const relative = raw
        .split(/[\s#§]/u)[0]
        ?.replace(/:(?:\d+(?:-\d+)?)(?:,\d+(?:-\d+)?)*$/u, "")
        .replace(/[.,;:]+$/u, "") ?? "";
      if (relative.includes("*") || relative.includes("<") || relative.endsWith("/")) continue;
      const key = `${path.relative(repoRoot, file)}:${relative}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const target = path.join(repoRoot, relative);
      if (!existsSync(target)) {
        errors.push(`${path.relative(repoRoot, file)} references missing ${relative}`);
      }
    }
  }
}

function checkCliVerbs() {
  const registered = listRegisteredCliVerbs();
  const expected = new Set(LIVE_CLI_VERBS);
  for (const verb of expected) {
    if (!registered.has(verb)) errors.push(`CLI verb ${verb} is not registered under apps/core-daemon/src/cli`);
  }
  for (const verb of [...registered].sort()) {
    if (!expected.has(verb)) errors.push(`CLI registers unknown verb ${verb}; update the handbook list`);
  }

  const invariants = readFileSync(path.join(repoRoot, "docs/handbook/invariants.md"), "utf8");
  const section = extractSection24(invariants);
  if (section === null) {
    errors.push("docs/handbook/invariants.md is missing §24");
    return;
  }
  for (const verb of LIVE_CLI_VERBS) {
    if (!section.includes(verb)) {
      errors.push(`invariants.md §24 does not list CLI verb ${verb}`);
    }
  }
  for (const ghost of ["profile", "secrets", "trust-state", "inspector-server", "inspector-frontend"]) {
    if (new RegExp(`\\b${ghost}\\b`, "u").test(section)) {
      errors.push(`invariants.md §24 still lists retired CLI verb ${ghost}`);
    }
  }
}

function listRegisteredCliVerbs() {
  const names = new Set();
  for (const file of listFiles(path.join(repoRoot, "apps/core-daemon/src/cli"), ".ts")) {
    if (file.includes(`${path.sep}__tests__${path.sep}`) || file.endsWith(".test.ts")) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bname:\s*"([a-z][a-z0-9-]*)"/g)) {
      names.add(match[1]);
    }
    for (const match of source.matchAll(/createArtifactCommand\("([a-z][a-z0-9-]*)"/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

function extractSection24(source) {
  const start = source.search(/^24\.\s/m);
  if (start < 0) return null;
  const rest = source.slice(start);
  const next = rest.search(/\n25\.\s/);
  return next < 0 ? rest : rest.slice(0, next);
}

function listMarkdownFiles(root) {
  const files = [];
  visit(root, (file) => {
    if (file.endsWith(".md")) files.push(file);
  });
  return files;
}

function listFiles(root, suffix) {
  const files = [];
  visit(root, (file) => {
    if (file.endsWith(suffix)) files.push(file);
  });
  return files;
}

function visit(dir, onFile) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === ".git" ||
      entry.name === ".pnpm-store" ||
      entry.name === ".do-it"
    ) {
      continue;
    }
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      visit(child, onFile);
      continue;
    }
    if (entry.isSymbolicLink()) {
      let stats;
      try {
        stats = statSync(child);
      } catch {
        continue;
      }
      if (stats.isFile()) onFile(child);
      continue;
    }
    if (entry.isFile()) onFile(child);
  }
}
