import type { Hono } from "hono";
import {
  HealthEventKindSchema,
  type HealthEventKindValue,
  type HealthJournalEntry
} from "@do-soul/alaya-protocol";
import { CoreError } from "@do-soul/alaya-core";

export interface HealthJournalRouteServices {
  readonly workspaceService: {
    getById(workspaceId: string): Promise<{ readonly workspace_id: string }>;
  };
  readonly healthJournalService: {
    getRecentEvents(
      workspaceId: string,
      params?: {
        readonly kind?: HealthEventKindValue;
        readonly limit?: number;
      }
    ): Promise<readonly Readonly<HealthJournalEntry>[]>;
  };
}

export function registerHealthJournalRoutes(app: Hono, services: HealthJournalRouteServices): void {
  app.get("/workspaces/:wsId/health-journal", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const entries = await services.healthJournalService.getRecentEvents(workspaceId, {
      kind: parseOptionalKind(context.req.query("kind")),
      limit: parseLimit(context.req.query("limit"))
    });

    return context.json({ success: true, data: { entries } }, 200);
  });
}

function parseOptionalKind(value: string | undefined): HealthEventKindValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    return HealthEventKindSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "kind must be a supported health journal event kind", { cause: error });
  }
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) {
    return 50;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CoreError("VALIDATION", "limit must be a positive integer");
  }

  return Math.min(parsed, 200);
}
