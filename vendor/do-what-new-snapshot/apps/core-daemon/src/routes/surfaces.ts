import type { Hono } from "hono";
import { CoreError, type SurfaceService, type WorkspaceService } from "@do-what/core";
import { parseJsonBody } from "./shared.js";
import { SurfaceAnchorKindSchema, SurfaceStatusSchema, TransitionCausedBySchema } from "@do-what/protocol";

export interface SurfaceRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly surfaceService: SurfaceService;
}

interface CreateSurfacePayload {
  readonly surface_id: string;
  readonly surface_kind: string;
  readonly created_by?: string;
}

interface TransitionSurfaceStatusPayload {
  readonly next_status: string;
  readonly reason: string;
  readonly caused_by?: string;
}

interface CreateAnchorPayload {
  readonly anchor_kind: string;
  readonly anchor_value: string;
  readonly created_by?: string;
}

export function registerSurfaceRoutes(app: Hono, services: SurfaceRouteServices): void {
  app.get("/workspaces/:wsId/surfaces", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const surfaces = await services.surfaceService.findByWorkspace(workspaceId);
    return context.json({ success: true, data: surfaces }, 200);
  });

  app.get("/surfaces/:id", async (context) => {
    const surface = await services.surfaceService.findById(context.req.param("id"));
    return context.json({ success: true, data: surface }, 200);
  });

  app.post("/workspaces/:wsId/surfaces", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const body = (await parseJsonBody(context.req.json.bind(context.req))) as CreateSurfacePayload;

    const created = await services.surfaceService.createSurface({
      surface_id: parseRequiredField(body.surface_id, "surface_id"),
      surface_kind: parseRequiredField(body.surface_kind, "surface_kind"),
      workspace_id: workspaceId,
      created_by: body.created_by?.trim() || "user"
    });

    return context.json({ success: true, data: created }, 201);
  });

  app.patch("/surfaces/:id/status", async (context) => {
    const surfaceObjectId = context.req.param("id");
    const body = (await parseJsonBody(context.req.json.bind(context.req))) as TransitionSurfaceStatusPayload;

    const updated = await services.surfaceService.transitionStatus(
      surfaceObjectId,
      parseSurfaceStatus(body.next_status),
      parseRequiredField(body.reason, "reason"),
      parseTransitionCausedBy(body.caused_by)
    );

    return context.json({ success: true, data: updated }, 200);
  });

  app.get("/surfaces/:surfaceId/anchors", async (context) => {
    const surface = await services.surfaceService.findById(context.req.param("surfaceId"));
    const anchors = await services.surfaceService.listAnchors(surface.surface_id, surface.workspace_id);

    return context.json({ success: true, data: anchors }, 200);
  });

  app.post("/surfaces/:surfaceId/anchors", async (context) => {
    const surface = await services.surfaceService.findById(context.req.param("surfaceId"));
    const body = (await parseJsonBody(context.req.json.bind(context.req))) as CreateAnchorPayload;

    const created = await services.surfaceService.addAnchor({
      surface_id: surface.surface_id,
      anchor_kind: parseAnchorKind(body.anchor_kind),
      anchor_value: parseRequiredField(body.anchor_value, "anchor_value"),
      workspace_id: surface.workspace_id,
      created_by: body.created_by?.trim() || "user"
    });

    return context.json({ success: true, data: created }, 201);
  });

  app.delete("/surface-anchors/:id", async (context) => {
    await services.surfaceService.removeAnchor(context.req.param("id"), "user");
    return context.json({ success: true }, 200);
  });
}

function parseSurfaceStatus(value: string) {
  try {
    return SurfaceStatusSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid surface status", { cause: error });
  }
}

function parseTransitionCausedBy(value: string | undefined) {
  try {
    return TransitionCausedBySchema.parse(value?.trim() || "user");
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid caused_by", { cause: error });
  }
}

function parseAnchorKind(value: string) {
  try {
    return SurfaceAnchorKindSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid anchor_kind", { cause: error });
  }
}

function parseRequiredField(value: string | undefined, field: string): string {
  const trimmed = value?.trim() ?? "";

  if (trimmed.length === 0) {
    throw new CoreError("VALIDATION", `${field} is required`);
  }

  return trimmed;
}
