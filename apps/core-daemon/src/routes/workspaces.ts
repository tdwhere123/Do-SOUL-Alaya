import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Hono } from "hono";
import {
  CoreError,
  type EngineBindingService,
  type WorkspaceService
} from "@do-soul/alaya-core";
import {
  WorkspaceCreateInputSchema,
  WorkspaceEngineConfigUpdateSchema,
  WorkspaceGitBindingSchema,
  WorkspaceGitBindingUpdateSchema,
  type Workspace,
  type WorkspaceEngineConfig,
  type WorkspaceGitBindingStatus
} from "@do-soul/alaya-protocol";
import {
  parseJsonBody,
  parseListPagination,
  rejectUnexpectedRequestBody,
  writeListPaginationHeaders
} from "./shared.js";

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

export interface WorkspaceRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly engineBindingService: EngineBindingService;
  readonly codingEngineAvailable: boolean;
  readonly workspaceGitBindingRepo?: WorkspaceGitBindingRepo;
  readonly gitBindingValidation?: GitBindingValidationOptions;
}

export function registerWorkspaceRoutes(app: Hono, services: WorkspaceRouteServices): void {
  app.post("/workspaces", async (context) => {
    const createInput = parseWorkspaceCreateInput(
      await parseJsonBody(context.req.json.bind(context.req))
    );
    const workspace = await services.workspaceService.create(
      await withValidatedRepoPath(createInput, services.gitBindingValidation)
    );
    return context.json({ success: true, data: workspace }, 201);
  });

  app.get("/workspaces", async (context) => {
    const pagination = parseListPagination(context);
    const workspaces = await Promise.all(
      (await services.workspaceService.list(pagination)).map(async (workspace) =>
        await sanitizeWorkspaceForGenericRead(workspace, services.gitBindingValidation)
      )
    );
    const totalCount = await services.workspaceService.count();
    writeListPaginationHeaders(context, totalCount, pagination);
    return context.json({ success: true, data: workspaces }, 200);
  });

  app.get("/workspaces/:id", async (context) => {
    const workspace = await sanitizeWorkspaceForGenericRead(
      await services.workspaceService.getById(context.req.param("id")),
      services.gitBindingValidation
    );
    return context.json({ success: true, data: workspace }, 200);
  });

  // P4-sse-strip: prune SSE-only workspace events endpoint for Alaya.

  app.get("/workspaces/:id/engine-binding", async (context) => {
    const binding = await services.engineBindingService.getWorkspaceBinding(context.req.param("id"));
    return context.json({ success: true, data: binding }, 200);
  });

  app.put("/workspaces/:id/engine-binding", async (context) => {
    const binding = await services.engineBindingService.saveWorkspaceBinding(
      context.req.param("id"),
      await parseJsonBody(context.req.json.bind(context.req))
    );
    return context.json({ success: true, data: binding }, 200);
  });

  app.post("/workspaces/:id/engine-binding/test", async (context) => {
    const result = await services.engineBindingService.testWorkspaceBinding(
      context.req.param("id"),
      await parseJsonBody(context.req.json.bind(context.req))
    );
    return context.json({ success: true, data: result }, 200);
  });

  app.get("/workspaces/:id/git-binding", async (context) => {
    const workspace = await services.workspaceService.getById(context.req.param("id"));
    const status = await getWorkspaceGitBindingStatus(workspace.repo_path, services.gitBindingValidation);
    return context.json(
      {
        success: true,
        data: buildWorkspaceGitBindingResponse(workspace.workspace_id, status)
      },
      200
    );
  });

  app.put("/workspaces/:id/git-binding", async (context) => {
    if (services.workspaceGitBindingRepo === undefined) {
      throw new CoreError("CONFLICT", "workspace git binding persistence is unavailable on this backend");
    }

    const workspaceId = context.req.param("id");
    await services.workspaceService.getById(workspaceId);
    const update = parseWorkspaceGitBindingUpdate(
      await parseJsonBody(context.req.json.bind(context.req))
    );

    if (update.repo_path === null) {
      const workspace = await services.workspaceGitBindingRepo.updateRepoPath(workspaceId, null);
      const status = await getWorkspaceGitBindingStatus(workspace.repo_path, services.gitBindingValidation);
      return context.json(
        {
          success: true,
          data: buildWorkspaceGitBindingResponse(workspace.workspace_id, status)
        },
        200
      );
    }

    const validation = await validateWorkspaceGitBindingInput(update.repo_path, services.gitBindingValidation);

    if (!validation.ok) {
      return context.json(
        {
          success: false,
          error: {
            code: validation.code,
            detail: validation.detail
          }
        },
        400
      );
    }

    const workspace = await services.workspaceGitBindingRepo.updateRepoPath(workspaceId, validation.repo_path);
    const status = await getWorkspaceGitBindingStatus(workspace.repo_path, services.gitBindingValidation);
    return context.json(
      {
        success: true,
        data: buildWorkspaceGitBindingResponse(workspace.workspace_id, status)
      },
      200
    );
  });

  const toBindingSummary = (
    binding: { readonly provider_type: string; readonly base_url: string | null; readonly model: string } | null
  ): WorkspaceEngineConfig["conversation_binding"] =>
    binding === null
      ? null
      : { provider_type: binding.provider_type as "custom" | "openai" | "anthropic", base_url: binding.base_url, model: binding.model };

  const buildConfigResponse = (
    workspace: Pick<Workspace, "workspace_id" | "default_engine_class">,
    binding: { readonly provider_type: string; readonly base_url: string | null; readonly model: string } | null
  ) =>
    services.workspaceService.buildEngineConfig({
      workspace_id: workspace.workspace_id,
      default_engine_class: workspace.default_engine_class ?? null,
      conversation_binding: toBindingSummary(binding),
      coding_engine_available: services.codingEngineAvailable
    });

  app.get("/workspaces/:id/engine-config", async (context) => {
    const id = context.req.param("id");
    const [workspace, conversationBinding] = await Promise.all([
      services.workspaceService.getById(id),
      services.engineBindingService.getWorkspaceBinding(id)
    ]);
    return context.json({ success: true, data: buildConfigResponse(workspace, conversationBinding) }, 200);
  });

  app.put("/workspaces/:id/engine-config", async (context) => {
    const workspaceId = context.req.param("id");
    const update = parseWorkspaceEngineConfigUpdate(
      await parseJsonBody(context.req.json.bind(context.req))
    );

    if (update.default_engine_class === "conversation_engine") {
      if (update.conversation_binding !== undefined) {
        const persisted = await services.workspaceService.updateConversationEngineConfig(
          workspaceId,
          update.conversation_binding
        );
        return context.json({ success: true, data: buildConfigResponse(persisted.workspace, persisted.binding) }, 200);
      }

      const binding = await services.engineBindingService.getWorkspaceBinding(workspaceId);

      if (binding === null) {
        throw new CoreError(
          "CONFLICT",
          "conversation_engine requires an existing workspace engine binding"
        );
      }

      const workspace = await services.workspaceService.updateDefaultEngineClass(
        workspaceId,
        "conversation_engine"
      );
      return context.json({ success: true, data: buildConfigResponse(workspace, binding) }, 200);
    }

    if (!services.codingEngineAvailable) {
      throw new CoreError(
        "CONFLICT",
        "coding_engine is not available for principal runs on this backend"
      );
    }

    const workspace = await services.workspaceService.updateDefaultEngineClass(
      workspaceId,
      "coding_engine"
    );
    const existingBinding = await services.engineBindingService.getWorkspaceBinding(workspace.workspace_id);
    return context.json({ success: true, data: buildConfigResponse(workspace, existingBinding) }, 200);
  });

  app.delete("/workspaces/:id", async (context) => {
    const unexpectedBody = await rejectUnexpectedRequestBody(context);
    if (unexpectedBody !== null) return unexpectedBody;
    const workspace = await services.workspaceService.delete(context.req.param("id"));
    return context.json({ success: true, data: workspace }, 200);
  });
}

