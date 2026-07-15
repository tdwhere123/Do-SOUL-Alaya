import { randomUUID } from "node:crypto";
import {
  IsoDatetimeStringSchema,
  SignalEventType,
  SignalState,
  SoulSignalMaterializedPayloadSchema,
  SoulSignalNormalizedPayloadSchema,
  SoulSignalTriagedPayloadSchema,
  type CandidateMemorySignal
} from "@do-soul/alaya-protocol";
import {
  buildEventLogRawPayloadSummary,
  buildSignalWarningMeta,
  hashAuditText
} from "./signal-service-helpers.js";
import { stableStringify } from "../shared/stable-stringify.js";
import {
  SOURCE_GROUNDING_DEFER_QUEUE_OVERFLOW_ALLOWANCE,
  readSourceGroundingDeferMeta,
  type SourceGroundingDeferClaim,
  type SourceGroundingDeferEventInput,
  type SourceGroundingDeferStats
} from "./source-grounding-defer-queue.js";
import type {
  SignalMaterializationResult,
  SignalServiceDependencies,
  SignalServiceReceiveResult,
  SignalServiceWarnPort
} from "./signal-service-types.js";
import { CoreError } from "../shared/errors.js";

const SOURCE_GROUNDING_REDRIVE_LEASE_MS = 5 * 60 * 1000;

export async function claimSourceGroundingRedrive(input: {
  readonly dependencies: SignalServiceDependencies;
  readonly warn: SignalServiceWarnPort;
  readonly workspaceId: string;
  readonly signalId: string;
  readonly rawPayload?: CandidateMemorySignal["raw_payload"];
}): Promise<SourceGroundingDeferClaim> {
  const existing = await input.dependencies.signalRepo.getById(input.signalId);
  const transitions = input.dependencies.sourceGroundingDeferTransitions;
  if (existing === null || existing.workspace_id !== input.workspaceId) {
    throw new Error(`Signal ${input.signalId} was not found for grounding re-drive.`);
  }
  if (input.dependencies.postTriageMaterializer === undefined || transitions === undefined) {
    throw new Error("postTriageMaterializer is required for grounding re-drive.");
  }
  const claimToken = randomUUID();
  const claim = transitions.claimRedrive({
    workspace_id: input.workspaceId,
    signal_id: input.signalId,
    claim_token: claimToken,
    claim_expires_at: new Date(Date.now() + SOURCE_GROUNDING_REDRIVE_LEASE_MS).toISOString(),
    ...(input.rawPayload === undefined ? {} : {
      raw_payload: input.rawPayload,
      audit_event: buildRedrivePatchAuditEvent(existing, input.rawPayload)
    })
  });
  if (claim === null) throw redriveClaimConflict(input.signalId);
  await notifyCommittedEventBestEffort(claim.audit_event, input.dependencies, input.warn);
  return claim;
}

export async function reconcileStaleSourceGroundingClaim(input: {
  readonly dependencies: SignalServiceDependencies;
  readonly warn: SignalServiceWarnPort;
  readonly workspaceId: string;
  readonly signalId: string;
  readonly claimTokenFingerprint: string;
  readonly expectedClaimExpiresAt: string;
  readonly reason: string;
}): Promise<CandidateMemorySignal> {
  const reason = input.reason.trim();
  if (reason.length === 0) throw new Error("Grounding reconciliation requires a reason.");
  if (!/^sha256:[0-9a-f]{64}$/u.test(input.claimTokenFingerprint)) {
    throw new Error("Grounding reconciliation requires a claim-token fingerprint.");
  }
  const expectedClaimExpiresAt = IsoDatetimeStringSchema.parse(input.expectedClaimExpiresAt);
  const signal = await input.dependencies.signalRepo.getById(input.signalId);
  const transitions = input.dependencies.sourceGroundingDeferTransitions;
  if (signal === null || signal.workspace_id !== input.workspaceId || transitions === undefined) {
    throw new Error(`Signal ${input.signalId} was not found for grounding reconciliation.`);
  }
  const committed = transitions.reconcileStaleClaim({
    workspace_id: input.workspaceId,
    signal_id: input.signalId,
    claim_token_fingerprint: input.claimTokenFingerprint,
    claim_expires_at: expectedClaimExpiresAt,
    expired_before: new Date().toISOString(),
    event: buildStaleClaimReconciliationEvent({
      signal,
      claimTokenFingerprint: input.claimTokenFingerprint,
      expectedClaimExpiresAt,
      reason
    })
  });
  await notifyCommittedEventBestEffort(committed.event, input.dependencies, input.warn);
  return committed.signal;
}

