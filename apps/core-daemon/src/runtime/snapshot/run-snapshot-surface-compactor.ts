import {
  type EventLogEntry,
  FileApprovalEventType,
  type OutputShapingAppliedPayload,
  RuntimeGovernanceEventType,
  ToolWorkerEventType,
  type RunSnapshotSurfaceApproval,
  type RunSnapshotSurfaceState,
  type RunSnapshotSurfaceToolState,
  type RunSnapshotSurfaceWorkerState,
  type WorkerIntegrationStatusPayload,
  WorkerRuntimeEventType
} from "@do-soul/alaya-protocol";
import {
  flushCompactedSurfaceTools,
  parseFileApprovalEventPayloadOrThrow,
  parseRuntimeGovernanceEventPayloadOrThrow,
  parseToolWorkerEventPayloadOrThrow,
  parseWorkerRuntimeEventPayloadOrThrow,
  PendingSnapshotToolState,
  SnapshotCompactionError,
  stripPendingSnapshotToolState
} from "./run-snapshot-surface-compactor-helpers.js";
export { SnapshotCompactionError } from "./run-snapshot-surface-compactor-helpers.js";

interface SnapshotCompactionState {
  workers: Map<string, RunSnapshotSurfaceWorkerState>;
  tools: Map<string, RunSnapshotSurfaceToolState>;
  approvals: Map<string, RunSnapshotSurfaceApproval>;
  workerIntegrationStatuses: Map<string, WorkerIntegrationStatusPayload>;
  pendingTools: Map<string, PendingSnapshotToolState>;
  pendingCompletedToolOrder: string[];
  pendingCompletedToolIds: Set<string>;
  pendingOutputShapingDecisions: OutputShapingAppliedPayload[];
  pendingToolFailOpenCutoffEventId: string | null;
  pendingCompressionReplayCutoffEventId: string | null;
  governanceFault: RunSnapshotSurfaceState["governance_fault"];
  latestControlPlaneEventId: string | null;
}

export function compactRunSnapshotSurfaceState(
  events: readonly EventLogEntry[],
  startState?: RunSnapshotSurfaceState
): {
  readonly surfaceState: RunSnapshotSurfaceState;
  readonly latestControlPlaneEventId: string | null;
} {
  assertIncrementalCompactionSafe(events, startState);
  const state = createSnapshotCompactionState(startState);
  for (const event of events) {
    applySnapshotEvent(state, event);
  }
  finalizeSnapshotCompactionState(state);
  return buildSnapshotCompactionResult(state);
}

function assertIncrementalCompactionSafe(
  events: readonly EventLogEntry[],
  startState: RunSnapshotSurfaceState | undefined
): void {
  if (
    startState === undefined ||
    !events.some(
      (event) =>
        event.event_type === RuntimeGovernanceEventType.OUTPUT_SHAPING_APPLIED ||
        event.event_type === RuntimeGovernanceEventType.OUTPUT_COMMAND_COMPRESSED ||
        event.event_type === "message.completed" ||
        event.event_type === "engine.response.received"
    )
  ) {
    return;
  }

  throw new SnapshotCompactionError(
    "Incremental snapshot compaction cannot replay deferred output-shaping windows safely"
  );
}

function createSnapshotCompactionState(
  startState: RunSnapshotSurfaceState | undefined
): SnapshotCompactionState {
  return {
    workers: new Map(startState?.workers?.map((worker) => [worker.worker_id, worker]) ?? []),
    tools: new Map(startState?.tools?.map((tool) => [tool.tool_call_id, tool]) ?? []),
    approvals: new Map(startState?.approvals?.map((approval) => [approval.approval_id, approval]) ?? []),
    workerIntegrationStatuses: new Map(
      startState?.worker_integration_statuses?.map((status) => [status.workerRunId, status]) ?? []
    ),
    pendingTools: new Map(
      startState?.tools?.map((tool) => [tool.tool_call_id, { ...tool, completion_event_id: null }]) ?? []
    ),
    pendingCompletedToolOrder: [],
    pendingCompletedToolIds: new Set(),
    pendingOutputShapingDecisions: [],
    pendingToolFailOpenCutoffEventId: null,
    pendingCompressionReplayCutoffEventId: null,
    governanceFault: startState?.governance_fault ?? null,
    latestControlPlaneEventId: null
  };
}

function applySnapshotEvent(state: SnapshotCompactionState, event: EventLogEntry): void {
  if (handleWorkerStateChange(state, event)) return;
  if (handleWorkerIntegrationStatus(state, event)) return;
  if (handleToolCallStarted(state, event)) return;
  if (handleToolCallCompleted(state, event)) return;

  updatePendingToolFailOpenCutoff(state, event);
  if (handleOutputShapingApplied(state, event)) return;
  if (handleOutputCommandCompressed(state, event)) return;
  if (handleGovernanceFault(state, event)) return;
  if (handleApprovalRequested(state, event)) return;
  handleApprovalResolved(state, event);
}

