import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildInfo {
  readonly version: string;
  readonly git_head: string;
  readonly built_at: string;
}

const UNKNOWN_BUILD_INFO: BuildInfo = {
  version: "0.0.0-dev",
  git_head: "unknown",
  built_at: "unknown"
};

type ReadFileSyncLike = (path: string, encoding: "utf8") => string;

interface BuildInfoReadOptions {
  readonly moduleUrl?: string;
  readonly readFile?: ReadFileSyncLike;
}

const CORE_DAEMON_PACKAGE_NAME = "@do-soul/alaya";

// dist/build-info.json is written by scripts/build-existing.mjs at the end
// of every build. From built code (dist/...), resolve relative to the package
// root so module depth never breaks packaged path resolution. From source
// (tests, ts-node), callers fall back to the unknown sentinel or package version.
export function readBuildInfo(options: BuildInfoReadOptions = {}): BuildInfo {
  const readFile = options.readFile ?? readFileSync;
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  for (const candidatePath of resolveBuildInfoCandidatePaths(moduleUrl, readFile)) {
    try {
      const raw = readFile(candidatePath, "utf8");
      return normalizeBuildInfo(parseJsonObject(raw));
    } catch {
      continue;
    }
  }
  return UNKNOWN_BUILD_INFO;
}

export function readRuntimeVersion(options: BuildInfoReadOptions = {}): string {
  const buildInfo = readBuildInfo(options);
  return buildInfo.version === UNKNOWN_BUILD_INFO.version
    ? readPackageVersion(options)
    : buildInfo.version;
}

export function resolveCoreDaemonPackageRoot(
  moduleUrl: string = import.meta.url,
  readFile: ReadFileSyncLike = readFileSync
): string {
  const startDir = dirname(fileURLToPath(moduleUrl));
  return findCoreDaemonPackageRoot(startDir, readFile) ?? resolve(startDir, "..", "..", "..", "..");
}

function readPackageVersion(options: BuildInfoReadOptions): string {
  try {
    const readFile = options.readFile ?? readFileSync;
    const raw = readFile(resolvePackageJsonPath(options.moduleUrl ?? import.meta.url, readFile), "utf8");
    const parsed = parseJsonObject(raw);
    return readNonEmptyString(parsed.version, UNKNOWN_BUILD_INFO.version);
  } catch {
    return UNKNOWN_BUILD_INFO.version;
  }
}

function resolveBuildInfoCandidatePaths(
  moduleUrl: string,
  readFile: ReadFileSyncLike
): readonly string[] {
  const here = dirname(fileURLToPath(moduleUrl));
  const pkgRoot = findCoreDaemonPackageRoot(here, readFile);
  if (pkgRoot !== null) {
    const distDir = resolve(pkgRoot, "dist");
    const rel = relative(distDir, here);
    const inDist = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    return inDist ? [resolve(distDir, "build-info.json"), resolve(pkgRoot, "build-info.json")] : [];
  }
  const distAncestor = findAncestorNamed(here, "dist");
  if (distAncestor !== null) {
    return [resolve(distAncestor, "build-info.json"), resolve(dirname(distAncestor), "build-info.json")];
  }
  return [resolve(here, "build-info.json")];
}

function resolvePackageJsonPath(moduleUrl: string, readFile: ReadFileSyncLike): string {
  return resolve(resolveCoreDaemonPackageRoot(moduleUrl, readFile), "package.json");
}

function findCoreDaemonPackageRoot(startDir: string, readFile: ReadFileSyncLike): string | null {
  let current = startDir;
  while (true) {
    try {
      const parsed = parseJsonObject(readFile(resolve(current, "package.json"), "utf8"));
      if (
        parsed.name === CORE_DAEMON_PACKAGE_NAME ||
        (parsed.name === undefined && typeof parsed.version === "string")
      ) {
        return current;
      }
    } catch {
      // Keep walking up until the package root is located.
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function findAncestorNamed(startDir: string, targetName: string): string | null {
  let current = startDir;
  while (true) {
    if (basename(current) === targetName) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new TypeError("Expected a JSON object.");
  }
  return parsed;
}

function normalizeBuildInfo(parsed: Record<string, unknown>): BuildInfo {
  return {
    version: readNonEmptyString(parsed.version, UNKNOWN_BUILD_INFO.version),
    git_head: readNonEmptyString(parsed.git_head, UNKNOWN_BUILD_INFO.git_head),
    built_at: readNonEmptyString(parsed.built_at, UNKNOWN_BUILD_INFO.built_at)
  };
}

function readNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