export function buildSignalMaterializationEvent(
  signal: CandidateMemorySignal,
  materialization: SignalMaterializationResult
): SourceGroundingDeferEventInput {
  return {
    event_type: materialization.success
      ? SignalEventType.SOUL_SIGNAL_MATERIALIZED
      : SignalEventType.SOUL_SIGNAL_MATERIALIZATION_FAILED,
    entity_type: "candidate_memory_signal",
    entity_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    caused_by: "materialization_router",
    payload_json: SoulSignalMaterializedPayloadSchema.parse({
      signal_id: signal.signal_id,
      workspace_id: signal.workspace_id,
      run_id: signal.run_id,
      created_objects: materialization.created_objects,
      success: materialization.success,
      ...(materialization.success === false ? {
        error: `materialization_error:${hashAuditText(materialization.error)}:chars:${materialization.error.length}`
      } : {})
    })
  };
}

export function buildSourceGroundingDeferEvent(input: {
  readonly signal: CandidateMemorySignal;
  readonly materialization: SignalMaterializationResult;
}): SourceGroundingDeferEventInput | null {
  const meta = readSourceGroundingDeferMeta(input.materialization);
  if (meta === null) return null;
  return buildDeferredTriageEvent(input.signal, meta);
}

function buildDeferredTriageEvent(
  signal: CandidateMemorySignal,
  meta: ReturnType<typeof readSourceGroundingDeferMeta>
): SourceGroundingDeferEventInput {
  return {
    event_type: SignalEventType.SOUL_SIGNAL_TRIAGED,
    entity_type: "candidate_memory_signal",
    entity_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    caused_by: "materialization_router",
    payload_json: SoulSignalTriagedPayloadSchema.parse({
      signal_id: signal.signal_id,
      workspace_id: signal.workspace_id,
      run_id: signal.run_id,
      triage_result: "deferred",
      ...(meta === null ? {} : {
        defer_reason: meta.defer_reason,
        defer_class: meta.defer_class
      })
    })
  };
}

export function buildRedrivePatchAuditEvent(
  signal: CandidateMemorySignal,
  rawPayload: CandidateMemorySignal["raw_payload"]
): SourceGroundingDeferEventInput {
  return {
    event_type: SignalEventType.SOUL_SIGNAL_NORMALIZED,
    entity_type: "candidate_memory_signal",
    entity_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    caused_by: "operator_redrive",
    payload_json: SoulSignalNormalizedPayloadSchema.parse({
      signal_id: signal.signal_id,
      workspace_id: signal.workspace_id,
      run_id: signal.run_id,
      normalized_fields: {
        source_grounding_redrive_patch: {
          changed_field_count: listChangedRawPayloadKeys(signal.raw_payload, rawPayload).length,
          ...buildEventLogRawPayloadSummary(rawPayload)
        }
      }
    })
  };
}

function listChangedRawPayloadKeys(
  previous: CandidateMemorySignal["raw_payload"],
  next: CandidateMemorySignal["raw_payload"]
): readonly string[] {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...keys]
    .filter((key) => stableStringify(previous[key]) !== stableStringify(next[key]))
    .sort();
}

