import type { Hono } from "hono";
import { CoreError } from "@do-soul/alaya-core";
import { parseJsonBody } from "../shared/shared.js";
import { SoulApplyOverrideRequestSchema, type Run, type SessionOverride } from "@do-soul/alaya-protocol";

interface OverrideRouteRunServicePort {
  getById(runId: string): Promise<Pick<Run, "run_id" | "workspace_id">>;
}

interface OverrideRouteSessionOverridePort {
  apply(params: {
    readonly runId: string;
    readonly workspaceId: string;
    readonly targetObject: string;
    readonly correction: string;
    readonly priority?: number;
  }): Promise<Readonly<SessionOverride>>;
}

export interface OverrideRouteServices {
  readonly sessionOverrideService: OverrideRouteSessionOverridePort;
  readonly runService: OverrideRouteRunServicePort;
}

export function registerOverrideRoutes(app: Hono, services: OverrideRouteServices): void {
  app.post("/runs/:runId/overrides", async (context) => {
    const runId = context.req.param("runId");
    const run = await services.runService.getById(runId);
    const body = parseApplyOverrideBody(await parseJsonBody(context.req.json.bind(context.req)));

    const override = await services.sessionOverrideService.apply({
      runId: run.run_id,
      workspaceId: run.workspace_id,
      targetObject: body.target_object,
      correction: body.correction,
      priority: body.priority
    });

    return context.json({ success: true, data: override }, 201);
  });
}

function parseApplyOverrideBody(value: unknown) {
  try {
    return SoulApplyOverrideRequestSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid override payload", { cause: error });
  }
}
