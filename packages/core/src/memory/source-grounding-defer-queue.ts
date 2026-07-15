import { createHash } from "node:crypto";
import {
  isSourceGroundingDeferReason,
  type CandidateMemorySignal,
  type EventLogEntry,
  type SourceGroundingDeferEnqueueInput,
  type SourceGroundingDeferEnqueueResult,
  type SourceGroundingDeferEntry,
  type SourceGroundingDeferReason,
  type SourceGroundingDeferStats
} from "@do-soul/alaya-protocol";

export {
  SOURCE_GROUNDING_DEFER_QUEUE_CAP,
  SOURCE_GROUNDING_DEFER_QUEUE_OVERFLOW_ALLOWANCE,
  type SourceGroundingDeferEnqueueInput,
  type SourceGroundingDeferEnqueueResult,
  type SourceGroundingDeferEntry,
  type SourceGroundingDeferReason,
  type SourceGroundingDeferStats
} from "@do-soul/alaya-protocol";

/**
 * Bounded review/re-drive working set for garden source-grounding deferrals.
 * Fail-closed materialization stays closed; this queue makes loss operator-visible
 * and re-driveable. Rows are governance metadata only (invariant §14) — never
 * durable memory objects.
 *
 * Cap is storage-budget-derived (~200B metadata/row → ~400KB at 2048), not a
 * recall-quality tuning knob.
 */
export type SourceGroundingDeferClass = "source_grounding";

export { createInMemorySourceGroundingDeferQueue } from "./source-grounding-defer/in-memory-queue.js";

export interface SourceGroundingDeferQueuePort {
  enqueue(input: SourceGroundingDeferEnqueueInput): SourceGroundingDeferEnqueueResult;
  get(workspaceId: string, signalId: string): SourceGroundingDeferEntry | null;
  list(workspaceId: string, limit?: number): readonly SourceGroundingDeferEntry[];
  stats(workspaceId: string): SourceGroundingDeferStats;
  aggregateStats(): SourceGroundingDeferStats;
}

export interface SourceGroundingDeferQueueStatePort extends SourceGroundingDeferQueuePort {
  claim(
    workspaceId: string,
    signalId: string,
    claimToken: string,
    claimTokenFingerprint: string,
    claimExpiresAt: string
  ): SourceGroundingDeferEntry | null;
  ownsClaim(workspaceId: string, signalId: string, claimToken: string): boolean;
  readClaimCapability(workspaceId: string, signalId: string): {
    readonly claimToken: string;
    readonly claimExpiresAt: string;
  } | null;
  clearExpiredClaim(input: {
    readonly workspaceId: string;
    readonly signalId: string;
    readonly claimToken: string;
    readonly claimExpiresAt: string;
    readonly expiredBefore: string;
  }): boolean;
  removeClaimed(workspaceId: string, signalId: string, claimToken: string): boolean;
}

export type SourceGroundingDeferEventInput = Omit<
  EventLogEntry,
  "event_id" | "created_at" | "revision"
>;

export interface SourceGroundingDeferTransitionPort {
  recordDefer(input: {
    readonly signal: CandidateMemorySignal;
    readonly defer_reason: SourceGroundingDeferReason;
    readonly events: readonly [
      SourceGroundingDeferEventInput,
      SourceGroundingDeferEventInput
    ];
    readonly claim_token?: string;
  }): SourceGroundingDeferRecordTransition;
  claimRedrive(input: {
    readonly workspace_id: string;
    readonly signal_id: string;
    readonly raw_payload?: CandidateMemorySignal["raw_payload"];
    readonly audit_event?: SourceGroundingDeferEventInput;
    readonly claim_token: string;
    readonly claim_expires_at: string;
  }): SourceGroundingDeferClaim | null;
  completeRedrive(input: {
    readonly workspace_id: string;
    readonly signal_id: string;
    readonly event: SourceGroundingDeferEventInput;
    readonly claim_token: string;
  }): SourceGroundingDeferCommittedTransition;
  failRedrive(input: {
    readonly workspace_id: string;
    readonly signal_id: string;
    readonly event: SourceGroundingDeferEventInput;
    readonly claim_token: string;
  }): SourceGroundingDeferCommittedTransition;
  reconcileStaleClaim(input: {
    readonly workspace_id: string;
    readonly signal_id: string;
    readonly claim_token_fingerprint: string;
    readonly claim_expires_at: string;
    readonly expired_before: string;
    readonly event: SourceGroundingDeferEventInput;
  }): SourceGroundingDeferCommittedTransition;
}

export interface SourceGroundingDeferClaim {
  readonly signal: CandidateMemorySignal;
  readonly audit_event: EventLogEntry | null;
  readonly claim_token: string;
}

export interface SourceGroundingDeferCommittedTransition {
  readonly signal: CandidateMemorySignal;
  readonly event: EventLogEntry;
}

export interface SourceGroundingDeferRecordTransition {
  readonly signal: CandidateMemorySignal;
  /** Materialization result first, corrective defer triage second. */
  readonly events: readonly [EventLogEntry, EventLogEntry];
  readonly queue_result: SourceGroundingDeferEnqueueResult;
}

export function fingerprintSourceGroundingClaimToken(claimToken: string): string {
  return `sha256:${createHash("sha256").update(claimToken, "utf8").digest("hex")}`;
}

export function readSourceGroundingDeferMeta(materialization: {
  readonly routing_reason: string;
  readonly defer_reason?: string;
  readonly defer_class?: string;
}): {
  readonly defer_reason: SourceGroundingDeferReason;
  readonly defer_class: SourceGroundingDeferClass;
} | null {
  if (
    materialization.defer_class === "source_grounding" &&
    materialization.defer_reason !== undefined &&
    isSourceGroundingDeferReason(materialization.defer_reason)
  ) {
    return {
      defer_reason: materialization.defer_reason,
      defer_class: "source_grounding"
    };
  }
  const match = /^garden source grounding failed: (.+)$/u.exec(materialization.routing_reason);
  if (match?.[1] && isSourceGroundingDeferReason(match[1])) {
    return { defer_reason: match[1], defer_class: "source_grounding" };
  }
  return null;
}
