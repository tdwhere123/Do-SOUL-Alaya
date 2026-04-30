import type { Context, Hono } from "hono";
import { CoreError } from "@do-soul/alaya-core";
import { parseWorkspaceGitLogLimit } from "@do-soul/alaya-protocol";
import type { ToolExecutionRecordRepo } from "@do-soul/alaya-storage";
import {
  getWorkspaceGitBindingStatus,
  type GitBindingValidationOptions
} from "./workspaces.js";

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

interface AggregatedChangedFile {
  readonly path: string;
  readonly tool_call_ids: readonly string[];
  readonly first_seen_at: string;
  readonly last_seen_at: string;
}

export function registerWorkspaceFileRoutes(
  app: Hono,
  services: WorkspaceFilesRouteServices
): void {
  const gitDiffService = services.gitDiffService;
  const gitLogService = services.gitLogService;
  const gitRateLimiter = services.gitRateLimiter ?? createWorkspaceGitRateLimiter();

  app.get("/workspaces/:id/files/changed", async (context) => {
    if (services.toolExecutionRecordRepo === undefined) {
      throw new CoreError(
        "CONFLICT",
        "tool execution record persistence is unavailable on this backend"
      );
    }

    const workspaceId = context.req.param("id");
    const workspace = await services.workspaceService.getById(workspaceId);
    let includeExec: boolean;
    try {
      includeExec = parseOptionalBooleanQuery(context.req.query("include_exec"));
    } catch (error) {
      if (error instanceof GitInputError) {
        return context.json(
          {
            success: false,
            error: {
              code: "invalid_ref_arg"
            }
          },
          400
        );
      }

      throw error;
    }

    if (includeExec === true) {
      return context.json(
        {
          success: false,
          error: {
            code: "exec_parsing_unavailable"
          }
        },
        501
      );
    }

    const runId = context.req.query("runId");

    if (runId === undefined || runId.length === 0) {
      return context.json(
        {
          success: false,
          error: {
            code: "invalid_ref_arg"
          }
        },
        400
      );
    }

    const records = await loadScopedToolExecutionRecords(runId, workspaceId, services);

    return context.json(
      {
        success: true,
        data: {
          workspace_id: workspaceId,
          run_id: runId,
          repo_path: await resolveChangedFilesRepoPath(workspace, services.gitBindingValidation),
          files: aggregateChangedFiles(records)
        }
      },
      200
    );
  });

  app.get("/workspaces/:id/files/diff", async (context) => {
    if (gitDiffService === undefined) {
      throw new CoreError("CONFLICT", "git diff service is unavailable on this backend");
    }

    const workspace = await services.workspaceService.getById(context.req.param("id"));
    const bindingStatus = await getWorkspaceGitBindingStatus(
      workspace.repo_path,
      services.gitBindingValidation
    );

    if (bindingStatus.status !== "bound" || bindingStatus.repo_path === null) {
      return context.json(
        {
          success: false,
          error: {
            code: "workspace_not_bound",
            status: bindingStatus.status
          }
        },
        409
      );
    }

    const requestedPath = context.req.query("path");

    if (requestedPath === undefined || requestedPath.length === 0) {
      return context.json(
        {
          success: false,
          error: {
            code: "invalid_ref_arg"
          }
        },
        400
      );
    }

    if (!gitRateLimiter.allow(workspace.workspace_id)) {
      return context.json(
        {
          success: false,
          error: {
            code: "rate_limited"
          }
        },
        429
      );
    }

    try {
      const diff = await gitDiffService.getFileDiff({
        repoPath: bindingStatus.repo_path,
        path: requestedPath,
        since: context.req.query("since"),
        against: context.req.query("against"),
        signal: context.req.raw.signal
      });

      return context.json(
        {
          success: true,
          data: {
            workspace_id: workspace.workspace_id,
            repo_path: diff.repoPath,
            path: diff.path,
            since: diff.since,
            against: diff.against,
            binary: diff.binary,
            deleted: diff.deleted,
            added: diff.added,
            unified_diff: diff.unifiedDiff,
            ...(diff.truncated ? { truncated: true } : {})
          }
        },
        200
      );
    } catch (error) {
      return mapGitRouteError(context, error, {
        invalidCode: "invalid_ref_arg",
        timeoutCode: "git_diff_timeout",
        failureCode: "git_diff_failed"
      });
    }
  });

  app.get("/workspaces/:id/git/log", async (context) => {
    if (gitLogService === undefined) {
      throw new CoreError("CONFLICT", "git log service is unavailable on this backend");
    }

    const workspace = await services.workspaceService.getById(context.req.param("id"));
    const bindingStatus = await getWorkspaceGitBindingStatus(
      workspace.repo_path,
      services.gitBindingValidation
    );

    if (bindingStatus.status !== "bound" || bindingStatus.repo_path === null) {
      return context.json(
        {
          success: false,
          error: {
            code: "workspace_not_bound",
            status: bindingStatus.status
          }
        },
        409
      );
    }

    try {
      const limit = parseGitLogLimit(context.req.query("limit"));

      if (!gitRateLimiter.allow(workspace.workspace_id)) {
        return context.json(
          {
            success: false,
            error: {
              code: "rate_limited"
            }
          },
          429
        );
      }

      const gitLog = await gitLogService.listGitLog({
        repoPath: bindingStatus.repo_path,
        limit,
        path: context.req.query("path"),
        signal: context.req.raw.signal
      });

      return context.json(
        {
          success: true,
          data: {
            workspace_id: workspace.workspace_id,
            repo_path: gitLog.repoPath,
            commits: gitLog.commits,
            ...(gitLog.truncated ? { truncated: true } : {})
          }
        },
        200
      );
    } catch (error) {
      return mapGitRouteError(context, error, {
        invalidCode: "invalid_ref_arg",
        timeoutCode: "git_log_timeout",
        failureCode: "git_log_failed"
      });
    }
  });
}

