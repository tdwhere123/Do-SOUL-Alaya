import type { Hono } from "hono";
import { z } from "zod";
import { CoreError, type ArbitrationService, type WorkspaceService } from "@do-soul/alaya-core";
import { parseJsonBody, rejectUnexpectedRequestBody } from "./shared.js";
import { ConflictEdgeTypeSchema } from "@do-soul/alaya-protocol";

export interface ConflictMatrixRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly arbitrationService: ArbitrationService;
}

const CreateConflictEdgeBodySchema = z.object({
  source_claim_id: z.string().trim().min(1),
  target_claim_id: z.string().trim().min(1),
  edge_type: ConflictEdgeTypeSchema,
  created_by: z.string().trim().min(1).optional()
}).strict().readonly();

export function registerConflictMatrixRoutes(app: Hono, services: ConflictMatrixRouteServices): void {
  app.get("/workspaces/:wsId/conflict-matrix-edges", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const edges = await services.arbitrationService.listEdgesByWorkspace(workspaceId);
    return context.json({ success: true, data: edges }, 200);
  });

  app.post("/workspaces/:wsId/conflict-matrix-edges", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const body = await parseJsonBody(context.req.json.bind(context.req));
    const payload = parseCreateEdgePayload(body);

    const created = await services.arbitrationService.createEdge(
      {
        source_claim_id: payload.source_claim_id,
        target_claim_id: payload.target_claim_id,
        edge_type: payload.edge_type,
        created_by: payload.created_by ?? "user_action"
      },
      workspaceId
    );

    return context.json({ success: true, data: created }, 201);
  });

  app.delete("/workspaces/:wsId/conflict-matrix-edges/:id", async (context) => {
    const unexpectedBody = await rejectUnexpectedRequestBody(context);
    if (unexpectedBody !== null) return unexpectedBody;
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    await services.arbitrationService.deleteEdge(context.req.param("id"), workspaceId);
    return context.json({ success: true, data: null }, 200);
  });

  app.post("/workspaces/:wsId/conflict-matrix/rebuild", async (context) => {
    const unexpectedBody = await rejectUnexpectedRequestBody(context);
    if (unexpectedBody !== null) return unexpectedBody;
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const result = await services.arbitrationService.rebuildConflictMatrix(workspaceId);
    return context.json({ success: true, data: result }, 200);
  });
}

function parseCreateEdgePayload(value: unknown): {
  readonly source_claim_id: string;
  readonly target_claim_id: string;
  readonly edge_type: ReturnType<typeof ConflictEdgeTypeSchema.parse>;
  readonly created_by?: string;
} {
  const parsed = CreateConflictEdgeBodySchema.safeParse(value);
  if (!parsed.success) {
    throw new CoreError("VALIDATION", "Invalid request body");
  }
  const payload = parsed.data;

  if (payload.source_claim_id === payload.target_claim_id) {
    throw new CoreError("VALIDATION", "source_claim_id and target_claim_id must be different");
  }

  return payload;
}