export function buildStaleClaimReconciliationEvent(input: {
  readonly signal: CandidateMemorySignal;
  readonly claimTokenFingerprint: string;
  readonly expectedClaimExpiresAt: string;
  readonly reason: string;
}): SourceGroundingDeferEventInput {
  return {
    event_type: SignalEventType.SOUL_SIGNAL_NORMALIZED,
    entity_type: "candidate_memory_signal",
    entity_id: input.signal.signal_id,
    workspace_id: input.signal.workspace_id,
    run_id: input.signal.run_id,
    caused_by: "operator_reconciliation",
    payload_json: SoulSignalNormalizedPayloadSchema.parse({
      signal_id: input.signal.signal_id,
      workspace_id: input.signal.workspace_id,
      run_id: input.signal.run_id,
      normalized_fields: {
        source_grounding_redrive_reconciliation: {
          action: "release_stale_claim",
          expected_claim_expires_at: input.expectedClaimExpiresAt,
          claim_token_sha256: input.claimTokenFingerprint,
          reason_sha256: hashAuditText(input.reason),
          reason_char_count: input.reason.length
        }
      }
    })
  };
}

export async function completeDeferredMaterialization(input: {
  readonly dependencies: SignalServiceDependencies;
  readonly warn: SignalServiceWarnPort;
  readonly signal: CandidateMemorySignal;
  readonly materialization: SignalMaterializationResult;
  readonly claimToken?: string;
}): Promise<SignalServiceReceiveResult> {
  const meta = readSourceGroundingDeferMeta(input.materialization);
  if (meta === null) return await completeGenericDeferredMaterialization(input);
  const deferEvent = buildDeferredTriageEvent(input.signal, meta);
  const transitions = input.dependencies.sourceGroundingDeferTransitions;
  if (transitions === undefined) throw unavailableTransitionError();
  const committed = transitions.recordDefer({
    signal: input.signal,
    defer_reason: meta.defer_reason,
    events: [buildSignalMaterializationEvent(input.signal, input.materialization), deferEvent],
    ...(input.claimToken === undefined ? {} : { claim_token: input.claimToken })
  });
  warnOnQueueEviction(committed.queue_result, input.warn);
  for (const event of committed.events) {
    await notifyCommittedEventBestEffort(event, input.dependencies, input.warn);
  }
  return {
    signal: committed.signal,
    triage_result: "deferred",
    materialization: input.materialization
  };
}

async function completeGenericDeferredMaterialization(input: {
  readonly dependencies: SignalServiceDependencies;
  readonly warn: SignalServiceWarnPort;
  readonly signal: CandidateMemorySignal;
  readonly materialization: SignalMaterializationResult;
}): Promise<SignalServiceReceiveResult> {
  const materializedEvent = await input.dependencies.eventLogRepo.append(
    buildSignalMaterializationEvent(input.signal, input.materialization)
  );
  const signal = await input.dependencies.signalRepo.updateState(
    input.signal.signal_id,
    SignalState.DEFERRED
  );
  await notifyCommittedEventBestEffort(materializedEvent, input.dependencies, input.warn);
  const deferredEvent = await input.dependencies.eventLogRepo.append(
    buildDeferredTriageEvent(input.signal, null)
  );
  await notifyCommittedEventBestEffort(deferredEvent, input.dependencies, input.warn);
  return {
    signal,
    triage_result: "deferred",
    materialization: input.materialization
  };
}

