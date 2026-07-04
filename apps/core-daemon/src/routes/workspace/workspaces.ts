import type { Context, Hono } from "hono";
import {
  CoreError,
  type EngineBindingService,
  type WorkspaceService
} from "@do-soul/alaya-core";
import {
  WorkspaceCreateInputSchema,
  WorkspaceEngineConfigUpdateSchema,
  WorkspaceGitBindingUpdateSchema,
  type Workspace,
  type WorkspaceEngineConfig
} from "@do-soul/alaya-protocol";
import {
  parseJsonBody,
  parseListPagination,
  rejectUnexpectedRequestBody,
  writeListPaginationHeaders
} from "../shared/shared.js";
import {
  buildWorkspaceGitBindingResponse,
  getWorkspaceGitBindingStatus,
  sanitizeWorkspaceForGenericRead,
  validateWorkspaceGitBindingInput,
  type GitBindingValidationOptions,
  type WorkspaceGitBindingRepo
} from "./workspace-git-binding.js";
export type {
  GitBindingStatusResult,
  GitBindingValidationErrorCode,
  GitBindingValidationOptions,
  GitBindingValidationResult,
  WorkspaceGitBindingRepo
} from "./workspace-git-binding.js";
export { getWorkspaceGitBindingStatus } from "./workspace-git-binding.js";

export interface WorkspaceRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly engineBindingService: EngineBindingService;
  readonly codingEngineAvailable: boolean;
  readonly workspaceGitBindingRepo?: WorkspaceGitBindingRepo;
  readonly gitBindingValidation?: GitBindingValidationOptions;
}

export function registerWorkspaceRoutes(app: Hono, services: WorkspaceRouteServices): void {
  registerWorkspaceCrudRoutes(app, services);
  registerWorkspaceEngineBindingRoutes(app, services);
  registerWorkspaceGitBindingRoutes(app, services);
  registerWorkspaceEngineConfigRoutes(app, services);
}

function registerWorkspaceCrudRoutes(app: Hono, services: WorkspaceRouteServices): void {
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

  app.delete("/workspaces/:id", async (context) => {
    const unexpectedBody = await rejectUnexpectedRequestBody(context);
    if (unexpectedBody !== null) return unexpectedBody;
    const workspace = await services.workspaceService.delete(context.req.param("id"));
    return context.json({ success: true, data: workspace }, 200);
  });
}

function registerWorkspaceEngineBindingRoutes(app: Hono, services: WorkspaceRouteServices): void {
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
}

function registerWorkspaceGitBindingRoutes(app: Hono, services: WorkspaceRouteServices): void {
  app.get("/workspaces/:id/git-binding", async (context) => {
    const workspace = await services.workspaceService.getById(context.req.param("id"));
    const status = await getWorkspaceGitBindingStatus(workspace.repo_path, services.gitBindingValidation);
    return context.json(
      { success: true, data: buildWorkspaceGitBindingResponse(workspace.workspace_id, status) },
      200
    );
  });

  app.put("/workspaces/:id/git-binding", async (context) => {
    return await updateWorkspaceGitBinding(context.req.param("id"), await parseJsonBody(context.req.json.bind(context.req)), context, services);
  });
}

async function updateWorkspaceGitBinding(
  workspaceId: string,
  rawBody: unknown,
  context: Context,
  services: WorkspaceRouteServices
): Promise<Response> {
  const repo = requireWorkspaceGitBindingRepo(services);
  await services.workspaceService.getById(workspaceId);
  const update = parseWorkspaceGitBindingUpdate(rawBody);
  if (update.repo_path === null) {
    return await writeGitBindingUpdate(context, repo, workspaceId, null, services);
  }
  const validation = await validateWorkspaceGitBindingInput(update.repo_path, services.gitBindingValidation);
  if (!validation.ok) {
    return context.json(
      { success: false, error: { code: validation.code, detail: validation.detail } },
      400
    );
  }
  return await writeGitBindingUpdate(context, repo, workspaceId, validation.repo_path, services);
}

function requireWorkspaceGitBindingRepo(services: WorkspaceRouteServices): WorkspaceGitBindingRepo {
  if (services.workspaceGitBindingRepo === undefined) {
    throw new CoreError("CONFLICT", "workspace git binding persistence is unavailable on this backend");
  }
  return services.workspaceGitBindingRepo;
}