function aggregateChangedFiles(
  records: readonly {
    readonly execution_id: string;
    readonly affected_paths?: readonly string[] | null;
    readonly started_at?: string;
    readonly ended_at?: string;
  }[]
): readonly AggregatedChangedFile[] {
  const filesByPath = new Map<
    string,
    {
      path: string;
      toolCallIds: Set<string>;
      firstSeenAt: string;
      lastSeenAt: string;
    }
  >();

  for (const record of records) {
    const lastSeenAt = record.ended_at ?? record.started_at;
    const affectedPaths = record.affected_paths;

    if (lastSeenAt === undefined || affectedPaths == null || affectedPaths.length === 0) {
      continue;
    }

    for (const affectedPath of affectedPaths) {
      const existing = filesByPath.get(affectedPath);

      if (existing === undefined) {
        filesByPath.set(affectedPath, {
          path: affectedPath,
          toolCallIds: new Set([record.execution_id]),
          firstSeenAt: lastSeenAt,
          lastSeenAt
        });
        continue;
      }

      existing.toolCallIds.add(record.execution_id);
      existing.firstSeenAt =
        existing.firstSeenAt < lastSeenAt ? existing.firstSeenAt : lastSeenAt;
      existing.lastSeenAt =
        existing.lastSeenAt > lastSeenAt ? existing.lastSeenAt : lastSeenAt;
    }
  }

  return Array.from(filesByPath.values())
    .map((entry) => ({
      path: entry.path,
      tool_call_ids: Array.from(entry.toolCallIds).sort(),
      first_seen_at: entry.firstSeenAt,
      last_seen_at: entry.lastSeenAt
    }))
    .sort(
      (left, right) =>
        right.last_seen_at.localeCompare(left.last_seen_at) ||
        left.path.localeCompare(right.path)
    );
}

function parseOptionalBooleanQuery(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new GitInputError("include_exec must be true or false");
}

