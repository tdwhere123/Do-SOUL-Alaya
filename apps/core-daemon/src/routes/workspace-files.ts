import type { Context, Hono } from "hono";
import { CoreError } from "@do-soul/alaya-core";
import { parseWorkspaceGitLogLimit } from "@do-soul/alaya-protocol";
import {
  getWorkspaceGitBindingStatus,
  type GitBindingValidationOptions
} from "./workspaces.js";
import { aggregateChangedFiles } from "./workspace-files-aggregate.js";
import {
  GitCommandError,
  GitInputError,
  GitTimeoutError,
  type WorkspaceFilesRouteServices
} from "./workspace-files-types.js";
export { GitCommandError, GitInputError, GitTimeoutError } from "./workspace-files-types.js";
export type { GitDiffService, GitLogService, WorkspaceFilesRouteServices } from "./workspace-files-types.js";

export function registerWorkspaceFileRoutes(
  app: Hono,
  services: WorkspaceFilesRouteServices
): void {
  const gitRateLimiter = services.gitRateLimiter ?? createWorkspaceGitRateLimiter();
  registerChangedFilesRoute(app, services);
  registerFileDiffRoute(app, services, gitRateLimiter);
  registerGitLogRoute(app, services, gitRateLimiter);
}

function registerChangedFilesRoute(app: Hono, services: WorkspaceFilesRouteServices): void {
  app.get("/workspaces/:id/files/changed", async (context) => {
    return await listChangedFiles(context, services);
  });
}

function registerFileDiffRoute(
  app: Hono,
  services: WorkspaceFilesRouteServices,
  gitRateLimiter: { allow(workspaceId: string): boolean }
): void {
  app.get("/workspaces/:id/files/diff", async (context) => {
    return await getFileDiff(context, services, gitRateLimiter);
  });
}

function registerGitLogRoute(
  app: Hono,
  services: WorkspaceFilesRouteServices,
  gitRateLimiter: { allow(workspaceId: string): boolean }
): void {
  app.get("/workspaces/:id/git/log", async (context) => {
    return await listGitLog(context, services, gitRateLimiter);
  });
}

async function listChangedFiles(context: Context, services: WorkspaceFilesRouteServices): Promise<Response> {
  assertToolExecutionRecordRepo(services);
  const workspaceId = context.req.param("id")!;
  const workspace = await services.workspaceService.getById(workspaceId);
  const includeExec = parseIncludeExecQuery(context);
  if (includeExec instanceof Response) return includeExec;
  if (includeExec) return unsupportedExecParsing(context);
  const runId = context.req.query("runId");
  if (runId === undefined || runId.length === 0) return invalidRefArg(context);
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
}

function assertToolExecutionRecordRepo(services: WorkspaceFilesRouteServices): void {
  if (services.toolExecutionRecordRepo === undefined) {
    throw new CoreError("CONFLICT", "tool execution record persistence is unavailable on this backend");
  }
}

function parseIncludeExecQuery(context: Context): boolean | Response {
  try {
    return parseOptionalBooleanQuery(context.req.query("include_exec"));
  } catch (error) {
    if (error instanceof GitInputError) return invalidRefArg(context);
    throw error;
  }
}

async function getFileDiff(
  context: Context,
  services: WorkspaceFilesRouteServices,
  gitRateLimiter: { allow(workspaceId: string): boolean }
): Promise<Response> {
  const gitDiffService = requireGitDiffService(services);
  const binding = await resolveBoundWorkspace(context, services);
  if (binding instanceof Response) return binding;
  const requestedPath = context.req.query("path");
  if (requestedPath === undefined || requestedPath.length === 0) return invalidRefArg(context);
  const limited = rejectRateLimited(context, binding.workspaceId, gitRateLimiter);
  if (limited !== null) return limited;
  try {
    const diff = await gitDiffService.getFileDiff({
      repoPath: binding.repoPath,
      path: requestedPath,
      since: context.req.query("since"),
      against: context.req.query("against"),
      signal: context.req.raw.signal
    });
    return context.json({ success: true, data: fileDiffResponse(binding.workspaceId, diff) }, 200);
  } catch (error) {
    return mapGitRouteError(context, error, gitDiffErrorCodes);
  }
}

