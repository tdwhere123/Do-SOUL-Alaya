import { CoreError, appendEventLogSynchronously, type SourceGroundingDeferTransitionPort } from "@do-soul/alaya-core";
import { SignalEventType, SoulSignalMaterializedPayloadSchema, SoulSignalNormalizedPayloadSchema,
  SoulSignalTriagedPayloadSchema, UnavailableSourceStatementSignalSchema, isSourceGroundingDeferReason,
  type EventLogEntry } from "@do-soul/alaya-protocol";
import type { SqliteEventLogRepo, SqliteSignalRepo, SqliteSourceGroundingDeferQueueRepo } from "@do-soul/alaya-storage";

type SourceGroundingDeferRecoveryPage = ReturnType<NonNullable<SourceGroundingDeferTransitionPort["listRecoveryCandidates"]>>;
type SourceGroundingDeferRecoveryEntry = SourceGroundingDeferRecoveryPage["entries"][number];

type Repos = Readonly<{ eventLogRepo: SqliteEventLogRepo; signalRepo: SqliteSignalRepo;
  queueRepo: SqliteSourceGroundingDeferQueueRepo }>;

/** A completed atomic deferral, not merely a DEFERRED label or a historical success-shaped audit.
 * Queue absence is eligible only at that exact latest revision: no later attempt/outcome is inferred away.
 * Active/unfinished claims cannot be evicted by the queue owner and remain ineligible here. */
function readRecoveryEvidence(repos: Repos, workspaceId: string, signalId: string): SourceGroundingDeferRecoveryEntry | null {
  const signal = repos.signalRepo.getByIdInCurrentTransaction(signalId);
  if (signal === null || signal.workspace_id !== workspaceId || signal.signal_state !== "deferred" ||
      !repos.signalRepo.hasMaterializationLineage(signalId) || UnavailableSourceStatementSignalSchema.safeParse(signal).success ||
      repos.queueRepo.get(workspaceId, signalId) !== null) return null;
  const [triage] = repos.eventLogRepo.queryByEntityTypeBeforeInCurrentTransaction(
    "candidate_memory_signal", signalId, SignalEventType.SOUL_SIGNAL_TRIAGED, null, 1);
  const parsed = SoulSignalTriagedPayloadSchema.safeParse(triage?.payload_json);
  const reason = parsed.success ? parsed.data.defer_reason : undefined;
  if (triage === undefined || !parsed.success || parsed.data.triage_result !== "deferred" ||
      parsed.data.defer_class !== "source_grounding" || reason === undefined || !isSourceGroundingDeferReason(reason) ||
      !matchesIdentity(triage, parsed.data, signal)) return null;
  const [outcome] = repos.eventLogRepo.queryByEntityTypeBeforeInCurrentTransaction(
    "candidate_memory_signal", signalId, SignalEventType.SOUL_SIGNAL_MATERIALIZED, triage.revision, 1);
  const materialized = SoulSignalMaterializedPayloadSchema.safeParse(outcome?.payload_json);
  if (outcome === undefined || outcome.revision !== triage.revision - 1 || !materialized.success ||
      !materialized.data.success || materialized.data.created_objects.length !== 0 ||
      materialized.data.disposition !== "deferred" || materialized.data.target_kind !== "deferred" ||
      !matchesIdentity(outcome, materialized.data, signal) ||
      !repos.signalRepo.matchesUnqueuedDeferredRevision(workspaceId, signalId, triage.revision)) return null;
  return { signal_id: signalId, workspace_id: workspaceId, run_id: signal.run_id,
    defer_reason: reason, triage_revision: triage.revision };
}

function matchesIdentity(event: EventLogEntry, payload: { signal_id: string; workspace_id: string; run_id: string | null },
  signal: { signal_id: string; workspace_id: string; run_id: string }): boolean {
  return event.workspace_id === signal.workspace_id && event.run_id === signal.run_id &&
    payload.signal_id === signal.signal_id && payload.workspace_id === signal.workspace_id && payload.run_id === signal.run_id;
}

export function listGroundingRecoveryCandidates(repos: Repos, workspaceId: string,
  afterSignalId: string | null, limit: number): SourceGroundingDeferRecoveryPage {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new CoreError("VALIDATION", "Recovery page limit must be from 1 to 1000.");
  // Scan pagination advances over refused evidence too; an empty eligible page is not exhaustion.
  return repos.eventLogRepo.transactional(() => {
    const candidates = repos.signalRepo.listUnqueuedDeferredIds(workspaceId, afterSignalId, limit + 1);
    const page = candidates.slice(0, limit), entries: SourceGroundingDeferRecoveryEntry[] = [];
    for (const id of page) {
      const entry = readRecoveryEvidence(repos, workspaceId, id);
      if (entry !== null) entries.push(entry);
    }
    return { entries, next_after_signal_id: candidates.length > limit ? page.at(-1)! : null };
  });
}

/** Caller owns the transaction through claim + CAS. A saturated/refused claim rolls back this audit and queue admission. */
export function readmitGroundingDeferral(repos: Repos, workspaceId: string, signalId: string): EventLogEntry {
  const proof = readRecoveryEvidence(repos, workspaceId, signalId);
  if (proof === null) throw new CoreError("CONFLICT", "Unqueued source-grounding deferral has no current quiescent recovery proof.");
  const event = appendEventLogSynchronously(repos.eventLogRepo, {
    event_type: SignalEventType.SOUL_SIGNAL_NORMALIZED, entity_type: "candidate_memory_signal", entity_id: signalId,
    workspace_id: workspaceId, run_id: proof.run_id, caused_by: "operator_redrive",
    payload_json: SoulSignalNormalizedPayloadSchema.parse({ signal_id: signalId, workspace_id: workspaceId, run_id: proof.run_id,
      normalized_fields: { source_grounding_readmission: { action: "recover_unqueued", triage_revision: proof.triage_revision } } })
  });
  repos.queueRepo.enqueue({ signal_id: signalId, workspace_id: workspaceId, run_id: proof.run_id, defer_reason: proof.defer_reason });
  return event;
}
