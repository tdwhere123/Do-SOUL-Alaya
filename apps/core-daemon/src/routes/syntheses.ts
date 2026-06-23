import type { Hono } from "hono";
import { CoreError, type SynthesisService, type WorkspaceService } from "@do-soul/alaya-core";

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

  app.get("/workspaces/:wsId/syntheses/:id", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const synthesis = await services.synthesisService.findByIdScoped(context.req.param("id"), workspaceId);

    if (synthesis === null) {
      throw new CoreError("NOT_FOUND", "Synthesis capsule not found");
    }

    return context.json({ success: true, data: synthesis }, 200);
  });
}