function handleWorkerStateChange(state: SnapshotCompactionState, event: EventLogEntry): boolean {
  if (event.event_type !== ToolWorkerEventType.WORKER_STATE_CHANGED) {
    return false;
  }
  const parsed = parseToolWorkerEventPayloadOrThrow(
    ToolWorkerEventType.WORKER_STATE_CHANGED,
    event.payload_json,
    event
  );
  state.workers.set(parsed.workerId, {
    worker_id: parsed.workerId,
    status: parsed.state,
    ...(parsed.suspendReason === undefined ? {} : { suspend_reason: parsed.suspendReason })
  });
  markContribution(state, event);
  return true;
}

function handleWorkerIntegrationStatus(state: SnapshotCompactionState, event: EventLogEntry): boolean {
  if (event.event_type !== WorkerRuntimeEventType.WORKER_INTEGRATION_STATUS) {
    return false;
  }
  const parsed = parseWorkerRuntimeEventPayloadOrThrow(
    WorkerRuntimeEventType.WORKER_INTEGRATION_STATUS,
    event.payload_json,
    event
  );
  state.workerIntegrationStatuses.set(parsed.workerRunId, parsed);
  markContribution(state, event);
  return true;
}

function handleToolCallStarted(state: SnapshotCompactionState, event: EventLogEntry): boolean {
  if (event.event_type !== ToolWorkerEventType.TOOL_CALL_STARTED) {
    return false;
  }
  const parsed = parseToolWorkerEventPayloadOrThrow(
    ToolWorkerEventType.TOOL_CALL_STARTED,
    event.payload_json,
    event
  );
  const previous = state.pendingTools.get(parsed.toolCallId);
  const nextPendingTool = {
    tool_call_id: parsed.toolCallId,
    worker_id: parsed.workerId ?? null,
    tool_id: parsed.toolId,
    input_summary: parsed.inputSummary,
    status_kind: previous?.status_kind ?? "running",
    output_summary: previous?.output_summary ?? null,
    duration_ms: previous?.duration_ms ?? null,
    completion_event_id: previous?.completion_event_id ?? null
  };
  state.pendingTools.set(parsed.toolCallId, nextPendingTool);
  state.tools.set(parsed.toolCallId, stripPendingSnapshotToolState(nextPendingTool));
  state.pendingToolFailOpenCutoffEventId = null;
  markContribution(state, event);
  return true;
}

function handleToolCallCompleted(state: SnapshotCompactionState, event: EventLogEntry): boolean {
  if (event.event_type !== ToolWorkerEventType.TOOL_CALL_COMPLETED) {
    return false;
  }
  const parsed = parseToolWorkerEventPayloadOrThrow(
    ToolWorkerEventType.TOOL_CALL_COMPLETED,
    event.payload_json,
    event
  );
  const previous = state.pendingTools.get(parsed.toolCallId);
  if (previous === undefined) {
    throw new SnapshotCompactionError(
      `Cannot compact snapshot for ${event.run_id}: tool_call.completed ${parsed.toolCallId} has no preceding tool_call.started`
    );
  }
  state.pendingTools.set(parsed.toolCallId, {
    ...previous,
    status_kind: parsed.statusKind,
    output_summary: parsed.outputSummary ?? null,
    duration_ms: parsed.durationMs,
    completion_event_id: event.event_id
  });
  state.tools.set(parsed.toolCallId, {
    ...stripPendingSnapshotToolState(previous),
    status_kind: parsed.statusKind,
    duration_ms: parsed.durationMs
  });
  if (state.pendingCompletedToolIds.size === 0) {
    state.pendingCompressionReplayCutoffEventId = state.latestControlPlaneEventId;
  }
  if (!state.pendingCompletedToolIds.has(event.event_id)) {
    state.pendingCompletedToolIds.add(event.event_id);
    state.pendingCompletedToolOrder.push(event.event_id);
  }
  markContribution(state, event);
  return true;
}

function updatePendingToolFailOpenCutoff(
  state: SnapshotCompactionState,
  event: EventLogEntry
): void {
  if (
    state.pendingCompletedToolOrder.length > 0 &&
    (event.event_type === "message.completed" || event.event_type === "engine.response.received")
  ) {
    state.pendingToolFailOpenCutoffEventId = event.event_id;
  }
}

function handleOutputShapingApplied(state: SnapshotCompactionState, event: EventLogEntry): boolean {
  if (event.event_type !== RuntimeGovernanceEventType.OUTPUT_SHAPING_APPLIED) {
    return false;
  }
  state.pendingOutputShapingDecisions.push(
    parseRuntimeGovernanceEventPayloadOrThrow(
      RuntimeGovernanceEventType.OUTPUT_SHAPING_APPLIED,
      event.payload_json,
      event
    )
  );
  return true;
}

