import { createHash } from "node:crypto";
import {
  RecallContextEventType,
  SoulContextUsageReportedPayloadSchema,
  SoulRecallDeliveredPayloadSchema,
  type ContextDeliveryRecord,
  type SoulReportContextUsageRequest
} from "@do-soul/alaya-protocol";
import { reportAsyncSideEffectFailure } from "@do-soul/alaya-core";
import type {
  RecallUsageHandlerDependencies,
  RecallUsageToolCallContext
} from "./recall-usage-handlers.js";

// INVARIANT: telemetry append never throws to the MCP caller. The failure
// is made observable (audited event when the audit port is wired, else a
// process warning) but is always swallowed.
async function reportTelemetryAppendFailure(
  deps: RecallUsageHandlerDependencies,
  input: Readonly<{
    readonly operation: string;
    readonly deliveryId: string;
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly now?: () => string;
  }>,
  error: unknown
): Promise<void> {
  const audit = deps.asyncSideEffectAudit;
  if (audit === undefined) {
    process.emitWarning("[RecallUsage] telemetry append failed", {
      code: "ALAYA_RECALL_TELEMETRY_APPEND_FAILED",
      detail: JSON.stringify({
        operation: input.operation,
        delivery_id: input.deliveryId,
        error: error instanceof Error ? error.message : String(error)
      })
    });
    return;
  }
  await reportAsyncSideEffectFailure(
    {
      source: "mcp-memory.recall-usage-telemetry",
      operation: input.operation,
      subjectType: "context_delivery",
      subjectId: input.deliveryId,
      workspaceId: input.workspaceId,
      runId: input.runId,
      severity: "warning",
      warningCode: "ALAYA_RECALL_TELEMETRY_APPEND_FAILED",
      warningMessage: "[RecallUsage] telemetry append failed",
      eventLogRepo: audit.eventLogRepo,
      runtimeNotifier: audit.runtimeNotifier,
      ...(input.now === undefined ? {} : { now: input.now })
    },
    error
  );
}

export async function emitRecallDeliveredTelemetry(
  params: Readonly<{ readonly deps: RecallUsageHandlerDependencies; readonly now: () => string }>,
  input: {
    readonly deliveryId: string;
    readonly query: string;
    readonly pointerCount: number;
    readonly latencyMs: number;
    readonly context: RecallUsageToolCallContext;
  }
): Promise<void> {
  if (params.deps.eventPublisher === undefined) {
    return;
  }
  const occurredAt = params.now();
  const queryHash = createHash("sha256").update(input.query).digest("hex").slice(0, 16);
  const event = {
    event_type: RecallContextEventType.SOUL_RECALL_DELIVERED,
    entity_type: "context_delivery",
    entity_id: input.deliveryId,
    workspace_id: input.context.workspaceId,
    run_id: input.context.runId,
    caused_by: input.context.agentTarget,
    payload_json: SoulRecallDeliveredPayloadSchema.parse({
      delivery_id: input.deliveryId,
      session_id: input.context.sessionId,
      run_id: input.context.runId,
      agent_target: input.context.agentTarget,
      query_hash: queryHash,
      pointer_count: input.pointerCount,
      latency_ms: Math.max(0, Math.trunc(input.latencyMs)),
      workspace_id: input.context.workspaceId,
      occurred_at: occurredAt
    })
  } as const;
  try {
    await params.deps.eventPublisher.appendManyWithMutation([event], () => undefined);
  } catch (error) {
    // INVARIANT: telemetry append never throws to the MCP caller.
    await reportTelemetryAppendFailure(
      params.deps,
      {
        operation: "recall_delivered_telemetry",
        deliveryId: input.deliveryId,
        workspaceId: input.context.workspaceId,
        runId: input.context.runId,
        now: params.now
      },
      error
    );
  }
}

export async function emitContextUsageReportedTelemetry(
  params: Readonly<{ readonly deps: RecallUsageHandlerDependencies }>,
  input: {
    readonly deliveryId: string;
    readonly usageState: SoulReportContextUsageRequest["usage_state"];
    readonly occurredAt: string;
    readonly context: RecallUsageToolCallContext;
    readonly linkedDelivery: Readonly<ContextDeliveryRecord> | null;
  }
): Promise<void> {
  if (params.deps.eventPublisher === undefined) {
    return;
  }
  const attributedRunId = input.linkedDelivery?.run_id ?? input.context.runId;
  const attributedAgentTarget = input.linkedDelivery?.agent_target ?? input.context.agentTarget;
  const attributedWorkspaceId = input.linkedDelivery?.workspace_id ?? input.context.workspaceId;
  const event = {
    event_type: RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
    entity_type: "context_delivery",
    entity_id: input.deliveryId,
    workspace_id: attributedWorkspaceId,
    run_id: attributedRunId,
    caused_by: attributedAgentTarget,
    payload_json: SoulContextUsageReportedPayloadSchema.parse({
      delivery_id: input.deliveryId,
      session_id: input.context.sessionId,
      run_id: attributedRunId,
      agent_target: attributedAgentTarget,
      usage_state: input.usageState,
      workspace_id: attributedWorkspaceId,
      occurred_at: input.occurredAt
    })
  } as const;
  try {
    await params.deps.eventPublisher.appendManyWithMutation([event], () => undefined);
  } catch (error) {
    // INVARIANT: telemetry append never throws to the MCP caller.
    await reportTelemetryAppendFailure(
      params.deps,
      {
        operation: "context_usage_reported_telemetry",
        deliveryId: input.deliveryId,
        workspaceId: attributedWorkspaceId,
        runId: attributedRunId
      },
      error
    );
  }
}
