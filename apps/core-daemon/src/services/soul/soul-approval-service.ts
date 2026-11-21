import { CoreError, type EventPublisher } from "@do-soul/alaya-core";
import {
  FileApprovalEventType,
  parseFileApprovalEventPayload,
  type EventLogEntry,
  type SoulApprovalRequestedPayload
} from "@do-soul/alaya-protocol";
import type { EventLogRepo } from "@do-soul/alaya-storage";

export interface SoulApprovalActionInput {
  readonly approvalId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly causedBy: string;
}

export interface SoulApprovalResolution {
  readonly approval_id: string;
  readonly result: "approved" | "rejected";
  readonly resolved_at: string;
}

interface SoulApprovalServiceDependencies {
  readonly eventLogRepo: Pick<EventLogRepo, "queryByEntityInCurrentTransaction">;
  readonly eventPublisher: EventPublisher;
  readonly runLookup: (runId: string) => Promise<{
    readonly run_id: string;
    readonly workspace_id: string;
  }>;
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
  // Cross-workspace runs are indistinguishable from missing ones so an
  // approval cannot be resolved through a foreign workspace binding.
  if (run.workspace_id !== input.workspaceId) {
    throw new CoreError("NOT_FOUND", "Pending approval not found for run");
  }

  const { result: resolution } = await dependencies.eventPublisher.mutateThenAppendMany(() => {
    const approvalEvents = dependencies.eventLogRepo.queryByEntityInCurrentTransaction(
      "approval",
      input.approvalId
    );
    const { approvalRequest } = getApprovalState(approvalEvents, {
      approvalId: input.approvalId,
      runId: run.run_id,
      workspaceId: run.workspace_id
    });
    const resolvedAt = now();
    const resolved: SoulApprovalResolution = {
      approval_id: input.approvalId,
      result,
      resolved_at: resolvedAt
    };

    return {
      events: [buildResolvedApprovalEvent(input, run, approvalRequest, resolvedAt, result)],
      result: resolved
    };
  });

  return resolution;
}

function buildResolvedApprovalEvent(
  input: SoulApprovalActionInput,
  run: { readonly run_id: string; readonly workspace_id: string },
  approvalRequest: SoulApprovalRequestedPayload,
  resolvedAt: string,
  result: "approved" | "rejected"
) {
  return {
    event_type: FileApprovalEventType.SOUL_APPROVAL_RESOLVED,
    entity_type: "approval" as const,
    entity_id: input.approvalId,
    workspace_id: run.workspace_id,
    run_id: run.run_id,
    caused_by: input.causedBy,
    payload_json: {
      message_id: approvalRequest.message_id,
      approval_id: input.approvalId,
      result,
      description: approvalRequest.description,
      resolved_at: resolvedAt,
      ...(approvalRequest.risk_level === undefined
        ? {}
        : { risk_level: approvalRequest.risk_level }),
      ...(approvalRequest.source_kind === undefined
        ? {}
        : { source_kind: approvalRequest.source_kind }),
      run_id: run.run_id
    }
  };
}

function getApprovalState(
  approvalEvents: readonly EventLogEntry[],
  scope: {
    readonly approvalId: string;
    readonly runId: string;
    readonly workspaceId: string;
  }
): {
  readonly approvalRequest: SoulApprovalRequestedPayload;
} {
  let approvalRequest: SoulApprovalRequestedPayload | null = null;

  for (const event of approvalEvents) {
    if (
      event.entity_type !== "approval" ||
      event.entity_id !== scope.approvalId ||
      event.workspace_id !== scope.workspaceId ||
      event.run_id !== scope.runId
    ) {
      continue;
    }

    if (event.event_type === FileApprovalEventType.SOUL_APPROVAL_REQUESTED) {
      const requested = parseApprovalRequestedPayload(event);
      if (requested.approval_id === scope.approvalId && requested.run_id === scope.runId) {
        approvalRequest = requested;
      }
      continue;
    }

    if (event.event_type === FileApprovalEventType.SOUL_APPROVAL_RESOLVED) {
      const resolved = parseApprovalResolvedPayload(event);
      if (resolved.approval_id === scope.approvalId && resolved.run_id === scope.runId) {
        throw new CoreError("CONFLICT", "Approval has already been resolved");
      }
    }
  }

  if (approvalRequest === null) {
    throw new CoreError("NOT_FOUND", "Pending approval not found for run");
  }

  return {
    approvalRequest
  };
}

function parseApprovalRequestedPayload(event: EventLogEntry): SoulApprovalRequestedPayload {
  try {
    return parseFileApprovalEventPayload(FileApprovalEventType.SOUL_APPROVAL_REQUESTED, toPayloadRecord(event));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid SOUL approval requested payload", { cause: error });
  }
}

function parseApprovalResolvedPayload(event: EventLogEntry) {
  try {
    return parseFileApprovalEventPayload(FileApprovalEventType.SOUL_APPROVAL_RESOLVED, toPayloadRecord(event));
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
