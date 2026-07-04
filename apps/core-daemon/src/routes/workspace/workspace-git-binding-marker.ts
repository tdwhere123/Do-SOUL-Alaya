import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { GitBindingValidationResult } from "./workspace-git-binding-types.js";
import { logGitBindingFsWarning } from "./workspace-git-binding-fs.js";
import { isPathWithinAllowedRoots } from "./workspace-git-binding-path-validation.js";

export async function validateGitMarker(
  repoPath: string,
  allowedRoots: readonly string[]
): Promise<GitBindingValidationResult | { readonly ok: true }> {
  const gitMarkerPath = path.join(repoPath, ".git");

  const resolvedGitMarkerPath = await resolveGitMarkerPath(gitMarkerPath);
  if (resolvedGitMarkerPath === null) {
    return notAGitRepositoryResult();
  }

  let resolvedGitMarkerStats: Awaited<ReturnType<typeof stat>>;
  try {
    resolvedGitMarkerStats = await stat(resolvedGitMarkerPath);
  } catch (error) {
    logGitBindingFsWarning("validateGitMarker", resolvedGitMarkerPath, error);
    return notAGitRepositoryResult();
  }

  if (resolvedGitMarkerStats.isDirectory()) {
    return validateGitDirectoryMarker(resolvedGitMarkerPath, allowedRoots);
  }

  return await validateGitFileMarker(gitMarkerPath, resolvedGitMarkerPath, allowedRoots);
}

function notAGitRepositoryResult(): GitBindingValidationResult {
  return {
    ok: false,
    code: "not_a_git_repository",
    detail: "repo_path must contain a .git directory or file."
  };
}

function validateGitDirectoryMarker(
  resolvedGitMarkerPath: string,
  allowedRoots: readonly string[]
): GitBindingValidationResult | { readonly ok: true } {
  return isPathWithinAllowedRoots(allowedRoots, resolvedGitMarkerPath)
    ? { ok: true }
    : {
        ok: false,
        code: "outside_allowed_roots",
        detail: ".git directory resolves outside the allowed repository roots."
      };
}

async function validateGitFileMarker(
  gitMarkerPath: string,
  resolvedGitMarkerPath: string,
  allowedRoots: readonly string[]
): Promise<GitBindingValidationResult | { readonly ok: true }> {
  const gitdirTargetPath = await resolveGitDirTarget(gitMarkerPath, resolvedGitMarkerPath);
  if (gitdirTargetPath === null) {
    return notAGitRepositoryResult();
  }

  return isPathWithinAllowedRoots(allowedRoots, gitdirTargetPath)
    ? { ok: true }
    : {
        ok: false,
        code: "outside_allowed_roots",
        detail: ".git gitdir resolves outside the allowed repository roots."
      };
}

async function resolveGitMarkerPath(gitMarkerPath: string): Promise<string | null> {
  try {
    return await realpath(gitMarkerPath);
  } catch (error) {
    logGitBindingFsWarning("resolveGitMarkerPath", gitMarkerPath, error);
    return null;
  }
}

async function resolveGitDirTarget(
  gitMarkerPath: string,
  resolvedGitMarkerPath: string
): Promise<string | null> {
  let contents: string;
  try {
    contents = await readFile(resolvedGitMarkerPath, "utf8");
  } catch (error) {
    logGitBindingFsWarning("resolveGitDirTarget.readFile", resolvedGitMarkerPath, error);
    return null;
  }

  const parsed = /^gitdir:\s*(.+)\s*$/im.exec(contents);
  if (parsed?.[1] === undefined) {
    return null;
  }

  const rawGitDir = parsed[1].trim();
  if (rawGitDir.length === 0) {
    return null;
  }

  const candidatePath = path.isAbsolute(rawGitDir)
    ? rawGitDir
    : path.resolve(path.dirname(gitMarkerPath), rawGitDir);

  let resolvedGitDirPath: string;
  try {
    resolvedGitDirPath = await realpath(candidatePath);
  } catch (error) {
    logGitBindingFsWarning("resolveGitDirTarget.realpath", candidatePath, error);
    return null;
  }

  try {
    const resolvedStats = await stat(resolvedGitDirPath);
    return resolvedStats.isDirectory() ? resolvedGitDirPath : null;
  } catch (error) {
    logGitBindingFsWarning("resolveGitDirTarget.stat", resolvedGitDirPath, error);
    return null;
  }
}
