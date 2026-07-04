import type { Hono } from "hono";
import { CoreError, type BudgetBankruptcyService, type RunService } from "@do-soul/alaya-core";
import { throwInvalidRequestBody } from "../shared/shared.js";

export interface BudgetRouteServices {
  readonly budgetBankruptcyService: BudgetBankruptcyService;
  readonly runService: RunService;
  readonly now?: () => string;
}

export function registerBudgetRoutes(app: Hono, services: BudgetRouteServices): void {
  const now = services.now ?? (() => new Date().toISOString());

  app.get("/runs/:runId/budget-snapshot", async (context) => {
    const runId = context.req.param("runId");
    await services.runService.getById(runId);
    const snapshot = await services.budgetBankruptcyService.getSnapshot(runId, ensureIsoDatetime(now()));
    return context.json({ success: true, data: snapshot }, 200);
  });

  app.post("/runs/:runId/budget-bankruptcy/resolve", async (context) => {
    const runId = context.req.param("runId");
    const run = await services.runService.getById(runId);
    const body = await parseResolveBody(context.req.json.bind(context.req));
    const proposal = await services.budgetBankruptcyService.resolve({
      runId,
      workspaceId: run.workspace_id,
      optionId: body.option_id,
      action: body.action
    });

    return context.json({ success: true, data: proposal }, 200);
  });
}

async function parseResolveBody(readJson: () => Promise< unknown>): Promise<{
  readonly option_id: string;
  readonly action: "accept" | "reject";
}> {
  let body: unknown;

  try {
    body = await readJson();
  } catch (error) {
    throwInvalidRequestBody(error);
  }

  if (body === null || typeof body !== "object") {
    throw new CoreError("VALIDATION", "Resolve request body must be an object");
  }

  const candidate = body as {
    readonly option_id?: unknown;
    readonly action?: unknown;
  };

  if (typeof candidate.option_id !== "string" || candidate.option_id.trim().length === 0) {
    throw new CoreError("VALIDATION", "option_id is required");
  }

  if (candidate.action !== "accept" && candidate.action !== "reject") {
    throw new CoreError("VALIDATION", "action must be accept or reject");
  }

  return {
    option_id: candidate.option_id.trim(),
    action: candidate.action
  };
}

function ensureIsoDatetime(value: string): string {
  const epoch = Date.parse(value);

  if (!Number.isFinite(epoch)) {
    throw new CoreError("VALIDATION", "budget route clock must return a valid ISO timestamp");
  }

  return new Date(epoch).toISOString();
}
