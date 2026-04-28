import {
  IsoDatetimeStringSchema,
  ObligationBlockedOperationSchema,
  ObligationViolationBlockedPayloadSchema,
  PhaseBEventType,
  type ObligationBlockedOperation,
  type DeferredObligation,
  type EventLogEntry
} from "@do-what/protocol";
import { CoreError } from "./errors.js";
import type { EventPublisher } from "./event-publisher.js";
import { parseNonEmptyString } from "./shared/validators.js";

export type ConstrainedOperation = ObligationBlockedOperation;

export interface ConstraintProxyDependencies {
  readonly obligationLookup: {
    findActiveByRun(runId: string): Promise<readonly Readonly<DeferredObligation>[]>;
  };
  readonly eventPublisher: EventPublisher;
  readonly now?: () => string;
}

export class ConstraintProxy {
  public constructor(private readonly deps: ConstraintProxyDependencies) {}

  public async assertNoViolation(
    workspaceId: string,
    runId: string,
    operation: ConstrainedOperation
  ): Promise<void> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspaceId");
    const parsedRunId = parseNonEmptyString(runId, "runId");
    const parsedOperation = parseOperation(operation);

    const activeObligations = await this.deps.obligationLookup.findActiveByRun(parsedRunId);

    if (activeObligations.length === 0) {
      return;
    }

    const blockedAt = this.resolveNow();
    const payload = ObligationViolationBlockedPayloadSchema.parse({
      workspace_id: parsedWorkspaceId,
      run_id: parsedRunId,
      operation: parsedOperation,
      active_obligation_ids: activeObligations.map((obligation) => obligation.obligation_id),
      blocked_at: blockedAt
    });

    await this.deps.eventPublisher.publish({
      event_type: PhaseBEventType.OBLIGATION_VIOLATION_BLOCKED,
      entity_type: "run",
      entity_id: parsedRunId,
      workspace_id: parsedWorkspaceId,
      run_id: parsedRunId,
      caused_by: "constraint_proxy",
      revision: 0,
      payload_json: payload
    } satisfies Omit<EventLogEntry, "event_id" | "created_at">);

    throw new CoreError(
      "OBLIGATION_VIOLATION",
      `Operation ${parsedOperation} blocked by ${activeObligations.length} active deferred obligations.`
    );
  }

  private resolveNow(): string {
    const now = this.deps.now?.() ?? new Date().toISOString();

    try {
      return IsoDatetimeStringSchema.parse(now);
    } catch (error) {
      throw new CoreError("VALIDATION", "now must return a valid ISO datetime string", {
        cause: error instanceof Error ? error : undefined
      });
    }
  }
}

function parseOperation(operation: ConstrainedOperation): ConstrainedOperation {
  try {
    return ObligationBlockedOperationSchema.parse(operation);
  } catch (error) {
    throw new CoreError("VALIDATION", "operation must be a supported constrained operation", {
      cause: error instanceof Error ? error : undefined
    });
  }
}
