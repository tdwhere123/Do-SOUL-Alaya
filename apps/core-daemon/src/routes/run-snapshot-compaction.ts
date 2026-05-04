import {
  type EventLogEntry,
  parseToolWorkerEventPayload,
  parseWorkerRuntimeEventPayload,
  parseRuntimeGovernanceEventPayload,
  parseFileApprovalEventPayload,
  ToolWorkerEventType,
  WorkerRuntimeEventType,
  RuntimeGovernanceEventType,
  FileApprovalEventType,
  type OutputShapingAppliedPayload,
  type RunSnapshotSurfaceApproval,
  type RunSnapshotSurfaceState,
  type RunSnapshotSurfaceToolState,
  type RunSnapshotSurfaceWorkerState,
  type WorkerIntegrationStatusPayload
} from "@do-soul/alaya-protocol";

export class SnapshotCompactionError extends Error {}

interface PendingSnapshotToolState extends RunSnapshotSurfaceToolState {
  readonly completion_event_id: string | null;
}

/**
 * Compacts a sequence of EventLogEntry records into a RunSnapshotSurfaceState.
 *
 * @param events - The ordered event log entries to process.
 * @param startState - Optional prior surface state to use as the starting point
 *   for the maps. When provided the function only processes delta events on top
 *   of an already-compacted base, enabling incremental compaction. Omit (or
 *   pass undefined) for a full replay starting from an empty state.
 */
