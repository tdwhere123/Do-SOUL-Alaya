import type { Hono } from "hono";
import type { SoulPathGraphContract } from "@do-soul/alaya-protocol";
import { parseRequiredString } from "../shared/shared.js";

// invariant: the path-graph route is a read-only projection of the unified
// path_relations plane (via core's GraphContractService). The HTTP loopback
// is a memory-tooling surface, not an agent surface; this route never mutates
// and never participates in agent control flow. It is workspace-scoped: the
// workspace is validated before deriving the contract.
// see also: packages/core/src/relations/path-relations/graph-contract-service.ts GraphContractService.derive
export interface PathGraphRouteServices {
  readonly workspaceService: {
    getById(workspaceId: string): Promise<Readonly<{ readonly workspace_id: string }>>;
  };
  readonly graphContractService: {
    derive(workspaceId: string): Promise<Readonly<SoulPathGraphContract>>;
  };
}

export function registerPathGraphRoutes(app: Hono, services: PathGraphRouteServices): void {
  app.get("/workspaces/:workspaceId/path-graph", async (context) => {
    const workspaceId = parseRequiredString(
      context.req.param("workspaceId"),
      "workspaceId is required"
    );
    await services.workspaceService.getById(workspaceId);

    const graph = await services.graphContractService.derive(workspaceId);

    return context.json({ success: true, data: graph }, 200);
  });
}
