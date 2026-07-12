#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ALGORITHM = "sha256-reachable-path-file-sha256-v1";
const EXECUTABLE_EXTENSIONS = new Set([".cjs", ".js", ".json", ".mjs", ".node", ".wasm"]);
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);

export async function computeExecutedDistClosure(checkoutRoot) {
  const root = resolve(checkoutRoot);
  const entrypoint = join(root, "apps", "bench-runner", "bin", "alaya-bench-runner.mjs");
  const files = await collectReachableArtifacts(root, entrypoint);
  const entries = await Promise.all(files.map((path) => hashArtifact(root, path)));
  entries.sort((left, right) => left.path.localeCompare(right.path));
  if (entries.length === 0) throw new Error("executed dist closure is empty");
  const aggregate = createHash("sha256");
  for (const entry of entries) aggregate.update(`${entry.path}\0${entry.sha256}\n`, "utf8");
  return { algorithm: ALGORITHM, sha256: aggregate.digest("hex"), file_count: entries.length };
}

async function collectReachableArtifacts(root, entrypoint) {
  const pending = [entrypoint];
  const visited = new Set();
  while (pending.length > 0) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    await assertArtifact(root, path);
    visited.add(path);
    if (!SOURCE_EXTENSIONS.has(extname(path))) continue;
    const source = await readFile(path, "utf8");
    for (const specifier of extractImportSpecifiers(source)) {
      const dependency = resolveWorkspaceImport(root, path, specifier);
      if (dependency !== null && !visited.has(dependency)) pending.push(dependency);
    }
  }
  return [...visited];
}

function extractImportSpecifiers(source) {
  const pattern = /(?:\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?|\bimport\s*\(\s*)["']([^"']+)["']/gu;
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function resolveWorkspaceImport(root, importer, specifier) {
  if (specifier.startsWith("node:")) return null;
  let resolved;
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    resolved = resolve(dirname(importer), specifier);
  } else {
    try {
      resolved = createRequire(importer).resolve(specifier);
    } catch {
      return null;
    }
  }
  const normalized = relative(root, resolved).split(sep).join("/");
  if (normalized.startsWith("../") || normalized === ".." || normalized.includes("/node_modules/")) {
    return null;
  }
  if (!EXECUTABLE_EXTENSIONS.has(extname(resolved))) return null;
  return resolved;
}

async function assertArtifact(root, path) {
  const normalized = relative(root, path);
  if (normalized.startsWith(`..${sep}`) || normalized === "..") {
    throw new Error(`executed dist artifact escapes checkout: ${path}`);
  }
  let cursor = root;
  for (const segment of ["", ...normalized.split(sep)]) {
    cursor = segment.length === 0 ? cursor : join(cursor, segment);
    if ((await lstat(cursor)).isSymbolicLink()) {
      throw new Error(`symlink in executed dist tree: ${cursor}`);
    }
  }
  const resolvedRoot = await realpath(root);
  const resolvedArtifact = await realpath(path);
  const realRelative = relative(resolvedRoot, resolvedArtifact);
  if (realRelative.startsWith(`..${sep}`) || realRelative === "..") {
    throw new Error(`executed dist artifact escapes checkout: ${path}`);
  }
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`symlink in executed dist tree: ${path}`);
  if (!stat.isFile()) throw new Error(`executed dist artifact is not a file: ${path}`);
}

async function hashArtifact(root, path) {
  const normalized = relative(root, path).split(sep).join("/");
  if (normalized.startsWith("../") || normalized === "..") {
    throw new Error(`executed dist artifact escapes checkout: ${path}`);
  }
  return {
    path: normalized,
    sha256: createHash("sha256").update(await readFile(path)).digest("hex")
  };
}

function parseRoot(argv) {
  const index = argv.indexOf("--root");
  if (index < 0 || argv[index + 1] === undefined) throw new Error("Usage: executed-dist-closure.mjs --root <checkout>");
  return argv[index + 1];
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const identity = await computeExecutedDistClosure(parseRoot(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(identity)}\n`);
}
