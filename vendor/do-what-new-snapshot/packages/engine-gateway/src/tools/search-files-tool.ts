import path from "node:path";
import fg from "fast-glob";
import type { ToolSpec } from "@do-what/protocol";
import {
  createToolError,
  DEFAULT_MAX_RESULTS,
  mapFileSystemError,
  readFileSystemEntry,
  resolveContainedPath,
  type FileToolError
} from "./shared.js";

export const SEARCH_FILES_TOOL_SPEC: ToolSpec = {
  tool_id: "tools.search_files",
  category: "read",
  description: "Search for files matching a glob pattern within the workspace boundary.",
  scope_guard: "workspace",
  read_only: true,
  destructive: false,
  concurrency_safe: true,
  interrupt_behavior: "continue",
  requires_confirmation: false,
  requires_evidence_reopen: false,
  rollback_support: "none",
  fast_path_eligible: true
};

export interface SearchFilesInput {
  readonly pattern: string;
  readonly baseDir: string;
  /** Maximum number of results; defaults to 200. */
  readonly maxResults?: number;
}

export type SearchFilesResult =
  | { readonly ok: true; readonly paths: readonly string[] }
  | FileToolError;

/**
 * Searches for files within a base directory using an in-process containment
 * check only; full sandbox escape prevention is A3 Worker Baseline Safety.
 */
export async function searchFiles(
  input: SearchFilesInput,
  writableRoots: readonly string[]
): Promise<SearchFilesResult> {
  const containedPath = resolveContainedPath(input.baseDir, writableRoots, {
    basePath: writableRoots[0]
  });

  if (!containedPath.ok) {
    return containedPath;
  }

  const entry = await readFileSystemEntry(containedPath.resolvedPath);

  if (!entry.ok) {
    return entry;
  }

  if (!entry.stats.isDirectory()) {
    return createToolError(
      "READ_ERROR",
      `Base directory is not a directory: ${containedPath.resolvedPath}`
    );
  }

  if (!isPatternSupported(input.pattern)) {
    return createToolError("ACCESS_DENIED", "Pattern is outside the workspace boundary.");
  }

  if (patternEscapesWorkspace(input.pattern, containedPath.resolvedPath, writableRoots)) {
    return createToolError("ACCESS_DENIED", "Pattern is outside the workspace boundary.");
  }

  const maxResults = normalizeMaxResults(input.maxResults);

  try {
    const paths = await fg(input.pattern, {
      cwd: containedPath.resolvedPath,
      onlyFiles: true,
      unique: true,
      dot: true,
      followSymbolicLinks: false
    });
    const containedMatches: string[] = [];
    let escapedMatchFound = false;

    for (const matchedPath of paths) {
      const resolvedMatch = path.resolve(containedPath.resolvedPath, matchedPath);
      const containedMatch = resolveContainedPath(resolvedMatch, writableRoots);

      if (!containedMatch.ok) {
        escapedMatchFound = true;
        continue;
      }

      containedMatches.push(matchedPath);
    }

    if (escapedMatchFound) {
      return createToolError("ACCESS_DENIED", "Pattern is outside the workspace boundary.");
    }

    return {
      ok: true,
      paths: containedMatches
        .sort((left, right) => left.localeCompare(right))
        .slice(0, maxResults)
    };
  } catch (error) {
    return mapFileSystemError(error, containedPath.resolvedPath);
  }
}

function normalizeMaxResults(value: number | undefined): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : DEFAULT_MAX_RESULTS;
}

function isPatternSupported(pattern: string): boolean {
  if (typeof pattern !== "string" || pattern.trim().length === 0) {
    return false;
  }

  if (pattern.includes("\0")) {
    return false;
  }

  if (pathIsAbsolute(pattern)) {
    return false;
  }

  return true;
}

function pathIsAbsolute(pattern: string): boolean {
  return path.isAbsolute(pattern) || /^[A-Za-z]:[\\/]/.test(pattern);
}

function patternEscapesWorkspace(
  pattern: string,
  baseDir: string,
  writableRoots: readonly string[]
): boolean {
  const literalPrefix = getLiteralPrefix(pattern);

  if (literalPrefix.length === 0) {
    return false;
  }

  const resolvedPrefix = path.resolve(baseDir, literalPrefix);
  return !resolveContainedPath(resolvedPrefix, writableRoots).ok;
}

function getLiteralPrefix(pattern: string): string {
  const segments = pattern.split(/[\\/]+/);
  const literalSegments: string[] = [];

  for (const segment of segments) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }

    if (segment === "..") {
      literalSegments.push(segment);
      continue;
    }

    if (hasGlobSyntax(segment)) {
      break;
    }

    literalSegments.push(segment);
  }

  return literalSegments.length === 0 ? "" : path.join(...literalSegments);
}

function hasGlobSyntax(segment: string): boolean {
  return /[*?[\]{}()!+@]/.test(segment);
}
