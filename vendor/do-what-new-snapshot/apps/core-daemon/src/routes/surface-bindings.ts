import type { Hono } from "hono";
import {
  CoreError,
  DEFAULT_ACTOR,
  parseSurfaceUri,
  type CrossCuttingPermissionService,
  type SurfaceBindingService,
  type SurfaceService,
  type WorkspaceService
} from "@do-what/core";
import type { SurfaceAnchorRepo } from "@do-what/storage";
import { parseJsonBody } from "./shared.js";
import { BindingStateSchema, CrossCuttingStateSchema } from "@do-what/protocol";

export interface SurfaceBindingRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly surfaceService: SurfaceService;
  readonly surfaceAnchorRepo: SurfaceAnchorRepo;
  readonly surfaceBindingService: SurfaceBindingService;
  readonly crossCuttingPermissionService: CrossCuttingPermissionService;
}

interface CreateSurfaceBindingPayload {
  readonly object_id: string;
  readonly surface_id: string;
  readonly is_primary?: boolean;
  readonly created_by?: string;
}

interface TransitionBindingStatePayload {
  readonly next_state: string;
  readonly reason: string;
  readonly caused_by?: string;
}

interface CreateCrossCuttingPermissionPayload {
  readonly object_id: string;
  readonly created_by?: string;
}

interface TransitionCrossCuttingStatePayload {
  readonly next_state: string;
  readonly allowed_surfaces?: readonly string[];
  readonly reason: string;
  readonly caused_by?: string;
}

export function registerSurfaceBindingRoutes(app: Hono, services: SurfaceBindingRouteServices): void {
  const surfaceAnchorRepo = services.surfaceAnchorRepo;

  app.get("/workspaces/:wsId/surface-bindings", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const bindings = await services.surfaceBindingService.findBindingsByWorkspace(workspaceId);
    return context.json(
      {
        success: true,
        data: bindings.map((record) => ({ binding_id: record.binding_id, ...record.binding }))
      },
      200
    );
  });

  app.get("/workspaces/:wsId/surface-anchors", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const anchors = await surfaceAnchorRepo.findByWorkspace(workspaceId);
    return context.json({ success: true, data: anchors }, 200);
  });

  app.post("/workspaces/:wsId/surface-bindings", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const body = (await parseJsonBody(context.req.json.bind(context.req))) as CreateSurfaceBindingPayload;
    const surfaceId = parseSurfaceUri(body.surface_id, "surface_id");
    const surface = await services.surfaceService.findBySurfaceId(surfaceId, workspaceId);

    if (surface === null) {
      throw new CoreError("NOT_FOUND", "Surface identity not found");
    }

    const created = await services.surfaceBindingService.bindObject({
      object_id: parseRequiredField(body.object_id, "object_id"),
      surface_id: surfaceId,
      is_primary: body.is_primary ?? true,
      workspace_id: workspaceId,
      created_by: body.created_by?.trim() || DEFAULT_ACTOR
    });

    return context.json({ success: true, data: { binding_id: created.binding_id, ...created.binding } }, 201);
  });

  app.patch("/surface-bindings/:bindingId/state", async (context) => {
    const bindingId = context.req.param("bindingId");
    const existing = await services.surfaceBindingService.findBindingById(bindingId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Surface binding not found");
    }

    await services.workspaceService.getById(existing.binding.workspace_id);

    const body = (await parseJsonBody(context.req.json.bind(context.req))) as TransitionBindingStatePayload;
    const updated = await services.surfaceBindingService.transitionBindingState(
      bindingId,
      parseBindingState(body.next_state),
      parseRequiredField(body.reason, "reason"),
      body.caused_by?.trim() || DEFAULT_ACTOR
    );

    return context.json({ success: true, data: { binding_id: updated.binding_id, ...updated.binding } }, 200);
  });

  app.get("/workspaces/:wsId/cross-cutting-permissions", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const permissions = await services.crossCuttingPermissionService.findCrossCuttingByWorkspace(workspaceId);
    return context.json(
      {
        success: true,
        data: permissions.map((record) => ({ permission_id: record.permission_id, ...record.permission }))
      },
      200
    );
  });

  app.post("/workspaces/:wsId/cross-cutting-permissions", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const body =
      (await parseJsonBody(context.req.json.bind(context.req))) as CreateCrossCuttingPermissionPayload;
    const created = await services.crossCuttingPermissionService.createCrossCuttingPermission({
      object_id: parseRequiredField(body.object_id, "object_id"),
      workspace_id: workspaceId,
      created_by: body.created_by?.trim() || DEFAULT_ACTOR
    });

    return context.json(
      { success: true, data: { permission_id: created.permission_id, ...created.permission } },
      201
    );
  });

  app.patch("/cross-cutting-permissions/:permissionId/state", async (context) => {
    const permissionId = context.req.param("permissionId");
    const existing = await services.crossCuttingPermissionService.findByPermissionId(permissionId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Cross cutting permission not found");
    }

    await services.workspaceService.getById(existing.permission.workspace_id);

    const body =
      (await parseJsonBody(context.req.json.bind(context.req))) as TransitionCrossCuttingStatePayload;

    const updated = await services.crossCuttingPermissionService.transitionCrossCuttingState(
      permissionId,
      parseCrossCuttingState(body.next_state),
      parseAllowedSurfaces(body.allowed_surfaces),
      parseRequiredField(body.reason, "reason"),
      body.caused_by?.trim() || DEFAULT_ACTOR
    );

    return context.json(
      { success: true, data: { permission_id: updated.permission_id, ...updated.permission } },
      200
    );
  });
}

function parseBindingState(value: string) {
  try {
    return BindingStateSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid binding state", { cause: error });
  }
}

function parseCrossCuttingState(value: string) {
  try {
    return CrossCuttingStateSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid cross_cutting_state", { cause: error });
  }
}

function parseAllowedSurfaces(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new CoreError("VALIDATION", "allowed_surfaces must be an array");
  }

  return value.map((surfaceId) => parseSurfaceUri(surfaceId, "allowed_surfaces"));
}


function parseRequiredField(value: string | undefined, field: string): string {
  const trimmed = value?.trim() ?? "";

  if (trimmed.length === 0) {
    throw new CoreError("VALIDATION", `${field} is required`);
  }

  return trimmed;
}
