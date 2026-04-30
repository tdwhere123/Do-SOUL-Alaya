import type { Hono } from "hono";
import { CoreError, type ArbitrationService, type WorkspaceService } from "@do-soul/alaya-core";
import { parseJsonBody } from "./shared.js";
import { ConflictEdgeTypeSchema } from "@do-soul/alaya-protocol";

export interface ConflictMatrixRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly arbitrationService: ArbitrationService;
}

interface CreateEdgePayload {
  readonly source_claim_id: string;
  readonly target_claim_id: string;
  readonly edge_type: string;
  readonly created_by?: string;
}

export function registerConflictMatrixRoutes(app: Hono, services: ConflictMatrixRouteServices): void {
  app.get("/workspaces/:wsId/conflict-matrix-edges", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const edges = await services.arbitrationService.listEdgesByWorkspace(workspaceId);
    return context.json({ success: true, data: edges }, 200);
  });

  app.post("/conflict-matrix-edges", async (context) => {
    const body = (await parseJsonBody(context.req.json.bind(context.req))) as CreateEdgePayload;
    const payload = parseCreateEdgePayload(body);

    const created = await services.arbitrationService.createEdge({
      source_claim_id: payload.source_claim_id,
      target_claim_id: payload.target_claim_id,
      edge_type: payload.edge_type,
      created_by: payload.created_by ?? "user_action"
    });

    return context.json({ success: true, data: created }, 201);
  });

  app.delete("/conflict-matrix-edges/:id", async (context) => {
    await services.arbitrationService.deleteEdge(context.req.param("id"));
    return context.json({ success: true, data: null }, 200);
  });

  app.post("/workspaces/:wsId/conflict-matrix/rebuild", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const result = await services.arbitrationService.rebuildConflictMatrix(workspaceId);
    return context.json({ success: true, data: result }, 200);
  });
}

function parseCreateEdgePayload(value: CreateEdgePayload): {
  readonly source_claim_id: string;
  readonly target_claim_id: string;
  readonly edge_type: ReturnType<typeof ConflictEdgeTypeSchema.parse>;
  readonly created_by?: string;
} {
  const sourceClaimId = value.source_claim_id?.trim() ?? "";
  const targetClaimId = value.target_claim_id?.trim() ?? "";

  if (sourceClaimId.length === 0) {
    throw new CoreError("VALIDATION", "source_claim_id is required");
  }

  if (targetClaimId.length === 0) {
    throw new CoreError("VALIDATION", "target_claim_id is required");
  }

  if (sourceClaimId === targetClaimId) {
    throw new CoreError("VALIDATION", "source_claim_id and target_claim_id must be different");
  }

  try {
    return {
      source_claim_id: sourceClaimId,
      target_claim_id: targetClaimId,
      edge_type: ConflictEdgeTypeSchema.parse(value.edge_type),
      created_by: value.created_by
    };
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid edge_type", { cause: error });
  }
}
