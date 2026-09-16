#!/usr/bin/env node
// Bidirectional env-doc guard:
//   registry ⊆ .env.example
//   documented keys ⊆ registry ∪ whitelist
//   every documented key has a production read site
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const envExamplePath = path.join(repoRoot, ".env.example");
const registryFiles = [
  "packages/core/src/runtime/config/core-config-environment.ts",
  "apps/core-daemon/src/runtime/config/daemon-config-environment.ts"
];

// Documented keys that are not daemon-registry entries. Each still needs a
// production read site. Do not add daemon keys here — put those in the registry.
const DOCUMENTED_OUTSIDE_REGISTRY = Object.freeze({
  OPENAI_API_KEY: "secret value for env:OPENAI_API_KEY refs",
  HF_ENDPOINT: "local embedding model fetch mirror",
  ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT: "optional ONNX host lock",
  ALAYA_LOCAL_ONNX_LOCK_PATH: "optional ONNX lock path",
  ALAYA_SQLITE_WRITE_QUEUE: "SQLite write-queue opt-out",
  ALAYA_CONFIG_DIR: "CLI/config directory override",
  ALAYA_WORKSPACE_ID: "default workspace for attach/CLI",
  ALAYA_ALLOWED_MCP_SERVERS: "MCP server name allowlist",
  ALAYA_DEBUG: "CLI debug logging",
  ALAYA_BENCH_ARTIFACT_ROOT: "bench-runner artifact root",
  ALAYA_BENCH_DATA_DIR: "bench-runner dataset directory",
  ALAYA_BENCH_FAST_PRAGMA: "bench-runner SQLite pragma",
  ALAYA_BENCH_TEMP_STORE: "bench-runner SQLite temp_store"
});

const errors = [];
const registry = loadRegistryKeys();
const documented = loadDocumentedKeys(envExamplePath);

for (const key of registry) {
  if (!documented.has(key)) {
    errors.push(`registry key ${key} is missing from .env.example`);
  }
}

for (const key of documented) {
  if (!registry.has(key) && DOCUMENTED_OUTSIDE_REGISTRY[key] === undefined) {
    errors.push(`documented key ${key} is not in the daemon registry and has no whitelist reason`);
  }
  if (!hasProductionReadSite(key)) {
    errors.push(`documented key ${key} has no production read site`);
  }
}

assertBooleanVocabularyLock();

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`env-docs: ${error}\n`);
  process.exit(1);
}

console.log(
  `check-env-docs: ok (registry ${registry.size}, documented ${documented.size}, whitelist ${Object.keys(DOCUMENTED_OUTSIDE_REGISTRY).length})`
);

function loadRegistryKeys() {
  const keys = new Set();
  for (const rel of registryFiles) {
    const source = readFileSync(path.join(repoRoot, rel), "utf8");
    // Object-value env keys only — skip prefixes ("ALAYA_") and warning codes (`code: "..."`).
    for (const match of source.matchAll(/^\s+(?!code\b)\w+:\s*"([A-Z][A-Z0-9_]{2,})"/gm)) {
      const key = match[1];
      if (key.endsWith("_")) continue;
      keys.add(key);
    }
  }
  return keys;
}

function loadDocumentedKeys(filePath) {
  const keys = new Set();
  const source = readFileSync(filePath, "utf8");
  for (const match of source.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)) {
    keys.add(match[1]);
  }
  return keys;
}

function parseExportedStringArray(source, name) {
  const match = source.match(new RegExp(`export const ${name} = \\[([^\\]]+)\\]`));
  if (match === null) {
    errors.push(`protocol env-value.ts is missing ${name}`);
    return [];
  }
  const tokens = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  if (tokens.length === 0) {
    errors.push(`protocol env-value.ts ${name} is empty`);
  }
  return tokens;
}

function loadBooleanVocabulary() {
  const source = readFileSync(
    path.join(repoRoot, "packages/protocol/src/config/env-value.ts"),
    "utf8"
  );
  return {
    trueTokens: parseExportedStringArray(source, "ENV_BOOLEAN_TRUE_TOKENS"),
    falseTokens: parseExportedStringArray(source, "ENV_BOOLEAN_FALSE_TOKENS")
  };
}

function compactWhitespace(value) {
  return value.toLowerCase().replace(/\s+/g, " ");
}

function assertBooleanVocabularyLock() {
  const { trueTokens, falseTokens } = loadBooleanVocabulary();
  const envExample = readFileSync(envExamplePath, "utf8");
  const vocabBlock = envExample.match(
    /Public boolean flags share one vocabulary[\s\S]{0,800}/
  );
  if (vocabBlock === null) {
    errors.push(".env.example is missing the public boolean vocabulary header");
    return;
  }
  const haystack = compactWhitespace(vocabBlock[0]);
  const trueLine = `true: ${trueTokens.join(", ")}`;
  const falseLine = `false: ${falseTokens.join(", ")}`;
  if (!haystack.includes(compactWhitespace(trueLine))) {
    errors.push(`.env.example must document boolean true tokens as "${trueLine}"`);
  }
  if (!haystack.includes(compactWhitespace(falseLine))) {
    errors.push(`.env.example must document boolean false tokens as "${falseLine}"`);
  }
  if (!/"2"/.test(vocabBlock[0]) || !/invalid/i.test(vocabBlock[0])) {
    errors.push(`.env.example must document that the token "2" is invalid`);
  }
}

function hasProductionReadSite(key) {
  try {
    const output = execFileSync(
      "rg",
      [
        "-l",
        "--fixed-strings",
        key,
        "-g",
        "!**/node_modules/**",
        "-g",
        "!**/dist/**",
        "-g",
        "!**/*test*",
        "-g",
        "!**/__tests__/**",
        "-g",
        "!.env.example",
        "-g",
        "!scripts/ci/**",
        "."
      ],
      { cwd: repoRoot, encoding: "utf8" }
    ).trim();
    return output.length > 0;
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error ? error.status : null;
    if (status === 1) return false;
    throw error;
  }
}
