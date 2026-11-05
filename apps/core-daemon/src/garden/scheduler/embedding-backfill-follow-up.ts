import type { CreateGardenSchedulerRuntimeSupportInput } from "./scheduler-runtime-types.js";
import type { EmbeddingBackfillClaim, EmbeddingBackfillCheckpoint } from "./embedding-backfill-checkpoint.js";

type FollowUpResult = Readonly<{
  readonly outcome: "completed" | "skipped" | "failed";
  readonly auditEntry: string;
  readonly errorMessage: string | null;
}>;

const COMPLETED: FollowUpResult = Object.freeze({ outcome: "completed",
  auditEntry: "embedding_backfill_answers_with_follow_up_completed", errorMessage: null });

/** Replays only the frozen witnessed plan through the assertion admission owner. */
export async function runAnswersWithBackfillFollowUp(input: CreateGardenSchedulerRuntimeSupportInput,
  checkpoint: EmbeddingBackfillCheckpoint, claim: EmbeddingBackfillClaim): Promise<FollowUpResult> {
  const row = checkpoint.read(claim);
  if (row.state === "completed") return COMPLETED;
  if (row.state === "skipped") return skippedResult(row.last_error ?? "insufficient_objects");
  if (row.state === "blocked") return blockedResult(row.last_error ?? "source_unavailable");
  if (row.mode === "cache_only") {
    await checkpoint.settle(claim, "skipped", "cache_only");
    return skippedResult("cache_only");
  }
  const objectIds = checkpoint.objectIds(claim);
  if (objectIds.length < 2) {
    await checkpoint.settle(claim, "skipped", "insufficient_objects");
    return skippedResult("insufficient_objects");
  }
  const port = input.answersWithEdgeProducerPort;
  if (port === undefined) {
    await checkpoint.settle(claim, "retryable_failure", "unwired");
    return { outcome: "failed", auditEntry: "embedding_backfill_answers_with_follow_up_failed:unwired",
      errorMessage: "embedding_backfill_answers_with_follow_up_failed:unwired" };
  }

  let plan: Awaited<ReturnType<typeof port.prepareForBackfill>>;
  try {
    checkpoint.assertPendingInCurrentTransaction(claim);
    plan = await port.prepareForBackfill({ workspaceId: claim.workspaceId, runId: null, objectIds });
  } catch (error) {
    return await settleFailure(input, checkpoint, claim, error);
  }
  if (!checkpoint.pinPlan(claim, plan.digest)) {
    await checkpoint.settle(claim, "blocked", "formation_changed");
    return blockedResult("formation_changed");
  }
  try {
    await plan.execute(() => checkpoint.assertPendingInCurrentTransaction(claim));
  } catch (error) {
    return await settleFailure(input, checkpoint, claim, error);
  }
  await checkpoint.settle(claim, "completed");
  return COMPLETED;
}

async function settleFailure(input: CreateGardenSchedulerRuntimeSupportInput,
  checkpoint: EmbeddingBackfillCheckpoint, claim: EmbeddingBackfillClaim,
  error: unknown): Promise<FollowUpResult> {
  const row = checkpoint.read(claim);
  if (row.state === "blocked") return blockedResult();
  const blocked = isUnavailableOrChanged(error);
  await checkpoint.settle(claim, blocked ? "blocked" : "retryable_failure",
    blocked ? "source_unavailable" : "operation_failed");
  input.warn("answers_with crystallization failed after embedding backfill", {
    workspace_id: claim.workspaceId, phase: "answers_with", retryable: !blocked,
    error: error instanceof Error ? error.name : "UnknownError"
  });
  return blocked ? blockedResult() : {
    outcome: "failed", auditEntry: "embedding_backfill_answers_with_follow_up_failed",
    errorMessage: "embedding_backfill_answers_with_follow_up_failed"
  };
}

function skippedResult(reason: string): FollowUpResult {
  return { outcome: "skipped", auditEntry: `embedding_backfill_answers_with_follow_up_skipped:${reason}`,
    errorMessage: null };
}

function blockedResult(reason = "source_unavailable"): FollowUpResult {
  return { outcome: "failed", auditEntry: `embedding_backfill_answers_with_follow_up_blocked:${reason}`,
    errorMessage: `embedding_backfill_answers_with_follow_up_blocked:${reason}` };
}

function isUnavailableOrChanged(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && typeof current.code === "string" &&
        ["CONFLICT", "NOT_FOUND", "VALIDATION", "VALIDATION_FAILED", "FORBIDDEN", "UNAUTHORIZED"].includes(current.code)) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