export function compactRunSnapshotSurfaceState(
  events: readonly EventLogEntry[],
  startState?: RunSnapshotSurfaceState
): {
  readonly surfaceState: RunSnapshotSurfaceState;
  readonly latestControlPlaneEventId: string | null;
} {
  if (
    startState !== undefined &&
    events.some(
      (event) =>
        event.event_type === RuntimeGovernanceEventType.OUTPUT_SHAPING_APPLIED ||
        event.event_type === RuntimeGovernanceEventType.OUTPUT_COMMAND_COMPRESSED ||
        event.event_type === "message.completed" ||
        event.event_type === "engine.response.received"
    )
  ) {
    throw new SnapshotCompactionError(
      "Incremental snapshot compaction cannot replay deferred output-shaping windows safely"
    );
  }

  // Seed maps from the optional prior surface state (incremental path).
  const workers = new Map<string, RunSnapshotSurfaceWorkerState>(
    startState?.workers?.map((w) => [w.worker_id, w]) ?? []
  );
  let tools = new Map<string, RunSnapshotSurfaceToolState>(
    startState?.tools?.map((t) => [t.tool_call_id, t]) ?? []
  );
  const approvals = new Map<string, RunSnapshotSurfaceApproval>(
    startState?.approvals?.map((a) => [a.approval_id, a]) ?? []
  );
  const workerIntegrationStatuses = new Map<string, WorkerIntegrationStatusPayload>(
    startState?.worker_integration_statuses?.map((s) => [s.workerRunId, s]) ?? []
  );
  let pendingTools = new Map<string, PendingSnapshotToolState>(
    startState?.tools?.map((tool) => [tool.tool_call_id, { ...tool, completion_event_id: null }]) ?? []
  );
  let pendingCompletedToolOrder: string[] = [];
  let pendingCompletedToolIds = new Set<string>();
  let pendingOutputShapingDecisions: OutputShapingAppliedPayload[] = [];
  let pendingToolFailOpenCutoffEventId: string | null = null;
  let pendingCompressionReplayCutoffEventId: string | null = null;
  let governanceFault: RunSnapshotSurfaceState["governance_fault"] = startState?.governance_fault ?? null;
  let latestControlPlaneEventId: string | null = null;

  const markContribution = (event: EventLogEntry): void => {
    latestControlPlaneEventId = event.event_id;
  };

  for (const event of events) {
    const payload = event.payload_json;

    if (event.event_type === ToolWorkerEventType.WORKER_STATE_CHANGED) {
      const parsed = parseToolWorkerEventPayloadOrThrow(
        ToolWorkerEventType.WORKER_STATE_CHANGED,
        payload,
        event
      );
      workers.set(parsed.workerId, {
        worker_id: parsed.workerId,
        status: parsed.state,
        ...(parsed.suspendReason !== undefined ? { suspend_reason: parsed.suspendReason } : {})
      });
      markContribution(event);

      continue;
    }

    if (event.event_type === WorkerRuntimeEventType.WORKER_INTEGRATION_STATUS) {
      const parsed = parseWorkerRuntimeEventPayloadOrThrow(
        WorkerRuntimeEventType.WORKER_INTEGRATION_STATUS,
        payload,
        event
      );
      workerIntegrationStatuses.set(parsed.workerRunId, parsed);
      markContribution(event);

      continue;
    }

    if (event.event_type === ToolWorkerEventType.TOOL_CALL_STARTED) {
      const parsed = parseToolWorkerEventPayloadOrThrow(
        ToolWorkerEventType.TOOL_CALL_STARTED,
        payload,
        event
      );
      const previous = pendingTools.get(parsed.toolCallId);

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
      pendingTools.set(parsed.toolCallId, nextPendingTool);
      tools.set(parsed.toolCallId, stripPendingSnapshotToolState(nextPendingTool));
      pendingToolFailOpenCutoffEventId = null;
      markContribution(event);

      continue;
    }

    if (event.event_type === ToolWorkerEventType.TOOL_CALL_COMPLETED) {
      const parsed = parseToolWorkerEventPayloadOrThrow(
        ToolWorkerEventType.TOOL_CALL_COMPLETED,
        payload,
        event
      );
      const previous = pendingTools.get(parsed.toolCallId);

      if (previous === undefined) {
        throw new SnapshotCompactionError(
          `Cannot compact snapshot for ${event.run_id}: tool_call.completed ${parsed.toolCallId} has no preceding tool_call.started`
        );
      }

      pendingTools.set(parsed.toolCallId, {
        ...previous,
        status_kind: parsed.statusKind,
        output_summary: parsed.outputSummary ?? null,
        duration_ms: parsed.durationMs,
        completion_event_id: event.event_id
      });
      tools.set(parsed.toolCallId, {
        ...stripPendingSnapshotToolState(previous),
        status_kind: parsed.statusKind,
        duration_ms: parsed.durationMs
      });
      if (pendingCompletedToolIds.size === 0) {
        pendingCompressionReplayCutoffEventId = latestControlPlaneEventId;
      }
      if (!pendingCompletedToolIds.has(event.event_id)) {
        pendingCompletedToolIds.add(event.event_id);
        pendingCompletedToolOrder.push(event.event_id);
      }
      markContribution(event);

      continue;
    }

    if (
      pendingCompletedToolOrder.length > 0 &&
      (event.event_type === "message.completed" || event.event_type === "engine.response.received")
    ) {
      pendingToolFailOpenCutoffEventId = event.event_id;
    }

    if (event.event_type === RuntimeGovernanceEventType.OUTPUT_SHAPING_APPLIED) {
      pendingOutputShapingDecisions.push(
        parseRuntimeGovernanceEventPayloadOrThrow(RuntimeGovernanceEventType.OUTPUT_SHAPING_APPLIED, payload, event)
      );

      continue;
    }

    if (event.event_type === RuntimeGovernanceEventType.OUTPUT_COMMAND_COMPRESSED) {
      parseRuntimeGovernanceEventPayloadOrThrow(RuntimeGovernanceEventType.OUTPUT_COMMAND_COMPRESSED, payload, event);
      const flushResult = flushCompactedSurfaceTools({
        visibleTools: tools,
        pendingTools,
        pendingCompletedToolOrder,
        pendingOutputShapingDecisions
      });
      tools = flushResult.visibleTools;
      pendingTools = flushResult.pendingTools;
      pendingCompletedToolOrder = flushResult.pendingCompletedToolOrder;
      pendingCompletedToolIds = new Set(pendingCompletedToolOrder);
      pendingOutputShapingDecisions = flushResult.pendingOutputShapingDecisions;
      pendingToolFailOpenCutoffEventId = null;
      pendingCompressionReplayCutoffEventId = null;
      markContribution(event);

      continue;
    }

    if (event.event_type === ToolWorkerEventType.GOVERNANCE_SPAM_FAULT) {
      governanceFault = parseToolWorkerEventPayloadOrThrow(
        ToolWorkerEventType.GOVERNANCE_SPAM_FAULT,
        payload,
        event
      );
      markContribution(event);
      continue;
    }

    if (event.event_type === FileApprovalEventType.SOUL_APPROVAL_REQUESTED) {
      const parsed = parseFileApprovalEventPayloadOrThrow(
        FileApprovalEventType.SOUL_APPROVAL_REQUESTED,
        payload,
        event
      );
      const previous = approvals.get(parsed.approval_id);

      if (previous?.status !== "approved" && previous?.status !== "rejected") {
        approvals.set(parsed.approval_id, {
          approval_id: parsed.approval_id,
          message_id: parsed.message_id,
          description: parsed.description,
          run_id: parsed.run_id,
          ...(parsed.risk_level !== undefined ? { risk_level: parsed.risk_level } : {}),
          status: "pending"
        });
        markContribution(event);
      }

      continue;
    }

    if (event.event_type === FileApprovalEventType.SOUL_APPROVAL_RESOLVED) {
      const parsed = parseFileApprovalEventPayloadOrThrow(
        FileApprovalEventType.SOUL_APPROVAL_RESOLVED,
        payload,
        event
      );
      approvals.set(parsed.approval_id, {
        approval_id: parsed.approval_id,
        message_id: parsed.message_id,
        description: parsed.description,
        run_id: parsed.run_id,
        ...(parsed.risk_level !== undefined ? { risk_level: parsed.risk_level } : {}),
        status: parsed.result,
        resolved_at: parsed.resolved_at
      });
      markContribution(event);
    }
  }

  if (pendingOutputShapingDecisions.length > 0 && pendingCompressionReplayCutoffEventId !== null) {
    latestControlPlaneEventId = pendingCompressionReplayCutoffEventId;
  } else if (pendingCompletedToolOrder.length > 0 && pendingToolFailOpenCutoffEventId !== null) {
    const flushResult = flushCompactedSurfaceTools({
      visibleTools: tools,
      pendingTools,
      pendingCompletedToolOrder,
      pendingOutputShapingDecisions: []
    });
    tools = flushResult.visibleTools;
    pendingTools = flushResult.pendingTools;
    pendingCompletedToolOrder = flushResult.pendingCompletedToolOrder;
    pendingCompletedToolIds = new Set(pendingCompletedToolOrder);
    pendingOutputShapingDecisions = flushResult.pendingOutputShapingDecisions;
    latestControlPlaneEventId = pendingToolFailOpenCutoffEventId;
  }

  return {
    latestControlPlaneEventId,
    surfaceState: {
      ...(workers.size > 0 ? { workers: [...workers.values()] } : {}),
      ...(workerIntegrationStatuses.size > 0
        ? { worker_integration_statuses: [...workerIntegrationStatuses.values()] }
        : {}),
      ...(tools.size > 0 ? { tools: [...tools.values()] } : {}),
      ...(governanceFault !== null ? { governance_fault: governanceFault } : {}),
      ...(approvals.size > 0 ? { approvals: [...approvals.values()] } : {})
    }
  };
}

