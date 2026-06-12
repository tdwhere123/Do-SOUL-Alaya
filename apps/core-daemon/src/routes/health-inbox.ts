import type { Hono } from "hono";
import type { WorkspaceService } from "@do-soul/alaya-core";
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
    ): readonly Readonly<HealthIssueGroup>[];
  };
}

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

    const rows = services.healthIssueGroupRepo.findByWorkspace(workspaceId, {
      ...(state === null ? {} : { state }),
      ...(causeKind === null ? {} : { causeKind }),
      ...(limit === null ? {} : { limit })
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
  return parsed.success ? parsed.data : null;
}

function parseCauseKindQuery(value: string | undefined): HealthIssueCauseKindValue | null {
  if (value === undefined || value.trim().length === 0) return null;
  const parsed = HealthIssueCauseKindSchema.safeParse(value.trim());
  return parsed.success ? parsed.data : null;
}

function parseLimitQuery(value: string | undefined): number | null {
  if (value === undefined || value.trim().length === 0) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(parsed, MAX_LIMIT);
}