async function writeGitBindingUpdate(
  context: Context,
  repo: WorkspaceGitBindingRepo,
  workspaceId: string,
  repoPath: string | null,
  services: WorkspaceRouteServices
): Promise<Response> {
  const workspace = await repo.updateRepoPath(workspaceId, repoPath);
  const status = await getWorkspaceGitBindingStatus(workspace.repo_path, services.gitBindingValidation);
  return context.json(
    { success: true, data: buildWorkspaceGitBindingResponse(workspace.workspace_id, status) },
    200
  );
}

function registerWorkspaceEngineConfigRoutes(app: Hono, services: WorkspaceRouteServices): void {
  app.get("/workspaces/:id/engine-config", async (context) => {
    const id = context.req.param("id");
    const [workspace, conversationBinding] = await Promise.all([
      services.workspaceService.getById(id),
      services.engineBindingService.getWorkspaceBinding(id)
    ]);
    return context.json({ success: true, data: buildConfigResponse(services, workspace, conversationBinding) }, 200);
  });

  app.put("/workspaces/:id/engine-config", async (context) => {
    return await updateWorkspaceEngineConfig(
      context.req.param("id"),
      await parseJsonBody(context.req.json.bind(context.req)),
      context,
      services
    );
  });
}

async function updateWorkspaceEngineConfig(
  workspaceId: string,
  rawBody: unknown,
  context: Context,
  services: WorkspaceRouteServices
): Promise<Response> {
  const update = parseWorkspaceEngineConfigUpdate(rawBody);
  if (update.default_engine_class === "conversation_engine") {
    return await updateConversationEngineConfig(context, services, workspaceId, update);
  }
  return await updateCodingEngineConfig(context, services, workspaceId);
}

async function updateConversationEngineConfig(
  context: Context,
  services: WorkspaceRouteServices,
  workspaceId: string,
  update: ReturnType<typeof parseWorkspaceEngineConfigUpdate>
): Promise<Response> {
  if (update.conversation_binding !== undefined) {
    const persisted = await services.workspaceService.updateConversationEngineConfig(
      workspaceId,
      update.conversation_binding
    );
    return context.json({ success: true, data: buildConfigResponse(services, persisted.workspace, persisted.binding) }, 200);
  }
  const binding = await services.engineBindingService.getWorkspaceBinding(workspaceId);
  if (binding === null) {
    throw new CoreError("CONFLICT", "conversation_engine requires an existing workspace engine binding");
  }
  const workspace = await services.workspaceService.updateDefaultEngineClass(workspaceId, "conversation_engine");
  return context.json({ success: true, data: buildConfigResponse(services, workspace, binding) }, 200);
}

async function updateCodingEngineConfig(
  context: Context,
  services: WorkspaceRouteServices,
  workspaceId: string
): Promise<Response> {
  if (!services.codingEngineAvailable) {
    throw new CoreError("CONFLICT", "coding_engine is not available for principal runs on this backend");
  }
  const workspace = await services.workspaceService.updateDefaultEngineClass(workspaceId, "coding_engine");
  const existingBinding = await services.engineBindingService.getWorkspaceBinding(workspace.workspace_id);
  return context.json({ success: true, data: buildConfigResponse(services, workspace, existingBinding) }, 200);
}

function buildConfigResponse(
  services: WorkspaceRouteServices,
  workspace: Pick<Workspace, "workspace_id" | "default_engine_class">,
  binding: EngineBindingSummary | null
): WorkspaceEngineConfig {
  return services.workspaceService.buildEngineConfig({
    workspace_id: workspace.workspace_id,
    default_engine_class: workspace.default_engine_class ?? null,
    conversation_binding: toBindingSummary(binding),
    coding_engine_available: services.codingEngineAvailable
  });
}

type EngineBindingSummary = {
  readonly provider_type: string;
  readonly base_url: string | null;
  readonly model: string;
};

function toBindingSummary(binding: EngineBindingSummary | null): WorkspaceEngineConfig["conversation_binding"] {
  if (binding === null) return null;
  return {
    provider_type: binding.provider_type as "custom" | "openai" | "anthropic",
    base_url: binding.base_url,
    model: binding.model
  };
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
