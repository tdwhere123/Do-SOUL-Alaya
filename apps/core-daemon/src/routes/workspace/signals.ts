import type { Hono } from "hono";
import { CoreError, type RunService, type SignalService } from "@do-soul/alaya-core";
import { parseJsonBody, parseListPagination, writeListPaginationHeaders } from "../shared/shared.js";
import { EmitCandidateSignalResponseSchema, SignalSource } from "@do-soul/alaya-protocol";
import { materializeCandidateSignal } from "@do-soul/alaya-soul";

export interface SignalRouteServices {
  readonly runService: RunService;
  readonly signalService: SignalService;
}

export function registerSignalRoutes(app: Hono, services: SignalRouteServices): void {
  app.get("/runs/:id/signals", async (context) => {
    const runId = context.req.param("id");
    await services.runService.getById(runId);
    const pagination = parseListPagination(context);
    const [signals, totalCount] = await resolveListAndCount(
      services.signalService.listByRun(runId, pagination),
      services.signalService.countByRun(runId)
    );
    writeListPaginationHeaders(context, totalCount, pagination);
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

async function resolveListAndCount<T>(
  listPromise: Promise<readonly T[]>,
  countPromise: Promise<number>
): Promise<readonly [readonly T[], number]> {
  const [listResult, countResult] = await Promise.allSettled([listPromise, countPromise]);
  if (listResult.status === "rejected") {
    throw listResult.reason;
  }
  if (countResult.status === "rejected") {
    throw countResult.reason;
  }
  return [listResult.value, countResult.value] as const;
}
