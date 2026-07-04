import {
  WorkspaceGitBindingSchema,
  type Workspace
} from "@do-soul/alaya-protocol";
import { validateGitMarker } from "./workspace-git-binding-marker.js";
import {
  isWithinAllowedRoot,
  rejectInvalidRepoPathSyntax,
  resolveAllowedRoots,
  resolveRepoDirectory
} from "./workspace-git-binding-path-validation.js";
import type {
  GitBindingStatusResult,
  GitBindingValidationOptions,
  GitBindingValidationResult
} from "./workspace-git-binding-types.js";

export type {
  GitBindingStatusResult,
  GitBindingValidationErrorCode,
  GitBindingValidationOptions,
  GitBindingValidationResult,
  WorkspaceGitBindingRepo
} from "./workspace-git-binding-types.js";

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
  const syntaxError = rejectInvalidRepoPathSyntax(repoPath);
  if (syntaxError !== null) {
    return syntaxError;
  }

  const resolvedDirectory = await resolveRepoDirectory(repoPath);
  if (!resolvedDirectory.ok) {
    return resolvedDirectory;
  }

  const allowedRoots = await resolveAllowedRoots(options);
  const withinAllowedRoot = allowedRoots.some((root) =>
    isWithinAllowedRoot(root, resolvedDirectory.repo_path)
  );

  if (!withinAllowedRoot) {
    return {
      ok: false,
      code: "outside_allowed_roots",
      detail: "repo_path resolves outside the allowed repository roots."
    };
  }

  const gitMarkerValidation = await validateGitMarker(resolvedDirectory.repo_path, allowedRoots);
  if (!gitMarkerValidation.ok) {
    return gitMarkerValidation;
  }

  return {
    ok: true,
    repo_path: resolvedDirectory.repo_path
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
