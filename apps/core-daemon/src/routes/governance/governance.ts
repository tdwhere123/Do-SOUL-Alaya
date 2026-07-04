import type { Hono } from "hono";
import type {
  GovernanceSnapshot,
  GreenStatus,
  GreenStatusSummaryItem,
  GovernanceLease,
  Run,
  SessionOverride
} from "@do-soul/alaya-protocol";
import { CoreError } from "@do-soul/alaya-core";

export interface GovernanceRouteServices {
  readonly now?: () => string;
  readonly greenService: {
    findAll(workspaceId: string): Promise<readonly Readonly<GreenStatus>[]>;
  };
  readonly sessionOverrideService: {
    getActiveFor(runId: string): Promise<readonly Readonly<SessionOverride>[]>;
  };
  readonly governanceLeaseService: {
    getActive(runId: string): Promise<Readonly<GovernanceLease> | null>;
  };
  readonly runService: {
    getById(runId: string): Promise<Pick<Run, "run_id" | "workspace_id">>;
  };
}

export function registerGovernanceRoutes(app: Hono, services: GovernanceRouteServices): void {
  const now = services.now ?? (() => new Date().toISOString());

  app.get("/runs/:runId/governance-snapshot", async (context) => {
    const runId = context.req.param("runId");
    const run = await services.runService.getById(runId);

    const [greenStatuses, activeOverrides, activeLease] = await Promise.all([
      services.greenService.findAll(run.workspace_id),
      services.sessionOverrideService.getActiveFor(run.run_id),
      services.governanceLeaseService.getActive(run.run_id)
    ]);

    const snapshotAt = ensureIsoDatetime(now());
    const snapshot: GovernanceSnapshot = {
      run_id: run.run_id,
      workspace_id: run.workspace_id,
      green_summary: {
        eligible_count: greenStatuses.filter((status: Readonly<GreenStatus>) => status.green_state === "eligible").length,
        grace_count: greenStatuses.filter((status: Readonly<GreenStatus>) => status.green_state === "grace").length,
        revoked_count: greenStatuses.filter((status: Readonly<GreenStatus>) => status.green_state === "revoked").length
      },
      green_statuses: greenStatuses
        .map((status: Readonly<GreenStatus>) => ({
          target_object_id: status.target_object_id,
          green_state: status.green_state,
          verification_basis: status.verification_basis,
          valid_until: status.valid_until,
          revoke_reason: status.revoke_reason,
          last_transition_at: status.last_transition_at
        }))
        .sort((left: GreenStatusSummaryItem, right: GreenStatusSummaryItem) => {
          const recency = right.last_transition_at.localeCompare(left.last_transition_at);
          return recency !== 0 ? recency : left.target_object_id.localeCompare(right.target_object_id);
        }),
      active_overrides: activeOverrides.map((override: Readonly<SessionOverride>) => ({
        override_id: override.runtime_id,
        target_object: override.target_object,
        correction: override.correction,
        priority: override.priority,
        expires_at: override.expires_at
      })),
      governance_lease:
        activeLease === null
          ? {
              held: false,
              lease_id: null,
              holder: null,
              expires_at: null
            }
          : {
              held: true,
              lease_id: activeLease.lease_id,
              holder: activeLease.holder,
              expires_at: activeLease.expires_at
            },
      snapshot_at: snapshotAt
    };

    return context.json({ success: true, data: snapshot }, 200);
  });
}

function ensureIsoDatetime(value: string): string {
  const epoch = Date.parse(value);

  if (!Number.isFinite(epoch)) {
    throw new CoreError("VALIDATION", "governance route clock must return a valid ISO timestamp");
  }

  return new Date(epoch).toISOString();
}
