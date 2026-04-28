import { CoreError } from "@do-what/core";
import {
  Phase5EventType,
  parsePhase5EventPayload,
  type EventLogEntry,
  type SoulApprovalRequestedPayload
} from "@do-what/protocol";
import type { EventLogRepo } from "@do-what/storage";

export interface SoulApprovalActionInput {
  readonly approvalId: string;
  readonly runId: string;
  readonly causedBy: string;
}

export interface SoulApprovalResolution {
  readonly approval_id: string;
  readonly result: "approved" | "rejected";
  readonly resolved_at: string;
}

interface SoulApprovalServiceDependencies {
  readonly eventLogRepo: Pick<EventLogRepo, "append" | "queryByRun">;
  readonly runLookup: (runId: string) => Promise<{
    readonly run_id: string;
    readonly workspace_id: string;
  }>;
  readonly sseBroadcaster: {
    broadcastEntry(entry: EventLogEntry): void | Promise<void>;
  };
  readonly now?: () => string;
}

export function createSoulApprovalService(dependencies: SoulApprovalServiceDependencies) {
  const now = dependencies.now ?? (() => new Date().toISOString());

  return {
    approve: async (input: SoulApprovalActionInput): Promise<SoulApprovalResolution> =>
      await resolveSoulApproval(dependencies, now, input, "approved"),
    reject: async (input: SoulApprovalActionInput): Promise<SoulApprovalResolution> =>
      await resolveSoulApproval(dependencies, now, input, "rejected")
  };
}

async function resolveSoulApproval(
  dependencies: SoulApprovalServiceDependencies,
  now: () => string,
  input: SoulApprovalActionInput,
  result: "approved" | "rejected"
): Promise<SoulApprovalResolution> {
  const run = await dependencies.runLookup(input.runId);
  const runEvents = await dependencies.eventLogRepo.queryByRun(run.run_id);
  const approvalState = getApprovalState(runEvents, input.approvalId);
  const resolvedAt = now();
  const entry = await dependencies.eventLogRepo.append({
    event_type: Phase5EventType.SOUL_APPROVAL_RESOLVED,
    entity_type: "approval",
    entity_id: input.approvalId,
    workspace_id: run.workspace_id,
    run_id: run.run_id,
    caused_by: input.causedBy,
    revision: approvalState.maxRevision + 1,
    payload_json: {
      message_id: approvalState.approvalRequest.message_id,
      approval_id: input.approvalId,
      result,
      description: approvalState.approvalRequest.description,
      resolved_at: resolvedAt,
      ...(approvalState.approvalRequest.risk_level === undefined
        ? {}
        : { risk_level: approvalState.approvalRequest.risk_level }),
      ...(approvalState.approvalRequest.source_kind === undefined
        ? {}
        : { source_kind: approvalState.approvalRequest.source_kind }),
      run_id: run.run_id
    }
  });

  await dependencies.sseBroadcaster.broadcastEntry(entry);

  return {
    approval_id: input.approvalId,
    result,
    resolved_at: resolvedAt
  };
}

function getApprovalState(runEvents: readonly EventLogEntry[], approvalId: string): {
  readonly approvalRequest: SoulApprovalRequestedPayload;
  readonly maxRevision: number;
} {
  let approvalRequest: SoulApprovalRequestedPayload | null = null;
  let maxRevision = -1;

  for (const event of runEvents) {
    if (event.entity_type !== "approval" || event.entity_id !== approvalId) {
      continue;
    }

    if (event.revision > maxRevision) {
      maxRevision = event.revision;
    }

    if (event.event_type === Phase5EventType.SOUL_APPROVAL_REQUESTED) {
      approvalRequest = parseApprovalRequestedPayload(event);
      continue;
    }

    if (event.event_type === Phase5EventType.SOUL_APPROVAL_RESOLVED) {
      validateApprovalResolvedPayload(event);
      throw new CoreError("CONFLICT", "Approval has already been resolved");
    }
  }

  if (approvalRequest === null) {
    throw new CoreError("NOT_FOUND", "Pending approval not found for run");
  }

  return {
    approvalRequest,
    maxRevision
  };
}

function parseApprovalRequestedPayload(event: EventLogEntry): SoulApprovalRequestedPayload {
  try {
    return parsePhase5EventPayload(Phase5EventType.SOUL_APPROVAL_REQUESTED, toPayloadRecord(event));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid SOUL approval requested payload", { cause: error });
  }
}

function validateApprovalResolvedPayload(event: EventLogEntry): void {
  try {
    parsePhase5EventPayload(Phase5EventType.SOUL_APPROVAL_RESOLVED, toPayloadRecord(event));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid SOUL approval resolved payload", { cause: error });
  }
}

function toPayloadRecord(event: EventLogEntry): Record<string, unknown> {
  if (event.payload_json === null || typeof event.payload_json !== "object" || Array.isArray(event.payload_json)) {
    throw new CoreError("VALIDATION", `Event ${event.event_id} payload must be an object`);
  }

  return event.payload_json as Record<string, unknown>;
}
