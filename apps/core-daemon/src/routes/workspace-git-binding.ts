import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  WorkspaceGitBindingSchema,
  type Workspace,
  type WorkspaceGitBindingStatus
} from "@do-soul/alaya-protocol";

export interface WorkspaceGitBindingRepo {
  getById(id: string): Promise<Workspace | null>;
  updateRepoPath(id: string, repoPath: Workspace["repo_path"]): Promise<Workspace>;
}

export interface GitBindingValidationOptions {
  readonly currentWorkingDirectory?: string;
  readonly repoRootsEnv?: string;
}

export type GitBindingValidationErrorCode =
  | "path_must_be_absolute"
  | "path_traversal"
  | "path_not_found"
  | "permission_denied"
  | "not_a_directory"
  | "outside_allowed_roots"
  | "not_a_git_repository";

export type GitBindingValidationResult =
  | {
      readonly ok: true;
      readonly repo_path: string;
    }
  | {
      readonly ok: false;
      readonly code: GitBindingValidationErrorCode;
      readonly detail: string;
    };

export interface GitBindingStatusResult {
  readonly repo_path: string | null;
  readonly status: WorkspaceGitBindingStatus;
  readonly reason?: string;
}

export function buildWorkspaceGitBindingResponse(
  workspaceId: string,
  status: GitBindingStatusResult
) {
  return WorkspaceGitBindingSchema.parse({
    workspace_id: workspaceId,
    repo_path: status.repo_path,
    status: status.status,
    ...(status.reason !== undefined ? { reason: status.reason } : {})
  });
}

export async function sanitizeWorkspaceForGenericRead(
  workspace: Workspace,
  validationOptions: GitBindingValidationOptions | undefined
): Promise<Workspace> {
  const status = await getWorkspaceGitBindingStatus(workspace.repo_path, validationOptions);

  if (status.status !== "invalid") {
    return workspace;
  }

  return {
    ...workspace,
    repo_path: null
  };
}

export async function validateWorkspaceGitBindingInput(
  repoPath: string,
  options: GitBindingValidationOptions = {}
): Promise<GitBindingValidationResult> {
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

  const allowedRoots = await resolveAllowedRoots(options);
  const withinAllowedRoot = allowedRoots.some((root) => isWithinAllowedRoot(root, resolvedPath));

  if (!withinAllowedRoot) {
    return {
      ok: false,
      code: "outside_allowed_roots",
      detail: "repo_path resolves outside the allowed repository roots."
    };
  }

  const gitMarkerValidation = await validateGitMarker(resolvedPath, allowedRoots);
  if (!gitMarkerValidation.ok) {
    return gitMarkerValidation;
  }

  return {
    ok: true,
    repo_path: resolvedPath
  };
}

export async function getWorkspaceGitBindingStatus(
  repoPath: string | null,
  options: GitBindingValidationOptions = {}
): Promise<GitBindingStatusResult> {
  if (repoPath === null) {
    return {
      repo_path: null,
      status: "unbound"
    };
  }

  const validation = await validateWorkspaceGitBindingInput(repoPath, options);

  if (validation.ok) {
    return {
      repo_path: repoPath,
      status: "bound"
    };
  }

  return {
    repo_path: repoPath,
    status: "invalid",
    reason: validation.detail
  };
}

async function resolveAllowedRoots(options: GitBindingValidationOptions): Promise<readonly string[]> {
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

function isWithinAllowedRoot(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function validateGitMarker(
  repoPath: string,
  allowedRoots: readonly string[]
): Promise<GitBindingValidationResult | { readonly ok: true }> {
  const gitMarkerPath = path.join(repoPath, ".git");

  const resolvedGitMarkerPath = await resolveGitMarkerPath(gitMarkerPath);
  if (resolvedGitMarkerPath === null) {
    return {
      ok: false,
      code: "not_a_git_repository",
      detail: "repo_path must contain a .git directory or file."
    };
  }

  let resolvedGitMarkerStats: Awaited<ReturnType<typeof stat>>;
  try {
    resolvedGitMarkerStats = await stat(resolvedGitMarkerPath);
  } catch (error) {
    logGitBindingFsWarning("validateGitMarker", resolvedGitMarkerPath, error);
    return {
      ok: false,
      code: "not_a_git_repository",
      detail: "repo_path must contain a .git directory or file."
    };
  }

  if (resolvedGitMarkerStats.isDirectory()) {
    return isPathWithinAllowedRoots(allowedRoots, resolvedGitMarkerPath)
      ? { ok: true }
      : {
          ok: false,
          code: "outside_allowed_roots",
          detail: ".git directory resolves outside the allowed repository roots."
        };
  }

  const gitdirTargetPath = await resolveGitDirTarget(gitMarkerPath, resolvedGitMarkerPath);
  if (gitdirTargetPath === null) {
    return {
      ok: false,
      code: "not_a_git_repository",
      detail: "repo_path must contain a .git directory or file."
    };
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

function isPathWithinAllowedRoots(allowedRoots: readonly string[], candidate: string): boolean {
  return allowedRoots.some((root) => isWithinAllowedRoot(root, candidate));
}

function mapFsErrorToValidationResult(
  error: unknown,
  notFoundDetail: string
): GitBindingValidationResult {
  logGitBindingFsWarning("validateWorkspaceGitBindingInput", "repo_path", error);
  const code = readFsErrorCode(error);
  if (code === "EACCES" || code === "EPERM") {
    return {
      ok: false,
      code: "permission_denied",
      detail: "repo_path could not be accessed due to insufficient permissions."
    };
  }
  return {
    ok: false,
    code: "path_not_found",
    detail: notFoundDetail
  };
}

function logGitBindingFsWarning(scope: string, target: string, error: unknown): void {
  const code = readFsErrorCode(error);
  process.emitWarning(
    `Workspace git binding ${scope} failed for ${target}${code === undefined ? "" : ` (${code})`}`,
    { type: "AlayaGitBindingWarning", code: "ALAYA_GIT_BINDING_FS_ERROR" }
  );
}

function readFsErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