function flushCompactedSurfaceTools(input: {
  readonly visibleTools: ReadonlyMap<string, RunSnapshotSurfaceToolState>;
  readonly pendingTools: ReadonlyMap<string, PendingSnapshotToolState>;
  readonly pendingCompletedToolOrder: readonly string[];
  readonly pendingOutputShapingDecisions: readonly OutputShapingAppliedPayload[];
}): {
  readonly visibleTools: Map<string, RunSnapshotSurfaceToolState>;
  readonly pendingTools: Map<string, PendingSnapshotToolState>;
  readonly pendingCompletedToolOrder: string[];
  readonly pendingOutputShapingDecisions: OutputShapingAppliedPayload[];
} {
  if (input.pendingCompletedToolOrder.length === 0) {
    return {
      visibleTools: new Map(input.visibleTools),
      pendingTools: new Map(input.pendingTools),
      pendingCompletedToolOrder: [],
      pendingOutputShapingDecisions: []
    };
  }

  const pendingCompletedByEventId = new Map(
    [...input.pendingTools.values()]
      .filter((tool): tool is PendingSnapshotToolState & { readonly completion_event_id: string } => tool.completion_event_id !== null)
      .map((tool) => [tool.completion_event_id, tool] as const)
  );
  const decisionsByFirstEventId = new Map(
    input.pendingOutputShapingDecisions.map((decision) => [decision.original_event_ids[0], decision] as const)
  );
  const flushedToolCallIds = new Set<string>();
  const flushedTools: RunSnapshotSurfaceToolState[] = [];

  for (let index = 0; index < input.pendingCompletedToolOrder.length; ) {
    const currentEventId = input.pendingCompletedToolOrder[index];
    const decision =
      currentEventId === undefined ? undefined : decisionsByFirstEventId.get(currentEventId);

    if (decision !== undefined && matchesSnapshotDecisionWindow(input.pendingCompletedToolOrder, index, decision)) {
      const group = decision.original_event_ids
        .map((eventId) => pendingCompletedByEventId.get(eventId))
        .filter((tool): tool is Exclude<typeof tool, undefined> => tool !== undefined);

      if (group.length === decision.original_event_ids.length) {
        const compressedGroup = compressSnapshotToolGroup(group, decision);
        flushedTools.push(...compressedGroup);
        for (const tool of group) {
          flushedToolCallIds.add(tool.tool_call_id);
        }
        index += decision.original_event_ids.length;
        continue;
      }
    }

    if (currentEventId !== undefined) {
      const currentTool = pendingCompletedByEventId.get(currentEventId);
      if (currentTool !== undefined) {
        flushedTools.push(stripPendingSnapshotToolState(currentTool));
        flushedToolCallIds.add(currentTool.tool_call_id);
      }
    }

    index += 1;
  }

  return {
    visibleTools: new Map([
      ...[...input.visibleTools.entries()].filter(([toolCallId]) => !flushedToolCallIds.has(toolCallId)),
      ...flushedTools.map((tool) => [tool.tool_call_id, tool] as const)
    ]),
    pendingTools: new Map(
      [...input.pendingTools.entries()].filter(([toolCallId]) => !flushedToolCallIds.has(toolCallId))
    ),
    pendingCompletedToolOrder: [],
    pendingOutputShapingDecisions: []
  };
}

