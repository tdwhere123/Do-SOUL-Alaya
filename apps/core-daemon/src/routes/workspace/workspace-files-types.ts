import type { ToolExecutionRecordRepo } from "@do-soul/alaya-storage";
import type { GitBindingValidationOptions } from "./workspaces.js";

export class GitInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitInputError";
  }
}

export class GitTimeoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitTimeoutError";
  }
}

export class GitCommandError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitCommandError";
  }
}

export interface GitDiffService {
  getFileDiff(input: {
    readonly repoPath: string;
    readonly path: string;
    readonly since?: string;
    readonly against?: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly repoPath: string;
    readonly path: string;
    readonly since: string;
    readonly against: string;
    readonly binary: boolean;
    readonly deleted: boolean;
    readonly added: boolean;
    readonly unifiedDiff: string;
    readonly truncated: boolean;
  }>;
}

export interface GitLogService {
  listGitLog(input: {
    readonly repoPath: string;
    readonly limit: number;
    readonly path?: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly repoPath: string;
    readonly commits: readonly {
      readonly sha: string;
      readonly short_sha: string;
      readonly author_name: string;
      readonly author_email: string;
      readonly committed_at: string;
      readonly subject: string;
    }[];
    readonly truncated: boolean;
  }>;
}

export interface WorkspaceFilesRouteServices {
  readonly workspaceService: {
    getById(id: string): Promise<{
      readonly workspace_id: string;
      readonly root_path: string;
      readonly repo_path: string | null;
    }>;
  };
  readonly runService?: {
    getById(id: string): Promise<{
      readonly run_id: string;
      readonly workspace_id: string;
    }>;
  };
  readonly workerRunRepo?: {
    getById(id: string): Promise<{
      readonly worker_run_id: string;
      readonly workspace_id: string;
    } | null>;
  };
  readonly toolExecutionRecordRepo?: Pick<ToolExecutionRecordRepo, "listByRunId">;
  readonly gitBindingValidation?: GitBindingValidationOptions;
  readonly gitDiffService?: GitDiffService;
  readonly gitLogService?: GitLogService;
  readonly gitRateLimiter?: {
    allow(workspaceId: string): boolean;
  };
}
