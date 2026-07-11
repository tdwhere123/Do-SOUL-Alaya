import { randomUUID } from "node:crypto";
import {
  GardenRole,
  GardenTier,
  HealthIssueResolutionState,
  type EventLogEntry,
  type GardenRoleValue,
  type GardenTaskDescriptor,
  type GardenTaskResult,
  type GardenTierValue,
  type HealthIssueCauseKindValue,
  type HealthIssueGroup,
  type HealthIssueSuggestedActionValue,
  type HealthJournalRecordPort
} from "@do-soul/alaya-protocol";
import type { AuditorDependencies } from "./auditor-types.js";
import {
  createGardenFailureResult,
  createGardenSuccessResult,
  formatGardenTaskError
} from "./garden-task-runner.js";

export function addMillisecondsIso(isoTimestamp: string, deltaMs: number): string {
  return new Date(new Date(isoTimestamp).getTime() + deltaMs).toISOString();
}

export class GreenRevokeNoopError extends Error {
  public readonly memoryEntryId: string;
  public readonly workspaceId: string;

  public constructor(memoryEntryId: string, workspaceId: string) {
    super(`revokeGreen affected zero rows for memory ${memoryEntryId} in workspace ${workspaceId}`);
    this.name = "GreenRevokeNoopError";
    this.memoryEntryId = memoryEntryId;
    this.workspaceId = workspaceId;
  }
}

export abstract class AuditorCore {
  public readonly role: GardenRoleValue = GardenRole.AUDITOR;
  public readonly tier: GardenTierValue = GardenTier.TIER_1;

  protected readonly healthJournal: HealthJournalRecordPort | null;
  protected readonly now: () => string;

  protected constructor(protected readonly dependencies: AuditorDependencies) {
    this.healthJournal = dependencies.healthJournal ?? null;
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  protected async upsertHealthIssueGroup(input: {
    readonly workspaceId: string;
    readonly targetObjectId: string;
    readonly causeKind: HealthIssueCauseKindValue;
    readonly severity: "info" | "warn" | "blocking";
    readonly confidence: number;
    readonly observedAt: string;
    readonly suggestedActions: readonly HealthIssueSuggestedActionValue[];
    readonly incrementCount: number;
  }): Promise<void> {
    const port = this.dependencies.healthIssueGroupPort;
    if (port === undefined) {
      return;
    }
    let existing: Readonly<HealthIssueGroup> | null;
    try {
      const lookup = port.findExistingGroup({
        workspaceId: input.workspaceId,
        targetObjectId: input.targetObjectId,
        causeKind: input.causeKind
      });
      existing = lookup instanceof Promise ? await lookup : lookup;
    } catch (error) {
      emitAuditorProjectionWarning("find_existing_health_issue_group", error, {
        workspace_id: input.workspaceId,
        target_object_id: input.targetObjectId,
        cause_kind: input.causeKind
      });
      throw error;
    }

    const groupId = existing?.group_id ?? (port.generateGroupId?.() ?? randomUUID());
    const next: HealthIssueGroup = {
      group_id: groupId,
      workspace_id: input.workspaceId,
      target_object_id: input.targetObjectId,
      target_object_kind: "memory_entry",
      cause_kind: input.causeKind,
      severity: input.severity,
      confidence: input.confidence,
      first_seen_at: existing?.first_seen_at ?? input.observedAt,
      last_seen_at: input.observedAt,
      count: (existing?.count ?? 0) + Math.max(1, input.incrementCount),
      suggested_actions: input.suggestedActions,
      resolution_state: HealthIssueResolutionState.PENDING,
      resolved_at: null,
      resolved_by: null
    };

    try {
      await port.upsertHealthIssueGroup(next);
    } catch (error) {
      emitAuditorProjectionWarning("upsert_health_issue_group", error, {
        workspace_id: input.workspaceId,
        target_object_id: input.targetObjectId,
        cause_kind: input.causeKind,
        group_id: groupId
      });
      throw error;
    }
  }

  protected async appendEventLogAndMutate<T>(
    entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">,
    mutate: (entry: EventLogEntry | null) => T
  ): Promise<T> {
    const eventLogRepo = this.dependencies.eventLogRepo;
    if (eventLogRepo === undefined) {
      return mutate(null);
    }

    return await eventLogRepo.appendManyWithMutation([entry], ([eventLogEntry]) =>
      mutate(eventLogEntry ?? null)
    );
  }

  protected createSuccessResult(
    task: GardenTaskDescriptor,
    completedAt: string,
    objectIds: readonly string[],
    auditEntries: readonly string[]
  ): GardenTaskResult {
    return createGardenSuccessResult(
      { role: this.role, tier: this.tier },
      task,
      completedAt,
      objectIds,
      auditEntries
    );
  }

  protected createFailureResult(
    task: GardenTaskDescriptor,
    completedAt: string,
    error: unknown
  ): GardenTaskResult {
    return createGardenFailureResult({ role: this.role, tier: this.tier }, task, completedAt, error);
  }
}

function emitAuditorProjectionWarning(
  operation: string,
  error: unknown,
  detail: Record<string, unknown>
): void {
  process.emitWarning("[Auditor] best-effort projection failed", {
    code: "ALAYA_AUDITOR_PROJECTION_FAILED",
    detail: JSON.stringify({
      operation,
      error: formatGardenTaskError(error),
      ...detail
    })
  });
}
