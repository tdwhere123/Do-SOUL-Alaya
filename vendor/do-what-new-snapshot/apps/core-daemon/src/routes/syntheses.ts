import type { Hono } from "hono";
import { CoreError, type SynthesisService, type WorkspaceService } from "@do-what/core";

export interface SynthesisRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly synthesisService: SynthesisService;
}

export function registerSynthesisRoutes(app: Hono, services: SynthesisRouteServices): void {
  app.get("/workspaces/:wsId/syntheses", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const syntheses = await services.synthesisService.findByWorkspaceId(workspaceId);
    return context.json({ success: true, data: syntheses }, 200);
  });

  app.get("/syntheses/:id", async (context) => {
    const synthesis = await services.synthesisService.findById(context.req.param("id"));

    if (synthesis === null) {
      throw new CoreError("NOT_FOUND", "Synthesis capsule not found");
    }

    return context.json({ success: true, data: synthesis }, 200);
  });
}
