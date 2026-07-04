import type { Hono } from "hono";
import type { SecurityStatusContract } from "@do-soul/alaya-protocol";
import type { WorkspaceService } from "@do-soul/alaya-core";

export interface SecurityStatusRouteServices {
  readonly workspaceService: Pick<WorkspaceService, "getById">;
  readonly securityStatusService: {
    getStatus(workspaceId: string): Promise<SecurityStatusContract>;
  };
}

export function registerSecurityStatusRoutes(
  app: Hono,
  services: SecurityStatusRouteServices
): void {
  app.get("/workspaces/:wsId/security-status", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);
    const status = await services.securityStatusService.getStatus(workspaceId);
    return context.json({ success: true, data: status }, 200);
  });
}
