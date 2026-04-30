import type { ProjectMappingService, WorkspaceService } from "@do-soul/alaya-core";
import {
  AcceptedBy,
  AcceptedBySchema,
  ProjectMappingTransitionActionSchema,
  ProjectMappingStateSchema,
  type ProjectMappingAnchor,
  type ProjectMappingTransitionAction,
  type ProjectMappingState
} from "@do-soul/alaya-protocol";
import type { Hono } from "hono";
import { CoreError, StrictConfirmationRequired } from "@do-soul/alaya-core";

export interface ProjectMappingRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly projectMappingService: ProjectMappingService;
}

export function registerProjectMappingRoutes(app: Hono, services: ProjectMappingRouteServices): void {
  app.get("/soul/project-mapping-anchors", async (context) => {
    const workspaceId = parseRequiredString(context.req.query("workspace_id"), "workspace_id is required");
    await services.workspaceService.getById(workspaceId);

    const mappingState = parseOptionalProjectMappingState(context.req.query("mapping_state"));
    const anchors = await services.projectMappingService.findByWorkspace(workspaceId, mappingState);

    return context.json(
      {
        success: true,
        data: {
          anchors,
          total: anchors.length
        }
      },
      200
    );
  });

  app.post("/soul/project-mapping-anchors", async (context) => {
    const body = await parseCreateRequest(context.req.json.bind(context.req));
    await services.workspaceService.getById(body.workspace_id);

    const anchor = await services.projectMappingService.suggest(
      body.global_object_id,
      body.workspace_id,
      "user"
    );

    return context.json(
      {
        success: true,
        data: {
          anchor
        }
      },
      201
    );
  });

  app.patch("/soul/project-mapping-anchors/:id/transition", async (context) => {
    const mappingId = parseRequiredString(context.req.param("id"), "id is required");
    const body = await parseTransitionRequest(context.req.json.bind(context.req));
    const anchor = await transitionProjectMappingAnchor(services.projectMappingService, mappingId, body);

    return context.json(
      {
        success: true,
        data: {
          anchor
        }
      },
      200
    );
  });

  app.post("/soul/project-mapping-anchors/batch-accept", async (context) => {
    const body = await parseBatchAcceptRequest(context.req.json.bind(context.req));
    await services.workspaceService.getById(body.workspace_id);

    try {
      const anchors = await services.projectMappingService.batchAccept(body.mapping_ids, body.accepted_by);

      return context.json(
        {
          success: true,
          data: {
            anchors
          }
        },
        200
      );
    } catch (error) {
      if (error instanceof StrictConfirmationRequired) {
        return context.json(
          {
            success: false,
            error: "Strict confirmation required",
            strictIds: error.mappingIds
          },
          422
        );
      }

      throw error;
    }
  });
}

async function transitionProjectMappingAnchor(
  service: ProjectMappingService,
  mappingId: string,
  body: {
    readonly action: ProjectMappingTransitionAction;
    readonly accepted_by?: AcceptedBy;
  }
): Promise<ProjectMappingAnchor> {
  switch (body.action) {
    case "accept":
      return await service.accept(mappingId, body.accepted_by ?? AcceptedBy.USER);
    case "reject":
      return await service.reject(mappingId);
    case "adapt":
      return await service.adapt(mappingId);
    case "not_applicable":
      return await service.setNotApplicable(mappingId);
    case "probationary":
      return await service.setProbationary(mappingId);
  }
}

async function parseCreateRequest(readJson: () => Promise< unknown>): Promise<{
  readonly global_object_id: string;
  readonly workspace_id: string;
}> {
  const body = await parseJsonObject(readJson, "Project mapping create request body must be an object");
  return {
    global_object_id: parseRequiredString(body.global_object_id, "global_object_id is required"),
    workspace_id: parseRequiredString(body.workspace_id, "workspace_id is required")
  };
}

async function parseTransitionRequest(readJson: () => Promise< unknown>): Promise<{
  readonly action: ProjectMappingTransitionAction;
  readonly accepted_by?: AcceptedBy;
}> {
  const body = await parseJsonObject(readJson, "Project mapping transition request body must be an object");
  const action = parseTransitionAction(body.action);

  if (action !== "accept") {
    return { action };
  }

  return {
    action,
    accepted_by: parseOptionalAcceptedBy(body.accepted_by) ?? AcceptedBy.USER
  };
}

async function parseBatchAcceptRequest(readJson: () => Promise< unknown>): Promise<{
  readonly mapping_ids: readonly string[];
  readonly workspace_id: string;
  readonly accepted_by: AcceptedBy;
}> {
  const body = await parseJsonObject(readJson, "Project mapping batch accept request body must be an object");
  const mappingIds = body.mapping_ids;

  if (!Array.isArray(mappingIds) || mappingIds.length === 0) {
    throw new CoreError("VALIDATION", "mapping_ids must be a non-empty array");
  }

  return {
    mapping_ids: mappingIds.map((value, index) =>
      parseRequiredString(value, `mapping_ids[${index}] must be a non-empty string`)
    ),
    workspace_id: parseRequiredString(body.workspace_id, "workspace_id is required"),
    accepted_by: parseOptionalAcceptedBy(body.accepted_by) ?? AcceptedBy.USER
  };
}

async function parseJsonObject(
  readJson: () => Promise< unknown>,
  objectMessage: string
): Promise<Record<string, unknown>> {
  let body: unknown;

  try {
    body = await readJson();
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid request body", { cause: error });
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new CoreError("VALIDATION", objectMessage);
  }

  return body as Record<string, unknown>;
}

function parseRequiredString(value: unknown, message: string): string {
  if (typeof value !== "string") {
    throw new CoreError("VALIDATION", message);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new CoreError("VALIDATION", message);
  }

  return trimmed;
}

function parseOptionalAcceptedBy(value: unknown): AcceptedBy | undefined {
  if (value === undefined) {
    return undefined;
  }

  const result = AcceptedBySchema.safeParse(value);
  if (!result.success) {
    throw new CoreError("VALIDATION", "accepted_by must be a valid accepted-by value", {
      cause: result.error
    });
  }

  return result.data;
}

function parseOptionalProjectMappingState(value: string | undefined): ProjectMappingState | undefined {
  if (value === undefined) {
    return undefined;
  }

  const result = ProjectMappingStateSchema.safeParse(value);
  if (!result.success) {
    throw new CoreError("VALIDATION", "mapping_state must be a valid project mapping state", {
      cause: result.error
    });
  }

  return result.data;
}

function parseTransitionAction(value: unknown): ProjectMappingTransitionAction {
  const result = ProjectMappingTransitionActionSchema.safeParse(value);

  if (!result.success) {
    throw new CoreError("VALIDATION", "action must be one of accept, reject, adapt, not_applicable, probationary", {
      cause: result.error
    });
  }

  return result.data;
}
