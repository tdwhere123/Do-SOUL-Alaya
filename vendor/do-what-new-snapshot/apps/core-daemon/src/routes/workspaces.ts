import { TransformStream } from "node:stream/web";
import type { Hono } from "hono";
import {
  CoreError,
  type EngineBindingService,
  type WorkspaceService
} from "@do-what/core";
import {
  WorkspaceCreateInputSchema,
  WorkspaceEngineConfigUpdateSchema,
  WorkspaceGitBindingSchema,
  WorkspaceGitBindingUpdateSchema,
  type Workspace,
  type WorkspaceEngineConfig
} from "@do-what/protocol";
import type { SseManager } from "../sse/sse-manager.js";
import {
  getWorkspaceGitBindingStatus,
  validateWorkspaceGitBindingInput,
  type GitBindingStatusResult,
  type GitBindingValidationOptions
} from "../git-binding/validator.js";
import { parseJsonBody } from "./shared.js";

export interface WorkspaceGitBindingRepo {
  getById(id: string): Promise<Workspace | null>;
  updateRepoPath(id: string, repoPath: Workspace["repo_path"]): Promise<Workspace>;
}

export interface WorkspaceRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly engineBindingService: EngineBindingService;
  readonly sseManager: SseManager;
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
    const workspaces = await Promise.all(
      (await services.workspaceService.list()).map(async (workspace) =>
        await sanitizeWorkspaceForGenericRead(workspace, services.gitBindingValidation)
      )
    );
    return context.json({ success: true, data: workspaces }, 200);
  });

  app.get("/workspaces/:id", async (context) => {
    const workspace = await sanitizeWorkspaceForGenericRead(
      await services.workspaceService.getById(context.req.param("id")),
      services.gitBindingValidation
    );
    return context.json({ success: true, data: workspace }, 200);
  });

  app.get("/workspaces/:id/events", async (context) => {
    const workspaceId = context.req.param("id");
    const lastEventId = context.req.header("Last-Event-ID");
    const isReconnect = lastEventId !== undefined && lastEventId.trim().length > 0;
    const initialCursor = await services.sseManager.getLatestWorkspaceEventId(workspaceId);

    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    const connectionId = services.sseManager.subscribeWorkspace(workspaceId, writer);

    try {
      await services.workspaceService.getById(workspaceId);
    } catch (error) {
      services.sseManager.unsubscribeWorkspace(connectionId);
      throw error;
    }

    void writer.closed
      .catch(() => {
        // writer.closed rejects on normal client disconnect — no action needed
      })
      .finally(() => {
        services.sseManager.unsubscribeWorkspace(connectionId);
      });

    void (async () => {
      await services.sseManager.sendWorkspaceConnected(connectionId, workspaceId, initialCursor, isReconnect);

      if (isReconnect) {
        await services.sseManager.replayWorkspaceFrom(workspaceId, lastEventId, connectionId);
      } else {
        await services.sseManager.replayWorkspaceFrom(
          workspaceId,
          initialCursor ?? "__do_what_initial_cursor__",
          connectionId
        );
      }

      services.sseManager.markReplayComplete(connectionId);
    })().catch((error: unknown) => {
      console.error("Workspace SSE connect init failed", { workspaceId, connectionId, error });
      services.sseManager.unsubscribeWorkspace(connectionId);
    });

    const onAbort = (): void => {
      services.sseManager.unsubscribeWorkspace(connectionId);
    };

    context.req.raw.signal.addEventListener("abort", onAbort, { once: true });

    return new Response(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      }
    });
  });

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
