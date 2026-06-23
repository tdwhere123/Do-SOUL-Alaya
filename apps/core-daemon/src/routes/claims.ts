import type { Hono } from "hono";
import { CoreError, type ClaimService, type WorkspaceService } from "@do-soul/alaya-core";

export interface ClaimRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly claimService: ClaimService;
}

export function registerClaimRoutes(app: Hono, services: ClaimRouteServices): void {
  app.get("/workspaces/:wsId/claims", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const claims = await services.claimService.findByWorkspaceId(workspaceId);
    return context.json({ success: true, data: claims }, 200);
  });

  app.get("/workspaces/:wsId/claims/:id", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const claim = await services.claimService.findByIdScoped(context.req.param("id"), workspaceId);

    if (claim === null) {
      throw new CoreError("NOT_FOUND", "Claim form not found");
    }

    return context.json({ success: true, data: claim }, 200);
  });
}