function parseGitLogLimit(value: string | undefined): number {
  try {
    return parseWorkspaceGitLogLimit(value);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new GitInputError(error.message);
    }

    throw error;
  }
}

function createWorkspaceGitRateLimiter(limit = 20, windowMs = 1_000): {
  allow(workspaceId: string): boolean;
} {
  const requestsByWorkspace = new Map<string, number[]>();

  return {
    allow(workspaceId: string): boolean {
      const now = Date.now();
      const recentRequests = (requestsByWorkspace.get(workspaceId) ?? []).filter(
        (timestamp) => now - timestamp < windowMs
      );

      if (recentRequests.length >= limit) {
        requestsByWorkspace.set(workspaceId, recentRequests);
        return false;
      }

      recentRequests.push(now);
      requestsByWorkspace.set(workspaceId, recentRequests);
      return true;
    }
  };
}

async function loadScopedToolExecutionRecords(
  runId: string,
  workspaceId: string,
  services: WorkspaceFilesRouteServices
): Promise<readonly {
  readonly execution_id: string;
  readonly affected_paths?: readonly string[] | null;
  readonly started_at?: string;
  readonly ended_at?: string;
}[]> {
  if (services.toolExecutionRecordRepo === undefined) {
    return [];
  }

  const scope = await resolveRunScope(runId, workspaceId, services);

  if (scope === "principal") {
    return await services.toolExecutionRecordRepo.listByRunId(runId, "principal");
  }

  if (scope === "worker") {
    return await services.toolExecutionRecordRepo.listByRunId(runId, "worker");
  }

  if (scope === "mismatch") {
    return [];
  }

  return [];
}

async function resolveRunScope(
  runId: string,
  workspaceId: string,
  services: WorkspaceFilesRouteServices
): Promise<"principal" | "worker" | "mismatch" | "unknown"> {
  const principalRun = await getPrincipalRunIfPresent(runId, services);

  if (principalRun !== null) {
    return principalRun.workspace_id === workspaceId ? "principal" : "mismatch";
  }

  if (services.workerRunRepo === undefined) {
    return "unknown";
  }

  const workerRun = await services.workerRunRepo.getById(runId);

  if (workerRun === null) {
    return "unknown";
  }

  return workerRun.workspace_id === workspaceId ? "worker" : "mismatch";
}

async function getPrincipalRunIfPresent(
  runId: string,
  services: WorkspaceFilesRouteServices
): Promise<{ readonly run_id: string; readonly workspace_id: string } | null> {
  if (services.runService === undefined) {
    return null;
  }

  try {
    return await services.runService.getById(runId);
  } catch (error) {
    if (error instanceof CoreError && error.code === "NOT_FOUND") {
      return null;
    }

    throw error;
  }
}

async function resolveChangedFilesRepoPath(
  workspace: {
    readonly root_path: string;
    readonly repo_path: string | null;
  },
  validationOptions: GitBindingValidationOptions | undefined
): Promise<string> {
  if (workspace.repo_path === null) {
    return workspace.root_path;
  }

  const status = await getWorkspaceGitBindingStatus(workspace.repo_path, validationOptions);
  return status.status === "bound" && status.repo_path !== null
    ? status.repo_path
    : workspace.root_path;
}

function mapGitRouteError(
  context: Context,
  error: unknown,
  codes: {
    readonly invalidCode: string;
    readonly timeoutCode: string;
    readonly failureCode: string;
  }
) {
  if (error instanceof GitInputError) {
    return context.json(
      {
        success: false,
        error: {
          code: codes.invalidCode
        }
      },
      400
    );
  }

  if (error instanceof GitTimeoutError) {
    return context.json(
      {
        success: false,
        error: {
          code: codes.timeoutCode
        }
      },
      504
    );
  }

  if (error instanceof GitCommandError) {
    return context.json(
      {
        success: false,
        error: {
          code: codes.failureCode
        }
      },
      502
    );
  }

  throw error;
}
