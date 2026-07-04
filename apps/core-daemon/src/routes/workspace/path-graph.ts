import type { Hono } from "hono";
import { CoreError } from "@do-soul/alaya-core";
import type { SoulPathGraphContract } from "@do-soul/alaya-protocol";

// invariant: the path-graph route is a read-only projection of the unified
// path_relations plane (via core's GraphContractService). The Inspector is a
// memory-tooling loopback, not an agent surface; this route never mutates and
// never participates in agent control flow. It is workspace-scoped: the
// workspace is validated before deriving the contract.
// see also: packages/core/src/path-graph/graph-contract-service.ts GraphContractService.derive
//           apps/inspector/web/src/pages/Graph.tsx (BuiltPathGraph consumer)
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

function parseRequiredString(value: string | undefined, message: string): string {
  if (value === undefined) {
    throw new CoreError("VALIDATION", message);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new CoreError("VALIDATION", message);
  }

  return trimmed;
}