export async function recordFailedSourceGroundingRedrive(input: {
  readonly dependencies: SignalServiceDependencies;
  readonly warn: SignalServiceWarnPort;
  readonly signal: CandidateMemorySignal;
  readonly materialization: SignalMaterializationResult;
  readonly claimToken: string;
}): Promise<SignalServiceReceiveResult> {
  const transitions = requireTransitions(input.dependencies);
  const committed = transitions.failRedrive({
    workspace_id: input.signal.workspace_id,
    signal_id: input.signal.signal_id,
    claim_token: input.claimToken,
    event: buildSignalMaterializationEvent(input.signal, input.materialization)
  });
  await notifyCommittedEventBestEffort(committed.event, input.dependencies, input.warn);
  input.warn(
    "Source-grounding redrive failed; claim retained for operator reconciliation.",
    buildSignalWarningMeta({
      phase: "source_grounding_redrive",
      code: "REDRIVE_UNCERTAIN",
      itemCount: input.materialization.created_objects.length
    })
  );
  return {
    signal: committed.signal,
    triage_result: "deferred",
    materialization: input.materialization
  };
}

export async function completeSuccessfulSourceGroundingRedrive(input: {
  readonly dependencies: SignalServiceDependencies;
  readonly warn: SignalServiceWarnPort;
  readonly signal: CandidateMemorySignal;
  readonly materialization: SignalMaterializationResult;
  readonly claimToken: string;
}): Promise<SignalServiceReceiveResult> {
  const transitions = requireTransitions(input.dependencies);
  const committed = transitions.completeRedrive({
    workspace_id: input.signal.workspace_id,
    signal_id: input.signal.signal_id,
    claim_token: input.claimToken,
    event: buildSignalMaterializationEvent(input.signal, input.materialization)
  });
  await notifyCommittedEventBestEffort(committed.event, input.dependencies, input.warn);
  return {
    signal: committed.signal,
    triage_result: "accepted",
    materialization: input.materialization
  };
}

async function notifyCommittedEventBestEffort(
  event: Awaited<ReturnType<SignalServiceDependencies["eventLogRepo"]["append"]>> | null,
  dependencies: SignalServiceDependencies,
  warn: SignalServiceWarnPort
): Promise<void> {
  if (event === null || event.run_id === null) return;
  try {
    await dependencies.runtimeNotifier.notifyEntry(event);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "runtime notification failed";
    warn(
      "Committed signal event notification failed; EventLog remains replayable.",
      buildSignalWarningMeta({
        phase: "event_notification",
        code: "RUNTIME_NOTIFY_FAILED",
        detail
      })
    );
  }
}

function warnOnQueueEviction(
  result: NonNullable<ReturnType<NonNullable<
    SignalServiceDependencies["sourceGroundingDeferQueue"]
  >["enqueue"]>>,
  warn: SignalServiceWarnPort
): void {
  if (result.evicted === null) return;
  warn(
    "Source grounding defer queue evicted oldest unclaimed entry at workspace FIFO cap.",
    buildSignalWarningMeta({
      phase: "source_grounding_defer_queue",
      code: "FIFO_EVICTION",
      itemCount: 1
    })
  );
}

function requireTransitions(dependencies: SignalServiceDependencies) {
  const transitions = dependencies.sourceGroundingDeferTransitions;
  if (transitions === undefined) throw unavailableTransitionError();
  return transitions;
}

function unavailableTransitionError(): CoreError {
  return new CoreError("CONFLICT", "Source-grounding transition port is unavailable.", {
    subCode: "PORT_UNAVAILABLE"
  });
}

function redriveClaimConflict(signalId: string): CoreError {
  return new CoreError(
    "CONFLICT",
    `Source-grounding defer ${signalId} is not queued, not deferred, or already claimed.`,
    { subCode: "CONCURRENT_MODIFICATION" }
  );
}

export function emptySourceGroundingDeferStats(cap: number): SourceGroundingDeferStats {
  return {
    queue_depth: 0,
    queue_cap: cap,
    queue_cap_per_workspace: cap,
    queue_hard_limit_per_workspace:
      cap + SOURCE_GROUNDING_DEFER_QUEUE_OVERFLOW_ALLOWANCE,
    queue_scope: "aggregate",
    claimable_depth: 0,
    capacity_blocked_depth: 0,
    capacity_state: "ready",
    deferred_by_reason: {}
  };
}
