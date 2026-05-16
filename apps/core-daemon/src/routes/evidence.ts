import type { Hono } from "hono";
import { CoreError, type EvidenceService, type RunService, type WorkspaceService } from "@do-soul/alaya-core";

export interface EvidenceRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly runService: RunService;
  readonly evidenceService: EvidenceService;
}

export function registerEvidenceRoutes(app: Hono, services: EvidenceRouteServices): void {
  app.get("/workspaces/:wsId/evidence", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);
    const evidence = await services.evidenceService.findByWorkspaceId(workspaceId);
    return context.json({ success: true, data: evidence }, 200);
  });

  app.get("/runs/:runId/evidence", async (context) => {
    const runId = context.req.param("runId");
    await services.runService.getById(runId);
    const evidence = await services.evidenceService.findByRunId(runId);
    return context.json({ success: true, data: evidence }, 200);
  });

  // invariant: workspace-scoped pointer resolution. Mirrors the MCP
  // soul.open_pointer fallthrough — memory first, then evidence — but
  // limited to the requested workspace so the inspector loopback cannot
  // surface foreign-workspace EvidenceCapsule rows by id alone.
  app.get("/workspaces/:wsId/evidence/:id", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);
    const evidence = await services.evidenceService.findByIdScoped(
      context.req.param("id"),
      workspaceId
    );
    if (evidence === null) {
      throw new CoreError("NOT_FOUND", "Evidence not found in workspace");
    }
    return context.json({ success: true, data: evidence }, 200);
  });
}
