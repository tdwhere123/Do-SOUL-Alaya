import type { WorkspaceGitBindingStatus } from "@do-soul/alaya-protocol";
import type { Workspace } from "@do-soul/alaya-protocol";

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
