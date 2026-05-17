import type { Hono } from "hono";
import type { WorkspaceService } from "@do-soul/alaya-core";
import {
  RecallContextEventType,
  SoulSingleUsedAnchorPayloadSchema,
  parseRecallContextEventPayload,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import type { RecallUtilizationEventLogPort } from "../services/recall-utilization-service.js";

// see also: packages/eval/src/utilization-buckets.ts — parallel pure
// aggregation helper for the bench cohort metric. The two implementations
// keep the same bucket semantics on purpose: the daemon route depends only
// on protocol + storage, the eval helper depends only on zod.

export interface RecallUtilizationRouteServices {
  readonly workspaceService: Pick<WorkspaceService, "getById">;
  readonly eventLogRepo: RecallUtilizationEventLogPort;
  // Optional: when present, the route emits SOUL_SINGLE_USED_ANCHOR
  // telemetry rows per 1-used delivery match. When absent, the route
  // still computes buckets — telemetry is best-effort, never load-bearing.
  readonly singleUsedAnchorEmitter?: SingleUsedAnchorTelemetryEmitter;
}

export interface SingleUsedAnchorTelemetryEmitter {
  emit(input: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly agentTarget: string;
    readonly sessionId: string;
    readonly deliveryId: string;
    readonly occurredAt: string;
  }): Promise<void>;
}

export interface RecallUtilizationCohortRow {
  readonly workspace_id: string;
  readonly agent_target: string;
  readonly buckets: {
    readonly no_recall: number;
    readonly empty_recall: number;
    readonly delivered_not_reported: number;
    readonly reported_skipped_or_na: number;
    readonly reported_used: number;
  };
  readonly delivery_total: number;
  readonly single_used_anchor_count: number;
}

export function registerRecallUtilizationRoutes(
  app: Hono,
  services: RecallUtilizationRouteServices
): void {
  app.get("/workspaces/:workspaceId/recall-utilization", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    await services.workspaceService.getById(workspaceId);

    const since = normalizeQueryString(context.req.query("since"));
    const until = normalizeQueryString(context.req.query("until"));

    const [deliveredRows, usageRows] = await Promise.all([
      services.eventLogRepo.queryByWorkspaceAndType(
        workspaceId,
        RecallContextEventType.SOUL_RECALL_DELIVERED,
        since ?? undefined,
        until ?? undefined
      ),
      services.eventLogRepo.queryByWorkspaceAndType(
        workspaceId,
        RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
        since ?? undefined,
        until ?? undefined
      )
    ]);

    const deliveries = projectDeliveries(deliveredRows);
    const reports = projectReports(usageRows);

    const rows = rollUpByCohort({ deliveries, reports });

    // single_used_anchor emission happens as a passive telemetry signal.
    // invariant: never advance PathRelation counters from here — that is
    // PathPlasticityService's exclusive surface.
    if (services.singleUsedAnchorEmitter !== undefined) {
      await emitSingleUsedAnchorTelemetry({
        deliveries,
        reports,
        workspaceId,
        emitter: services.singleUsedAnchorEmitter
      });
    }

    return context.json(
      {
        success: true,
        data: {
          window: {
            workspace_id: workspaceId,
            since: since ?? null,
            until: until ?? null
          },
          cohorts: rows
        }
      },
      200
    );
  });
}

function normalizeQueryString(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}

interface NormalizedDelivery {
  readonly delivery_id: string;
  readonly session_id: string;
  readonly run_id: string | null;
  readonly agent_target: string;
  readonly workspace_id: string;
  readonly pointer_count: number;
  readonly occurred_at: string;
}

interface NormalizedReport {
  readonly delivery_id: string;
  readonly session_id: string;
  readonly run_id: string | null;
  readonly agent_target: string;
  readonly workspace_id: string;
  readonly usage_state: "used" | "skipped" | "not_applicable";
  readonly occurred_at: string;
}

