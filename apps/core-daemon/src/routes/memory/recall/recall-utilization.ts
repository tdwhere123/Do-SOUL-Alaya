import type { Hono } from "hono";
import { CoreError, type WorkspaceService } from "@do-soul/alaya-core";
import {
  rollUpUtilizationBucketsByCohort,
  type UtilizationBucketDelivery,
  type UtilizationBucketReport
} from "@do-soul/alaya-eval";
import {
  RecallContextEventType,
  SoulSingleUsedAnchorPayloadSchema,
  parseRecallContextEventPayload,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import type { RecallUtilizationEventLogPort } from "../../../services/status/recall-utilization-service.js";

export interface RecallUtilizationRouteServices {
  readonly workspaceService: Pick<WorkspaceService, "getById">;
  readonly eventLogRepo: RecallUtilizationEventLogPort;
  readonly singleUsedAnchorEmitter?: SingleUsedAnchorTelemetryEmitter;
  readonly deliveryAnchorReader?: SingleUsedAnchorDeliveryReader;
}

export interface SingleUsedAnchorDeliveryReader {
  findDeliveredObjectIds(deliveryId: string): Promise<readonly string[] | null>;
}

export interface SingleUsedAnchorTelemetryEmitter {
  emit(input: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly agentTarget: string;
    readonly sessionId: string;
    readonly deliveryId: string;
    readonly occurredAt: string;
    readonly usedAnchorObjectId: string | null;
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

    const rows = rollUpUtilizationBucketsByCohort({
      deliveries: deliveries as readonly (UtilizationBucketDelivery & { readonly workspace_id: string })[],
      reports: reports as readonly (UtilizationBucketReport & { readonly workspace_id: string })[]
    }) satisfies readonly RecallUtilizationCohortRow[];

    if (services.singleUsedAnchorEmitter !== undefined) {
      await emitSingleUsedAnchorTelemetry({
        deliveries,
        reports,
        workspaceId,
        emitter: services.singleUsedAnchorEmitter,
        anchorReader: services.deliveryAnchorReader
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
    const payload = parseRecallUtilizationRoutePayload(
      row,
      RecallContextEventType.SOUL_RECALL_DELIVERED
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
    const payload = parseRecallUtilizationRoutePayload(
      row,
      RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED
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

function parseRecallUtilizationRoutePayload<T extends
  | typeof RecallContextEventType.SOUL_RECALL_DELIVERED
  | typeof RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED
>(row: EventLogEntry, eventType: T): ReturnType<typeof parseRecallContextEventPayload<T>> {
  try {
    return parseRecallContextEventPayload(eventType, toPayloadRecord(row));
  } catch (error) {
    throw new CoreError(
      "VALIDATION",
      `Invalid recall utilization EventLog payload for ${row.event_type}`,
      { cause: error }
    );
  }
}

function toPayloadRecord(row: EventLogEntry): Record<string, unknown> {
  if (row.payload_json === null || typeof row.payload_json !== "object" || Array.isArray(row.payload_json)) {
    throw new CoreError("VALIDATION", `Event ${row.event_id} payload must be an object`);
  }

  return row.payload_json;
}

async function emitSingleUsedAnchorTelemetry(input: {
  readonly deliveries: readonly NormalizedDelivery[];
  readonly reports: readonly NormalizedReport[];
  readonly workspaceId: string;
  readonly emitter: SingleUsedAnchorTelemetryEmitter;
  readonly anchorReader?: SingleUsedAnchorDeliveryReader;
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
    let usedAnchorObjectId: string | null = null;
    if (input.anchorReader !== undefined) {
      try {
        const ids = await input.anchorReader.findDeliveredObjectIds(delivery.delivery_id);
        if (ids !== null && ids.length === 1) {
          usedAnchorObjectId = ids[0] ?? null;
        }
      } catch (error) {
        process.emitWarning(
          `recall utilization anchor lookup failed: ${error instanceof Error ? error.message : String(error)}`,
          { type: "AlayaRecallUtilizationWarning", code: "ALAYA_RECALL_UTILIZATION_ANCHOR_LOOKUP_FAILED" }
        );
      }
    }
    try {
      await input.emitter.emit({
        workspaceId: input.workspaceId,
        runId: report.run_id,
        agentTarget: report.agent_target,
        sessionId: report.session_id,
        deliveryId: delivery.delivery_id,
        occurredAt: report.occurred_at,
        usedAnchorObjectId
      });
    } catch (error) {
      process.emitWarning(
        `recall utilization telemetry emit failed: ${error instanceof Error ? error.message : String(error)}`,
        { type: "AlayaRecallUtilizationWarning", code: "ALAYA_RECALL_UTILIZATION_TELEMETRY_EMIT_FAILED" }
      );
    }
  }
}

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
