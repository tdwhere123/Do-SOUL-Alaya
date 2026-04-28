import type { Hono } from "hono";
import { CoreError, type RunService, type SignalService } from "@do-what/core";
import { parseJsonBody } from "./shared.js";
import { EmitCandidateSignalResponseSchema, SignalSource } from "@do-what/protocol";
import { materializeCandidateSignal } from "@do-what/soul";

export interface SignalRouteServices {
  readonly runService: RunService;
  readonly signalService: SignalService;
}

export function registerSignalRoutes(app: Hono, services: SignalRouteServices): void {
  app.get("/runs/:id/signals", async (context) => {
    const runId = context.req.param("id");
    await services.runService.getById(runId);
    const signals = await services.signalService.listByRun(runId);
    return context.json({ success: true, data: signals }, 200);
  });

  app.post("/runs/:id/signals", async (context) => {
    const runId = context.req.param("id");
    const run = await services.runService.getById(runId);
    const body = await parseJsonBody(context.req.json.bind(context.req));

    let signal;
    try {
      signal = materializeCandidateSignal({
        input: body,
        source: SignalSource.USER_SEED
      });
    } catch (error) {
      throw new CoreError("VALIDATION", "Invalid signal payload", { cause: error });
    }

    if (signal.run_id !== runId || signal.workspace_id !== run.workspace_id) {
      throw new CoreError("VALIDATION", "Signal run/workspace scope mismatch");
    }

    const created = await services.signalService.receiveSignal(signal);
    return context.json(
      {
        success: true,
        data: EmitCandidateSignalResponseSchema.parse({
          signal_id: created.signal.signal_id,
          status: "emitted"
        })
      },
      201
    );
  });
}