function projectDeliveries(rows: readonly EventLogEntry[]): readonly NormalizedDelivery[] {
  return rows.map((row) => {
    const payload = parseRecallContextEventPayload(
      RecallContextEventType.SOUL_RECALL_DELIVERED,
      row.payload_json as Record<string, unknown>
    );
    return {
      delivery_id: payload.delivery_id,
      session_id: payload.session_id,
      run_id: payload.run_id,
      agent_target: payload.agent_target,
      workspace_id: payload.workspace_id,
      pointer_count: payload.pointer_count,
      occurred_at: payload.occurred_at
    } as const;
  });
}

function projectReports(rows: readonly EventLogEntry[]): readonly NormalizedReport[] {
  return rows.map((row) => {
    const payload = parseRecallContextEventPayload(
      RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
      row.payload_json as Record<string, unknown>
    );
    return {
      delivery_id: payload.delivery_id,
      session_id: payload.session_id,
      run_id: payload.run_id,
      agent_target: payload.agent_target,
      workspace_id: payload.workspace_id,
      usage_state: payload.usage_state,
      occurred_at: payload.occurred_at
    } as const;
  });
}

function rollUpByCohort(input: {
  readonly deliveries: readonly NormalizedDelivery[];
  readonly reports: readonly NormalizedReport[];
}): readonly RecallUtilizationCohortRow[] {
  const cohortKey = (workspaceId: string, agentTarget: string): string =>
    `${workspaceId}${agentTarget}`;

  interface CohortBucket {
    readonly workspace_id: string;
    readonly agent_target: string;
    readonly deliveries: NormalizedDelivery[];
    readonly reports: NormalizedReport[];
  }

  const grouped = new Map<string, CohortBucket>();

  const ensure = (workspaceId: string, agentTarget: string): CohortBucket => {
    const key = cohortKey(workspaceId, agentTarget);
    const existing = grouped.get(key);
    if (existing !== undefined) return existing;
    const created: CohortBucket = {
      workspace_id: workspaceId,
      agent_target: agentTarget,
      deliveries: [],
      reports: []
    };
    grouped.set(key, created);
    return created;
  };

  for (const delivery of input.deliveries) {
    ensure(delivery.workspace_id, delivery.agent_target).deliveries.push(delivery);
  }
  for (const report of input.reports) {
    ensure(report.workspace_id, report.agent_target).reports.push(report);
  }

  const rows: RecallUtilizationCohortRow[] = [];
  for (const cohort of grouped.values()) {
    const buckets = computeBuckets({
      deliveries: cohort.deliveries,
      reports: cohort.reports
    });
    const singleUsedAnchorCount = countSingleUsedAnchorMatches({
      deliveries: cohort.deliveries,
      reports: cohort.reports
    });
    rows.push({
      workspace_id: cohort.workspace_id,
      agent_target: cohort.agent_target,
      buckets,
      delivery_total: cohort.deliveries.length,
      single_used_anchor_count: singleUsedAnchorCount
    });
  }

  rows.sort((a, b) => {
    const ws = a.workspace_id.localeCompare(b.workspace_id);
    return ws === 0 ? a.agent_target.localeCompare(b.agent_target) : ws;
  });

  return Object.freeze(rows);
}

function computeBuckets(input: {
  readonly deliveries: readonly NormalizedDelivery[];
  readonly reports: readonly NormalizedReport[];
}): RecallUtilizationCohortRow["buckets"] {
  const deliveryIds = new Set(input.deliveries.map((delivery) => delivery.delivery_id));
  const reportStateById = new Map<string, "used" | "skipped" | "not_applicable">();
  for (const report of input.reports) {
    const existing = reportStateById.get(report.delivery_id);
    if (existing === undefined) {
      reportStateById.set(report.delivery_id, report.usage_state);
      continue;
    }
    reportStateById.set(report.delivery_id, mergeUsageState(existing, report.usage_state));
  }

  let emptyRecall = 0;
  let deliveredNotReported = 0;
  let reportedSkippedOrNa = 0;
  let reportedUsed = 0;

  for (const delivery of input.deliveries) {
    const reportState = reportStateById.get(delivery.delivery_id);
    if (reportState === undefined) {
      deliveredNotReported += 1;
      if (delivery.pointer_count === 0) {
        emptyRecall += 1;
      }
      continue;
    }
    if (reportState === "used") {
      reportedUsed += 1;
    } else {
      reportedSkippedOrNa += 1;
    }
  }

  // no_recall: distinct (session_id) orphan-report markers in this cohort.
  // Reports always carry delivery_id (mcp-types contract) so we cannot derive
  // a turn-level no-recall count from EventLog without turn_index. We count
  // distinct sessions whose reports reference orphan delivery_ids as a
  // proxy for "agent attached but did not call recall in those sessions".
  const orphanSessions = new Set<string>();
  for (const report of input.reports) {
    if (deliveryIds.has(report.delivery_id)) continue;
    orphanSessions.add(report.session_id);
  }

  return {
    no_recall: orphanSessions.size,
    empty_recall: emptyRecall,
    delivered_not_reported: deliveredNotReported,
    reported_skipped_or_na: reportedSkippedOrNa,
    reported_used: reportedUsed
  };
}