function parseWorkspaceEngineConfigUpdate(input: unknown) {
  try {
    return WorkspaceEngineConfigUpdateSchema.parse(input);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid request body", { cause: error });
  }
}

function parseWorkspaceCreateInput(input: unknown) {
  try {
    return WorkspaceCreateInputSchema.parse(input);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid request body", { cause: error });
  }
}

function parseWorkspaceGitBindingUpdate(input: unknown) {
  try {
    return WorkspaceGitBindingUpdateSchema.parse(input);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid request body", { cause: error });
  }
}

async function withValidatedRepoPath(
  input: ReturnType<typeof parseWorkspaceCreateInput>,
  validationOptions: GitBindingValidationOptions | undefined
) {
  if (input.repo_path === undefined) {
    return input;
  }

  if (input.repo_path === null) {
    return input;
  }

  const validation = await validateWorkspaceGitBindingInput(input.repo_path, validationOptions);

  if (!validation.ok) {
    throw new CoreError("VALIDATION", validation.detail);
  }

  return {
    ...input,
    repo_path: validation.repo_path
  };
}

function buildWorkspaceGitBindingResponse(
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

async function sanitizeWorkspaceForGenericRead(
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
  } catch {
    return {
      ok: false,
      code: "path_not_found",
      detail: "repo_path could not be resolved."
    };
  }

  let resolvedStat: Awaited<ReturnType<typeof stat>>;

  try {
    resolvedStat = await stat(resolvedPath);
  } catch {
    return {
      ok: false,
      code: "path_not_found",
      detail: "repo_path could not be resolved."
    };
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
    } catch {
      // Invalid configured roots must not broaden the allowlist.
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
  } catch {
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
  } catch {
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
  } catch {
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
  } catch {
    return null;
  }

  try {
    const resolvedStats = await stat(resolvedGitDirPath);
    return resolvedStats.isDirectory() ? resolvedGitDirPath : null;
  } catch {
    return null;
  }
}

function isPathWithinAllowedRoots(allowedRoots: readonly string[], candidate: string): boolean {
  return allowedRoots.some((root) => isWithinAllowedRoot(root, candidate));
}
