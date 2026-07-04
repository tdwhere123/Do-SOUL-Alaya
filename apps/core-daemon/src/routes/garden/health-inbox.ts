import type { Hono } from "hono";
import { CoreError, type WorkspaceService } from "@do-soul/alaya-core";
import {
  HealthIssueCauseKindSchema,
  HealthIssueResolutionStateSchema,
  type HealthIssueCauseKindValue,
  type HealthIssueGroup,
  type HealthIssueResolutionStateValue
} from "@do-soul/alaya-protocol";

// invariant: HealthIssueGroup rows are the read-only truth for the
// Inspector Health Inbox surface. This route is a projection — it never
// mutates rows. State transitions (resolve / suppress) belong to the
// repo write surface, which is reached through a separate proposal /
// MCP path, not through this projection.
// see also: packages/storage/src/repos/health/health-issue-group-repo.ts

export interface HealthInboxRouteServices {
  readonly workspaceService: Pick<WorkspaceService, "getById">;
  readonly healthIssueGroupRepo: {
    findByWorkspace(
      workspaceId: string,
      options?: {
        readonly state?: HealthIssueResolutionStateValue;
        readonly causeKind?: HealthIssueCauseKindValue;
        readonly limit?: number;
      }
    ): Promise<readonly Readonly<HealthIssueGroup>[]> | readonly Readonly<HealthIssueGroup>[];
  };
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export function registerHealthInboxRoutes(
  app: Hono,
  services: HealthInboxRouteServices
): void {
  app.get("/workspaces/:wsId/health-inbox", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const state = parseStateQuery(context.req.query("state"));
    const causeKind = parseCauseKindQuery(context.req.query("causeKind"));
    const limit = parseLimitQuery(context.req.query("limit"));

    const rows = await loadHealthInboxGroups(services.healthIssueGroupRepo, workspaceId, {
      ...(state === null ? {} : { state }),
      ...(causeKind === null ? {} : { causeKind }),
      limit
    });

    return context.json(
      {
        success: true,
        data: {
          workspace_id: workspaceId,
          groups: rows,
          total_count: rows.length
        }
      },
      200
    );
  });
}

function parseStateQuery(value: string | undefined): HealthIssueResolutionStateValue | null {
  if (value === undefined || value.trim().length === 0) return null;
  const parsed = HealthIssueResolutionStateSchema.safeParse(value.trim());
  if (!parsed.success) {
    throw new CoreError("VALIDATION", "Invalid state query parameter");
  }
  return parsed.data;
}

function parseCauseKindQuery(value: string | undefined): HealthIssueCauseKindValue | null {
  if (value === undefined || value.trim().length === 0) return null;
  const parsed = HealthIssueCauseKindSchema.safeParse(value.trim());
  if (!parsed.success) {
    throw new CoreError("VALIDATION", "Invalid causeKind query parameter");
  }
  return parsed.data;
}

function parseLimitQuery(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) {
    return DEFAULT_LIMIT;
  }
  const trimmed = value.trim();
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== trimmed) {
    throw new CoreError("VALIDATION", `limit must be a positive integer up to ${MAX_LIMIT}`);
  }
  return Math.min(parsed, MAX_LIMIT);
}

async function loadHealthInboxGroups(
  repo: HealthInboxRouteServices["healthIssueGroupRepo"],
  workspaceId: string,
  options: {
    readonly state?: HealthIssueResolutionStateValue;
    readonly causeKind?: HealthIssueCauseKindValue;
    readonly limit: number;
  }
): Promise<readonly Readonly<HealthIssueGroup>[]> {
  const result = repo.findByWorkspace(workspaceId, options);
  if (result instanceof Promise) {
    return await result;
  }
  return await new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}