function handleOutputCommandCompressed(state: SnapshotCompactionState, event: EventLogEntry): boolean {
  if (event.event_type !== RuntimeGovernanceEventType.OUTPUT_COMMAND_COMPRESSED) {
    return false;
  }
  parseRuntimeGovernanceEventPayloadOrThrow(
    RuntimeGovernanceEventType.OUTPUT_COMMAND_COMPRESSED,
    event.payload_json,
    event
  );
  applyFlushResultToState(
    state,
    flushCompactedSurfaceTools({
      visibleTools: state.tools,
      pendingTools: state.pendingTools,
      pendingCompletedToolOrder: state.pendingCompletedToolOrder,
      pendingOutputShapingDecisions: state.pendingOutputShapingDecisions
    })
  );
  state.pendingToolFailOpenCutoffEventId = null;
  state.pendingCompressionReplayCutoffEventId = null;
  markContribution(state, event);
  return true;
}

function applyFlushResultToState(
  state: SnapshotCompactionState,
  flushResult: ReturnType<typeof flushCompactedSurfaceTools>
): void {
  state.tools = flushResult.visibleTools;
  state.pendingTools = flushResult.pendingTools;
  state.pendingCompletedToolOrder = flushResult.pendingCompletedToolOrder;
  state.pendingCompletedToolIds = new Set(flushResult.pendingCompletedToolOrder);
  state.pendingOutputShapingDecisions = flushResult.pendingOutputShapingDecisions;
}

function handleGovernanceFault(state: SnapshotCompactionState, event: EventLogEntry): boolean {
  if (event.event_type !== ToolWorkerEventType.GOVERNANCE_SPAM_FAULT) {
    return false;
  }
  state.governanceFault = parseToolWorkerEventPayloadOrThrow(
    ToolWorkerEventType.GOVERNANCE_SPAM_FAULT,
    event.payload_json,
    event
  );
  markContribution(state, event);
  return true;
}

function handleApprovalRequested(state: SnapshotCompactionState, event: EventLogEntry): boolean {
  if (event.event_type !== FileApprovalEventType.SOUL_APPROVAL_REQUESTED) {
    return false;
  }
  const parsed = parseFileApprovalEventPayloadOrThrow(
    FileApprovalEventType.SOUL_APPROVAL_REQUESTED,
    event.payload_json,
    event
  );
  const previous = state.approvals.get(parsed.approval_id);
  if (previous?.status !== "approved" && previous?.status !== "rejected") {
    state.approvals.set(parsed.approval_id, createPendingApproval(parsed));
    markContribution(state, event);
  }
  return true;
}

function handleApprovalResolved(state: SnapshotCompactionState, event: EventLogEntry): boolean {
  if (event.event_type !== FileApprovalEventType.SOUL_APPROVAL_RESOLVED) {
    return false;
  }
  const parsed = parseFileApprovalEventPayloadOrThrow(
    FileApprovalEventType.SOUL_APPROVAL_RESOLVED,
    event.payload_json,
    event
  );
  state.approvals.set(parsed.approval_id, {
    ...createPendingApproval(parsed),
    status: parsed.result,
    resolved_at: parsed.resolved_at
  });
  markContribution(state, event);
  return true;
}

function createPendingApproval(parsed: {
  readonly approval_id: string;
  readonly message_id: string;
  readonly description: string;
  readonly run_id: string;
  readonly risk_level?: RunSnapshotSurfaceApproval["risk_level"];
}) {
  return {
    approval_id: parsed.approval_id,
    message_id: parsed.message_id,
    description: parsed.description,
    run_id: parsed.run_id,
    ...(parsed.risk_level === undefined ? {} : { risk_level: parsed.risk_level }),
    status: "pending" as const
  };
}

function finalizeSnapshotCompactionState(state: SnapshotCompactionState): void {
  if (
    state.pendingOutputShapingDecisions.length > 0 &&
    state.pendingCompressionReplayCutoffEventId !== null
  ) {
    state.latestControlPlaneEventId = state.pendingCompressionReplayCutoffEventId;
    return;
  }
  if (
    state.pendingCompletedToolOrder.length === 0 ||
    state.pendingToolFailOpenCutoffEventId === null
  ) {
    return;
  }
  applyFlushResultToState(
    state,
    flushCompactedSurfaceTools({
      visibleTools: state.tools,
      pendingTools: state.pendingTools,
      pendingCompletedToolOrder: state.pendingCompletedToolOrder,
      pendingOutputShapingDecisions: []
    })
  );
  state.latestControlPlaneEventId = state.pendingToolFailOpenCutoffEventId;
}

function buildSnapshotCompactionResult(state: SnapshotCompactionState) {
  return {
    latestControlPlaneEventId: state.latestControlPlaneEventId,
    surfaceState: {
      ...(state.workers.size === 0 ? {} : { workers: [...state.workers.values()] }),
      ...(state.workerIntegrationStatuses.size === 0
        ? {}
        : { worker_integration_statuses: [...state.workerIntegrationStatuses.values()] }),
      ...(state.tools.size === 0 ? {} : { tools: [...state.tools.values()] }),
      ...(state.governanceFault === null ? {} : { governance_fault: state.governanceFault }),
      ...(state.approvals.size === 0 ? {} : { approvals: [...state.approvals.values()] })
    }
  };
}

function markContribution(state: SnapshotCompactionState, event: EventLogEntry): void {
  state.latestControlPlaneEventId = event.event_id;
}