function matchesSnapshotDecisionWindow(
  eventOrder: readonly string[],
  startIndex: number,
  decision: OutputShapingAppliedPayload
): boolean {
  return decision.original_event_ids.every(
    (eventId, offset) => eventOrder[startIndex + offset] === eventId
  );
}

function compressSnapshotToolGroup(
  group: readonly (RunSnapshotSurfaceToolState & { readonly completion_event_id: string })[],
  decision: OutputShapingAppliedPayload
): readonly RunSnapshotSurfaceToolState[] {
  switch (decision.compression_mode) {
    case "last_only":
      return [stripPendingSnapshotToolState(group[group.length - 1]!)];
    case "first_last":
      return [
        stripPendingSnapshotToolState(group[0]!),
        stripPendingSnapshotToolState(group[group.length - 1]!)
      ];
    case "count_summary": {
      const representative = group[group.length - 1]!;
      const summary = `${decision.original_count} ${decision.command_class} outputs compressed`;
      const durationMs = group.reduce<number | null>((total, tool) => {
        if (tool.duration_ms === null) {
          return total;
        }

        return (total ?? 0) + tool.duration_ms;
      }, null);

      return [
        {
          tool_call_id: representative.tool_call_id,
          worker_id: representative.worker_id,
          tool_id: representative.tool_id,
          input_summary: summary,
          status_kind: representative.status_kind,
          output_summary: summary,
          duration_ms: durationMs
        }
      ];
    }
  }
}

function stripPendingSnapshotToolState(tool: PendingSnapshotToolState): RunSnapshotSurfaceToolState {
  return {
    tool_call_id: tool.tool_call_id,
    worker_id: tool.worker_id,
    tool_id: tool.tool_id,
    input_summary: tool.input_summary,
    status_kind: tool.status_kind,
    output_summary: tool.output_summary,
    duration_ms: tool.duration_ms
  };
}

function parseToolWorkerEventPayloadOrThrow<T extends Parameters<typeof parseToolWorkerEventPayload>[0]>(
  type: T,
  payload: Record<string, unknown>,
  event: EventLogEntry
) {
  try {
    return parseToolWorkerEventPayload(type, payload);
  } catch (error) {
    throw createSnapshotCompactionParseError(event, error);
  }
}

function parseRuntimeGovernanceEventPayloadOrThrow<T extends Parameters<typeof parseRuntimeGovernanceEventPayload>[0]>(
  type: T,
  payload: Record<string, unknown>,
  event: EventLogEntry
) {
  try {
    return parseRuntimeGovernanceEventPayload(type, payload);
  } catch (error) {
    throw createSnapshotCompactionParseError(event, error);
  }
}

function parseWorkerRuntimeEventPayloadOrThrow<T extends Parameters<typeof parseWorkerRuntimeEventPayload>[0]>(
  type: T,
  payload: Record<string, unknown>,
  event: EventLogEntry
) {
  try {
    return parseWorkerRuntimeEventPayload(type, payload);
  } catch (error) {
    throw createSnapshotCompactionParseError(event, error);
  }
}

function parseFileApprovalEventPayloadOrThrow<T extends Parameters<typeof parseFileApprovalEventPayload>[0]>(
  type: T,
  payload: Record<string, unknown>,
  event: EventLogEntry
) {
  try {
    return parseFileApprovalEventPayload(type, payload);
  } catch (error) {
    throw createSnapshotCompactionParseError(event, error);
  }
}

function createSnapshotCompactionParseError(event: EventLogEntry, error: unknown): SnapshotCompactionError {
  const detail = error instanceof Error ? error.message : String(error);
  return new SnapshotCompactionError(
    `Cannot compact snapshot for ${event.run_id}: malformed ${event.event_type} payload at ${event.event_id} (${detail})`
  );
}
