import type { Hono } from "hono";
import { CoreError, type GreenService, type WorkspaceService } from "@do-soul/alaya-core";
import { parseJsonBody } from "./shared.js";
import { VerificationVerdict } from "@do-soul/alaya-protocol";

export interface GreenStatusRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly greenService: GreenService;
}

export function registerGreenStatusRoutes(app: Hono, services: GreenStatusRouteServices): void {
  app.get("/workspaces/:workspaceId/green-statuses", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    await services.workspaceService.getById(workspaceId);

    const [eligible, grace] = await Promise.all([
      services.greenService.findEligible(workspaceId),
      services.greenService.findGrace(workspaceId)
    ]);

    return context.json(
      {
        success: true,
        data: {
          eligible,
          grace,
          total_count: eligible.length + grace.length
        }
      },
      200
    );
  });

  app.get("/workspaces/:workspaceId/green-statuses/:targetObjectId", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const targetObjectId = context.req.param("targetObjectId");
    await services.workspaceService.getById(workspaceId);

    const status = await services.greenService.getStatus(targetObjectId);
    if (status === null || status.workspace_id !== workspaceId) {
      throw new CoreError("NOT_FOUND", "Green status not found");
    }

    return context.json({ success: true, data: status }, 200);
  });

  app.post("/workspaces/:workspaceId/green-statuses/verify", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    await services.workspaceService.getById(workspaceId);

    const body = parseVerifyBody(await parseJsonBody(context.req.json.bind(context.req)));
    const targetObjectId = body.target_object_id;
    const verdict = body.verdict;
    const result = await services.greenService.runVerification({
      targetObjectId,
      workspaceId,
      verdict,
      microCorrectionHint: body.micro_correction_hint ?? null,
      necessaryPatch: body.necessary_patch ?? null
    });

    return context.json({ success: true, data: result }, 200);
  });
}

function parseVerifyBody(value: unknown) {
  if (typeof value !== "object" || value === null) {
    throw new CoreError("VALIDATION", "Invalid verification payload");
  }

  const candidate = value as Record<string, unknown>;
  const targetObjectId =
    typeof candidate.target_object_id === "string" ? candidate.target_object_id.trim() : "";

  if (targetObjectId.length === 0) {
    throw new CoreError("VALIDATION", "Invalid verification payload");
  }

  const verdict = candidate.verdict;
  if (verdict !== VerificationVerdict.GO && verdict !== VerificationVerdict.NO_GO) {
    throw new CoreError("VALIDATION", "Invalid verification payload");
  }

  return {
    target_object_id: targetObjectId,
    verdict,
    micro_correction_hint: parseOptionalNullableNonEmptyString(candidate.micro_correction_hint),
    necessary_patch: parseOptionalNullableNonEmptyString(candidate.necessary_patch)
  } as const;
}

function parseOptionalNullableNonEmptyString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CoreError("VALIDATION", "Invalid verification payload");
  }

  return value;
}