async function listGitLog(
  context: Context,
  services: WorkspaceFilesRouteServices,
  gitRateLimiter: { allow(workspaceId: string): boolean }
): Promise<Response> {
  const gitLogService = requireGitLogService(services);
  const binding = await resolveBoundWorkspace(context, services);
  if (binding instanceof Response) return binding;
  try {
    const limit = parseGitLogLimit(context.req.query("limit"));
    const limited = rejectRateLimited(context, binding.workspaceId, gitRateLimiter);
    if (limited !== null) return limited;
    const gitLog = await gitLogService.listGitLog({
      repoPath: binding.repoPath,
      limit,
      path: context.req.query("path"),
      signal: context.req.raw.signal
    });
    return context.json({ success: true, data: gitLogResponse(binding.workspaceId, gitLog) }, 200);
  } catch (error) {
    return mapGitRouteError(context, error, gitLogErrorCodes);
  }
}

function requireGitDiffService(services: WorkspaceFilesRouteServices) {
  if (services.gitDiffService === undefined) {
    throw new CoreError("CONFLICT", "git diff service is unavailable on this backend");
  }
  return services.gitDiffService;
}

function requireGitLogService(services: WorkspaceFilesRouteServices) {
  if (services.gitLogService === undefined) {
    throw new CoreError("CONFLICT", "git log service is unavailable on this backend");
  }
  return services.gitLogService;
}

async function resolveBoundWorkspace(context: Context, services: WorkspaceFilesRouteServices) {
  const workspace = await services.workspaceService.getById(context.req.param("id")!);
  const status = await getWorkspaceGitBindingStatus(workspace.repo_path, services.gitBindingValidation);
  if (status.status !== "bound" || status.repo_path === null) return workspaceNotBound(context, status.status);
  return { workspaceId: workspace.workspace_id, repoPath: status.repo_path };
}

function rejectRateLimited(
  context: Context,
  workspaceId: string,
  gitRateLimiter: { allow(workspaceId: string): boolean }
): Response | null {
  return gitRateLimiter.allow(workspaceId) ? null : context.json({ success: false, error: { code: "rate_limited" } }, 429);
}

function invalidRefArg(context: Context): Response {
  return context.json({ success: false, error: { code: "invalid_ref_arg" } }, 400);
}

function unsupportedExecParsing(context: Context): Response {
  return context.json({ success: false, error: { code: "exec_parsing_unavailable" } }, 501);
}

function workspaceNotBound(context: Context, status: string): Response {
  return context.json({ success: false, error: { code: "workspace_not_bound", status } }, 409);
}

const gitDiffErrorCodes = {
  invalidCode: "invalid_ref_arg",
  timeoutCode: "git_diff_timeout",
  failureCode: "git_diff_failed"
} as const;

const gitLogErrorCodes = {
  invalidCode: "invalid_ref_arg",
  timeoutCode: "git_log_timeout",
  failureCode: "git_log_failed"
} as const;

function fileDiffResponse(
  workspaceId: string,
  diff: Awaited<ReturnType<NonNullable<WorkspaceFilesRouteServices["gitDiffService"]>["getFileDiff"]>>
) {
  return {
    workspace_id: workspaceId,
    repo_path: diff.repoPath,
    path: diff.path,
    since: diff.since,
    against: diff.against,
    binary: diff.binary,
    deleted: diff.deleted,
    added: diff.added,
    unified_diff: diff.unifiedDiff,
    ...(diff.truncated ? { truncated: true } : {})
  };
}

function gitLogResponse(
  workspaceId: string,
  gitLog: Awaited<ReturnType<NonNullable<WorkspaceFilesRouteServices["gitLogService"]>["listGitLog"]>>
) {
  return {
    workspace_id: workspaceId,
    repo_path: gitLog.repoPath,
    commits: gitLog.commits,
    ...(gitLog.truncated ? { truncated: true } : {})
  };
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
