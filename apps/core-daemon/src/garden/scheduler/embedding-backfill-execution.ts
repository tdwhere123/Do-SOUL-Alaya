import { AlayaError, gardenTaskOutcomeSuccess, type GardenTaskDescriptor,
  type GardenTaskOutcome } from "@do-soul/alaya-protocol";
import type { CreateGardenSchedulerRuntimeSupportInput, EmbeddingBackfillTaskOutcome } from "./scheduler-runtime-types.js";
import type { EmbeddingBackfillCheckpoint, EmbeddingBackfillClaim } from "./embedding-backfill-checkpoint.js";
import { runAnswersWithBackfillFollowUp } from "./embedding-backfill-follow-up.js";

type FailureMapper = (error: unknown) => EmbeddingBackfillTaskOutcome;

/** Resumes the recorded phase; never reruns a finished backfill to retry formation. */
export async function executeCheckpointedBackfill(input: CreateGardenSchedulerRuntimeSupportInput,
  task: Readonly<GardenTaskDescriptor>, checkpoint: EmbeddingBackfillCheckpoint,
  claim: EmbeddingBackfillClaim, failureFrom: FailureMapper,
  sanitize: (value: string | null) => string | null): Promise<EmbeddingBackfillTaskOutcome> {
  let row = checkpoint.read(claim);
  let auditEntries: readonly string[] = ["embedding_backfill_resumed:checkpoint"];
  if (row.state === "backfilling") {
    let result: EmbeddingBackfillTaskOutcome;
    try {
      if (input.embeddingBackfillHandler === undefined) {
        throw new AlayaError("UNAVAILABLE", "embedding backfill handler is not configured");
      }
      const value = await input.embeddingBackfillHandler.handle(task,
        { taskId: claim.taskId, ownerToken: claim.ownerToken });
      const recorded = new Set(checkpoint.objectIds(claim));
      if (value.objectsAffected.some(id => !recorded.has(id))) {
        throw new AlayaError("CONFLICT", "Embedding backfill returned an uncheckpointed committed object.");
      }
      const outcome = value.outcome === "skipped" && recorded.size > 0 ? "completed" : value.outcome;
      result = makeOutcome(outcome, value.objectsAffected, value.auditEntries, value.errorMessage ?? null);
    } catch (error) {
      result = failureFrom(error);
    }
    auditEntries = result.auditEntries;
    row = checkpoint.read(claim);
    if (row.state === "blocked") return blockedBackfill(checkpoint.objectIds(claim));
    await checkpoint.finishBackfill(claim, result.outcome, sanitize(result.errorMessage));
    row = checkpoint.read(claim);
  }
  if (row.state === "blocked") return blockedBackfill(checkpoint.objectIds(claim));
  const ids = checkpoint.objectIds(claim);
  const followUp = await runAnswersWithBackfillFollowUp(input, checkpoint, claim);
  const outcome = row.backfill_outcome === "failed" || followUp.outcome === "failed" ? "failed"
    : row.backfill_outcome ?? undefined;
  const entries = [...auditEntries, followUp.auditEntry];
  if (ids.length >= 2 && row.mode !== "cache_only") {
    entries.push("embedding_backfill_coherence_follow_up_deferred:formation_receipt_required");
  }
  return makeOutcome(outcome, ids, entries, followUp.errorMessage ?? row.backfill_error);
}

export function makeOutcome(outcome: GardenTaskOutcome | undefined, objectsAffected: readonly string[],
  auditEntries: readonly string[], errorMessage: string | null): EmbeddingBackfillTaskOutcome {
  return Object.freeze({ outcome, success: outcome === undefined ? true : gardenTaskOutcomeSuccess(outcome),
    objectsAffected: Object.freeze([...objectsAffected]), auditEntries: Object.freeze([...auditEntries]), errorMessage });
}

function blockedBackfill(ids: readonly string[]): EmbeddingBackfillTaskOutcome {
  return makeOutcome("failed", ids, ["embedding_backfill_answers_with_follow_up_blocked:source_unavailable"],
    "embedding_backfill_answers_with_follow_up_blocked:source_unavailable");
}
