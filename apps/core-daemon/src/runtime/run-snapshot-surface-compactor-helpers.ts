import {
  type EventLogEntry,
  parseFileApprovalEventPayload,
  parseRuntimeGovernanceEventPayload,
  parseToolWorkerEventPayload,
  parseWorkerRuntimeEventPayload,
  type OutputShapingAppliedPayload,
  type RunSnapshotSurfaceToolState
} from "@do-soul/alaya-protocol";

export class SnapshotCompactionError extends Error {}

export interface PendingSnapshotToolState extends RunSnapshotSurfaceToolState {
  readonly completion_event_id: string | null;
}

export function flushCompactedSurfaceTools(input: {
  readonly visibleTools: ReadonlyMap<string, RunSnapshotSurfaceToolState>;
  readonly pendingTools: ReadonlyMap<string, PendingSnapshotToolState>;
  readonly pendingCompletedToolOrder: readonly string[];
  readonly pendingOutputShapingDecisions: readonly OutputShapingAppliedPayload[];
}) {
  if (input.pendingCompletedToolOrder.length === 0) {
    return {
      visibleTools: new Map(input.visibleTools),
      pendingTools: new Map(input.pendingTools),
      pendingCompletedToolOrder: [],
      pendingOutputShapingDecisions: []
    };
  }
  const pendingCompletedByEventId = createPendingCompletedByEventId(input.pendingTools);
  const decisionsByFirstEventId = new Map(
    input.pendingOutputShapingDecisions.map((decision) => [decision.original_event_ids[0], decision] as const)
  );
  const flushedToolCallIds = new Set<string>();
  const flushedTools: RunSnapshotSurfaceToolState[] = [];
  for (let index = 0; index < input.pendingCompletedToolOrder.length; ) {
    index = flushCompletedToolAtIndex(
      input.pendingCompletedToolOrder,
      index,
      pendingCompletedByEventId,
      decisionsByFirstEventId,
      flushedToolCallIds,
      flushedTools
    );
  }
  return buildFlushedSurfaceTools(input, flushedToolCallIds, flushedTools);
}

function createPendingCompletedByEventId(
  pendingTools: ReadonlyMap<string, PendingSnapshotToolState>
) {
  return new Map(
    [...pendingTools.values()]
      .filter(
        (tool): tool is PendingSnapshotToolState & { readonly completion_event_id: string } =>
          tool.completion_event_id !== null
      )
      .map((tool) => [tool.completion_event_id, tool] as const)
  );
}

function flushCompletedToolAtIndex(
  eventOrder: readonly string[],
  index: number,
  pendingCompletedByEventId: ReadonlyMap<string, PendingSnapshotToolState & { readonly completion_event_id: string }>,
  decisionsByFirstEventId: ReadonlyMap<string | undefined, OutputShapingAppliedPayload>,
  flushedToolCallIds: Set<string>,
  flushedTools: RunSnapshotSurfaceToolState[]
): number {
  const currentEventId = eventOrder[index];
  const decision = decisionsByFirstEventId.get(currentEventId);
  if (decision !== undefined) {
    const nextIndex = flushDecisionGroup(
      eventOrder,
      index,
      decision,
      pendingCompletedByEventId,
      flushedToolCallIds,
      flushedTools
    );
    if (nextIndex !== null) {
      return nextIndex;
    }
  }
  const currentTool = currentEventId === undefined ? undefined : pendingCompletedByEventId.get(currentEventId);
  if (currentTool !== undefined) {
    flushedTools.push(stripPendingSnapshotToolState(currentTool));
    flushedToolCallIds.add(currentTool.tool_call_id);
  }
  return index + 1;
}

function flushDecisionGroup(
  eventOrder: readonly string[],
  index: number,
  decision: OutputShapingAppliedPayload,
  pendingCompletedByEventId: ReadonlyMap<string, PendingSnapshotToolState & { readonly completion_event_id: string }>,
  flushedToolCallIds: Set<string>,
  flushedTools: RunSnapshotSurfaceToolState[]
): number | null {
  if (!matchesSnapshotDecisionWindow(eventOrder, index, decision)) {
    return null;
  }
  const group = decision.original_event_ids
    .map((eventId) => pendingCompletedByEventId.get(eventId))
    .filter((tool): tool is Exclude<typeof tool, undefined> => tool !== undefined);
  if (group.length !== decision.original_event_ids.length) {
    return null;
  }
  flushedTools.push(...compressSnapshotToolGroup(group, decision));
  for (const tool of group) {
    flushedToolCallIds.add(tool.tool_call_id);
  }
  return index + decision.original_event_ids.length;
}

function buildFlushedSurfaceTools(
  input: {
    readonly visibleTools: ReadonlyMap<string, RunSnapshotSurfaceToolState>;
    readonly pendingTools: ReadonlyMap<string, PendingSnapshotToolState>;
  },
  flushedToolCallIds: ReadonlySet<string>,
  flushedTools: readonly RunSnapshotSurfaceToolState[]
) {
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

export function stripPendingSnapshotToolState(
  tool: PendingSnapshotToolState
): RunSnapshotSurfaceToolState {
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

export function parseToolWorkerEventPayloadOrThrow<T extends Parameters<typeof parseToolWorkerEventPayload>[0]>(
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

export function parseRuntimeGovernanceEventPayloadOrThrow<
  T extends Parameters<typeof parseRuntimeGovernanceEventPayload>[0]
>(type: T, payload: Record<string, unknown>, event: EventLogEntry) {
  try {
    return parseRuntimeGovernanceEventPayload(type, payload);
  } catch (error) {
    throw createSnapshotCompactionParseError(event, error);
  }
}

export function parseWorkerRuntimeEventPayloadOrThrow<
  T extends Parameters<typeof parseWorkerRuntimeEventPayload>[0]
>(type: T, payload: Record<string, unknown>, event: EventLogEntry) {
  try {
    return parseWorkerRuntimeEventPayload(type, payload);
  } catch (error) {
    throw createSnapshotCompactionParseError(event, error);
  }
}

export function parseFileApprovalEventPayloadOrThrow<
  T extends Parameters<typeof parseFileApprovalEventPayload>[0]
>(type: T, payload: Record<string, unknown>, event: EventLogEntry) {
  try {
    return parseFileApprovalEventPayload(type, payload);
  } catch (error) {
    throw createSnapshotCompactionParseError(event, error);
  }
}

function createSnapshotCompactionParseError(
  event: EventLogEntry,
  error: unknown
): SnapshotCompactionError {
  const detail = error instanceof Error ? error.message : String(error);
  return new SnapshotCompactionError(
    `Cannot compact snapshot for ${event.run_id}: malformed ${event.event_type} payload at ${event.event_id} (${detail})`
  );
}
