import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CoreError } from "@do-soul/alaya-core";

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

// dist/build-info.json is written by scripts/build-existing.mjs at the end of
// every build. Walk up once to the @do-soul/alaya package root and read it;
// unbuilt dev/test trees fall back to UNKNOWN_BUILD_INFO or package version.
export function readBuildInfo(options: BuildInfoReadOptions = {}): BuildInfo {
  const readFile = options.readFile ?? readFileSync;
  const located = findCoreDaemonPackage(
    dirname(fileURLToPath(options.moduleUrl ?? import.meta.url)),
    readFile
  );
  if (located === null) {
    return UNKNOWN_BUILD_INFO;
  }
  return readDistBuildInfo(located.root, readFile) ?? UNKNOWN_BUILD_INFO;
}

export function readRuntimeVersion(options: BuildInfoReadOptions = {}): string {
  const readFile = options.readFile ?? readFileSync;
  const located = findCoreDaemonPackage(
    dirname(fileURLToPath(options.moduleUrl ?? import.meta.url)),
    readFile
  );
  if (located === null) {
    return UNKNOWN_BUILD_INFO.version;
  }
  const built = readDistBuildInfo(located.root, readFile);
  if (built !== null && built.version !== UNKNOWN_BUILD_INFO.version) {
    return built.version;
  }
  return readNonEmptyString(located.pkg.version, UNKNOWN_BUILD_INFO.version);
}

export function resolveCoreDaemonPackageRoot(
  moduleUrl: string = import.meta.url,
  readFile: ReadFileSyncLike = readFileSync
): string {
  const startDir = dirname(fileURLToPath(moduleUrl));
  const located = findCoreDaemonPackage(startDir, readFile);
  if (located === null) {
    throw new CoreError(
      "NOT_FOUND",
      `Unable to locate ${CORE_DAEMON_PACKAGE_NAME} package.json from ${startDir}.`
    );
  }
  return located.root;
}

function readDistBuildInfo(packageRoot: string, readFile: ReadFileSyncLike): BuildInfo | null {
  try {
    const raw = readFile(resolve(packageRoot, "dist", "build-info.json"), "utf8");
    return normalizeBuildInfo(parseJsonObject(raw));
  } catch {
    return null;
  }
}

function findCoreDaemonPackage(
  startDir: string,
  readFile: ReadFileSyncLike
): Readonly<{ root: string; pkg: Record<string, unknown> }> | null {
  let current = startDir;
  while (true) {
    try {
      const pkg = parseJsonObject(readFile(resolve(current, "package.json"), "utf8"));
      if (pkg.name === CORE_DAEMON_PACKAGE_NAME) {
        return { root: current, pkg };
      }
    } catch {
      // Keep walking up until the @do-soul/alaya package root is located.
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
