import type { Hono } from "hono";
import { z } from "zod";
import { CoreError, type ArbitrationService, type SlotService, type WorkspaceService } from "@do-soul/alaya-core";
import { parseJsonBody } from "../shared/shared.js";

export interface SlotRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly slotService: SlotService;
  readonly arbitrationService?: ArbitrationService;
}

const ResolveSlotBodySchema = z.object({
  winner_claim_id: z.string().trim().min(1)
}).strict().readonly();

export function registerSlotRoutes(app: Hono, services: SlotRouteServices): void {
  app.get("/workspaces/:wsId/slots", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const slots = await services.slotService.findByWorkspace(workspaceId);
    return context.json({ success: true, data: slots }, 200);
  });

  app.get("/workspaces/:wsId/slots/:id", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const slot = await services.slotService.findById(context.req.param("id"), workspaceId);
    return context.json({ success: true, data: slot }, 200);
  });

  app.post("/workspaces/:wsId/slots/:id/resolve", async (context) => {
    if (services.arbitrationService === undefined) {
      throw new CoreError("CONFLICT", "Arbitration service is not configured");
    }

    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const body = ResolveSlotBodySchema.safeParse(await parseJsonBody(context.req.json.bind(context.req)));
    if (!body.success) {
      throw new CoreError("VALIDATION", "Invalid request body");
    }

    const updated = await services.arbitrationService.resolveSlotConflict(
      context.req.param("id"),
      body.data.winner_claim_id,
      workspaceId
    );
    return context.json({ success: true, data: updated }, 200);
  });
}
