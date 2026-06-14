import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

// dist/build-info.json is written by scripts/build-existing.mjs at the end
// of every build. From built code (dist/runtime/build-info.js), the JSON lives
// one level up at dist/build-info.json. From source (tests, ts-node), no
// build-info.json exists, so callers fall back to the unknown sentinel or the
// package version depending on the surface they are rendering.
export function readBuildInfo(options: BuildInfoReadOptions = {}): BuildInfo {
  const readFile = options.readFile ?? readFileSync;
  for (const candidatePath of resolveBuildInfoCandidatePaths(options.moduleUrl ?? import.meta.url)) {
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

function readPackageVersion(options: BuildInfoReadOptions): string {
  try {
    const readFile = options.readFile ?? readFileSync;
    const raw = readFile(resolvePackageJsonPath(options.moduleUrl ?? import.meta.url), "utf8");
    const parsed = parseJsonObject(raw);
    return readNonEmptyString(parsed.version, UNKNOWN_BUILD_INFO.version);
  } catch {
    return UNKNOWN_BUILD_INFO.version;
  }
}

function resolveBuildInfoCandidatePaths(moduleUrl: string): readonly string[] {
  const here = dirname(fileURLToPath(moduleUrl));
  return [resolve(here, "build-info.json"), resolve(here, "..", "build-info.json")];
}

function resolvePackageJsonPath(moduleUrl: string): string {
  const here = dirname(fileURLToPath(moduleUrl));
  return resolve(here, "..", "..", "package.json");
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
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