function countSingleUsedAnchorMatches(input: {
  readonly deliveries: readonly NormalizedDelivery[];
  readonly reports: readonly NormalizedReport[];
}): number {
  const usedReportIds = new Set<string>();
  for (const report of input.reports) {
    if (report.usage_state === "used") {
      usedReportIds.add(report.delivery_id);
    }
  }
  let count = 0;
  for (const delivery of input.deliveries) {
    if (delivery.pointer_count === 1 && usedReportIds.has(delivery.delivery_id)) {
      count += 1;
    }
  }
  return count;
}

async function emitSingleUsedAnchorTelemetry(input: {
  readonly deliveries: readonly NormalizedDelivery[];
  readonly reports: readonly NormalizedReport[];
  readonly workspaceId: string;
  readonly emitter: SingleUsedAnchorTelemetryEmitter;
}): Promise<void> {
  const usedReports = new Map<string, NormalizedReport>();
  for (const report of input.reports) {
    if (report.usage_state !== "used") continue;
    const existing = usedReports.get(report.delivery_id);
    if (existing === undefined || report.occurred_at > existing.occurred_at) {
      usedReports.set(report.delivery_id, report);
    }
  }

  const matches: ReadonlyArray<{
    readonly delivery: NormalizedDelivery;
    readonly report: NormalizedReport;
  }> = input.deliveries
    .filter((delivery) => delivery.pointer_count === 1)
    .map((delivery) => ({ delivery, report: usedReports.get(delivery.delivery_id) }))
    .filter((entry): entry is { delivery: NormalizedDelivery; report: NormalizedReport } =>
      entry.report !== undefined
    );

  for (const { delivery, report } of matches) {
    try {
      await input.emitter.emit({
        workspaceId: input.workspaceId,
        runId: report.run_id,
        agentTarget: report.agent_target,
        sessionId: report.session_id,
        deliveryId: delivery.delivery_id,
        occurredAt: report.occurred_at
      });
    } catch {
      // invariant: telemetry emission never breaks the route response.
    }
  }
}

function mergeUsageState(
  a: "used" | "skipped" | "not_applicable",
  b: "used" | "skipped" | "not_applicable"
): "used" | "skipped" | "not_applicable" {
  if (a === "used" || b === "used") return "used";
  if (a === "skipped" || b === "skipped") return "skipped";
  return "not_applicable";
}

// invariant: keep this builder shape compatible with the payload schema in
// packages/protocol/src/events/recall-context.ts SoulSingleUsedAnchorPayloadSchema.
export function buildSingleUsedAnchorPayload(input: {
  readonly deliveryId: string;
  readonly sessionId: string;
  readonly runId: string | null;
  readonly agentTarget: string;
  readonly workspaceId: string;
  readonly occurredAt: string;
  readonly usedAnchorObjectId: string | null;
}): ReturnType<typeof SoulSingleUsedAnchorPayloadSchema.parse> {
  return SoulSingleUsedAnchorPayloadSchema.parse({
    delivery_id: input.deliveryId,
    session_id: input.sessionId,
    run_id: input.runId,
    agent_target: input.agentTarget,
    used_anchor_object_id: input.usedAnchorObjectId,
    workspace_id: input.workspaceId,
    occurred_at: input.occurredAt
  });
}
