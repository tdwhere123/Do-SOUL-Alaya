import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { GitBindingValidationResult } from "./workspace-git-binding-types.js";
import {
  logGitBindingFsWarning,
  mapFsErrorToValidationResult
} from "./workspace-git-binding-fs.js";

export function rejectInvalidRepoPathSyntax(repoPath: string): GitBindingValidationResult | null {
  if (!path.isAbsolute(repoPath)) {
    return {
      ok: false,
      code: "path_must_be_absolute",
      detail: "repo_path must be an absolute path."
    };
  }

  if (containsTraversalSegment(repoPath)) {
    return {
      ok: false,
      code: "path_traversal",
      detail: "repo_path must not contain traversal segments."
    };
  }

  return null;
}

export async function resolveRepoDirectory(
  repoPath: string
): Promise<GitBindingValidationResult | { readonly ok: true; readonly repo_path: string }> {
  let resolvedPath: string;

  try {
    resolvedPath = await realpath(repoPath);
  } catch (error) {
    return mapFsErrorToValidationResult(error, "repo_path could not be resolved.");
  }

  let resolvedStat: Awaited<ReturnType<typeof stat>>;

  try {
    resolvedStat = await stat(resolvedPath);
  } catch (error) {
    return mapFsErrorToValidationResult(error, "repo_path could not be resolved.");
  }

  if (!resolvedStat.isDirectory()) {
    return {
      ok: false,
      code: "not_a_directory",
      detail: "repo_path must resolve to a directory."
    };
  }

  return { ok: true, repo_path: resolvedPath };
}

function containsTraversalSegment(input: string): boolean {
  const decoded = safeDecodeURIComponent(input);
  return hasTraversalPattern(input) || hasTraversalPattern(decoded);
}

function hasTraversalPattern(input: string): boolean {
  return /(^|[\\/])\.\.([\\/]|$)/.test(input);
}

function safeDecodeURIComponent(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

export async function resolveAllowedRoots(options: {
  readonly currentWorkingDirectory?: string;
  readonly repoRootsEnv?: string;
}): Promise<readonly string[]> {
  const currentWorkingDirectory = options.currentWorkingDirectory ?? process.cwd();
  const configuredRoots = (options.repoRootsEnv ?? process.env.ALAYA_REPO_ROOTS ?? "")
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const candidateRoots = [currentWorkingDirectory, ...configuredRoots];
  const resolvedRoots = new Set<string>();

  for (const candidate of candidateRoots) {
    try {
      resolvedRoots.add(await realpath(candidate));
    } catch (error) {
      logGitBindingFsWarning("resolveAllowedRoots", candidate, error);
    }
  }

  return Array.from(resolvedRoots);
}

export function isWithinAllowedRoot(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function isPathWithinAllowedRoots(allowedRoots: readonly string[], candidate: string): boolean {
  return allowedRoots.some((root) => isWithinAllowedRoot(root, candidate));
}
