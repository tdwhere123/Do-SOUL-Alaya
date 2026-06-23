import type { Hono } from "hono";
import { CoreError, type ArbitrationService, type SlotService, type WorkspaceService } from "@do-soul/alaya-core";
import { parseJsonBody } from "./shared.js";

export interface SlotRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly slotService: SlotService;
  readonly arbitrationService?: ArbitrationService;
}

interface ResolveSlotPayload {
  readonly winner_claim_id: string;
}

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

    const body = (await parseJsonBody(context.req.json.bind(context.req))) as ResolveSlotPayload;
    const winnerClaimId = body.winner_claim_id?.trim() ?? "";

    if (winnerClaimId.length === 0) {
      throw new CoreError("VALIDATION", "winner_claim_id is required");
    }

    const updated = await services.arbitrationService.resolveSlotConflict(
      context.req.param("id"),
      winnerClaimId,
      workspaceId
    );
    return context.json({ success: true, data: updated }, 200);
  });
}