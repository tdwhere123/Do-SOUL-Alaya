// invariant: multiturn / crossquestion variants have NO setup-time loud
// embedding-readiness gate (unlike the single-question runner.ts, which calls
// workspace.warmEmbeddingCache and throws on not-ready). For these two variants
// the per-question runtime.runGardenEmbeddingBackfillPass(workspaceId) call IS
// the only embedding-readiness mechanism, and that pass THROWS on any non-null
// targeted reason — including the BENIGN no-op skips
// embedding_backfill_skipped:provider_unavailable and
// embedding_backfill_skipped:no_hot_memories (success:true outcomes). A single
// benign/transient skip must not abort a multi-hour run, but silently swallowing
// every throw would let a whole variant run embedding-OFF unnoticed — worse than
// aborting. This helper tolerates the throw per question AND tracks a run-level
// integrity signal so a silently-embedding-off run cannot pass unnoticed.
// see also:
//   apps/core-daemon/src/garden-runtime.ts runEmbeddingBackfillPass (the throw)
//   packages/core/src/embedding-backfill-handler.ts (benign skip reasons)
//   apps/bench-runner/src/harness/daemon.ts drainEmbeddingWarmupPasses

const BENIGN_SKIP_PREFIX = "embedding_backfill_skipped:";

export type EmbeddingReadinessOutcome = "ready" | "benign_skip" | "failed";

export interface EmbeddingReadinessPassResult {
  readonly outcome: EmbeddingReadinessOutcome;
  /** The targeted reason from a tolerated throw, or null when the pass resolved. */
  readonly reason: string | null;
}

export interface RunEmbeddingReadinessPassInput {
  /** The per-question warmup pass, e.g. runtime.runGardenEmbeddingBackfillPass. */
  readonly runPass: () => Promise<void>;
  /** Workspace id, surfaced in the visible warning for a genuine failure. */
  readonly workspaceId: string;
  /** Question id, surfaced in the visible warning for a genuine failure. */
  readonly questionId: string;
  /** Sink for the visible per-question warning; defaults to stderr. */
  readonly warn?: (message: string) => void;
}

export interface RunEmbeddingReadinessPassWithResultInput<T> {
  /** A warmup pass that yields a summary value, e.g. workspace.warmEmbeddingCache. */
  readonly runPass: () => Promise<T>;
  /** Workspace id, surfaced in the visible warning for a genuine failure. */
  readonly workspaceId: string;
  /**
   * Label for the unit being warmed (question id for longmemeval, conversation
   * id for LoCoMo), surfaced in the visible warning for a genuine failure.
   */
  readonly questionId: string;
  /** Sink for the visible per-unit warning; defaults to stderr. */
  readonly warn?: (message: string) => void;
}

export interface EmbeddingReadinessPassResultWithValue<T>
  extends EmbeddingReadinessPassResult {
  /** The pass value when outcome === "ready"; null when degraded (skip/failure). */
  readonly value: T | null;
}

function toReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run one embedding-readiness pass that yields a summary value, tolerating the
 * throw the same way the harness drain does (never aborts the caller loop). A
 * genuine embedding_failed:* / unexpected-error reason is logged as a VISIBLE
 * warning (naming questionId + workspaceId) so a degraded unit is not silent; a
 * benign embedding_backfill_skipped:* reason continues quietly. On any throw the
 * value is null (degrade), otherwise it carries the pass result. The classified
 * outcome is for the run-level integrity tracker.
 */
export async function runEmbeddingReadinessPassWithResult<T>(
  input: RunEmbeddingReadinessPassWithResultInput<T>
): Promise<EmbeddingReadinessPassResultWithValue<T>> {
  try {
    const value = await input.runPass();
    return { outcome: "ready", reason: null, value };
  } catch (error) {
    const reason = toReason(error);
    if (reason.startsWith(BENIGN_SKIP_PREFIX)) {
      return { outcome: "benign_skip", reason, value: null };
    }
    const warn =
      input.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
    warn(
      `[longmemeval embedding-readiness] WARNING genuine embedding pass failure ` +
        `question=${input.questionId} workspace=${input.workspaceId} reason=${reason}`
    );
    return { outcome: "failed", reason, value: null };
  }
}

/**
 * Run one per-question embedding-readiness pass, tolerating the throw the same
 * way the harness drain does (never aborts the question loop). A genuine
 * embedding_failed:* / unexpected-error reason is logged as a VISIBLE warning
 * (with question + workspace id) so a degraded question is not silent; a benign
 * embedding_backfill_skipped:* reason continues quietly. Either way the caller
 * gets back a classified outcome it can fold into the run-level integrity
 * tracker.
 */
export async function runEmbeddingReadinessPass(
  input: RunEmbeddingReadinessPassInput
): Promise<EmbeddingReadinessPassResult> {
  const { value: _value, ...result } = await runEmbeddingReadinessPassWithResult({
    runPass: input.runPass,
    workspaceId: input.workspaceId,
    questionId: input.questionId,
    ...(input.warn === undefined ? {} : { warn: input.warn })
  });
  return result;
}

/**
 * Run-level integrity signal for the no-setup-gate variants. Every question
 * whose readiness pass did not resolve cleanly (benign skip OR genuine failure)
 * is an "unresolved" question. If ANY question ran unresolved, finalize() emits
 * a prominent end-of-run warning naming the count and the genuine-failure
 * subset, so an embedding-ON run that silently degraded to embedding-OFF coverage
 * cannot pass unnoticed.
 */
export class EmbeddingReadinessTracker {
  private totalPasses = 0;
  private benignSkipQuestions = 0;
  private failedQuestions = 0;
  private readonly warn: (message: string) => void;

  constructor(warn?: (message: string) => void) {
    this.warn =
      warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  }

  record(result: EmbeddingReadinessPassResult): void {
    this.totalPasses += 1;
    if (result.outcome === "benign_skip") {
      this.benignSkipQuestions += 1;
    } else if (result.outcome === "failed") {
      this.failedQuestions += 1;
    }
  }

  get unresolvedCount(): number {
    return this.benignSkipQuestions + this.failedQuestions;
  }

  get failedCount(): number {
    return this.failedQuestions;
  }

  get benignSkipCount(): number {
    return this.benignSkipQuestions;
  }

  /** Emit the prominent end-of-run integrity warning when any pass was unresolved. */
  finalize(): void {
    if (this.unresolvedCount === 0) {
      return;
    }
    this.warn(
      `[longmemeval embedding-readiness] INTEGRITY WARNING ` +
        `${this.unresolvedCount}/${this.totalPasses} questions ran with an ` +
        `unresolved embedding-readiness pass ` +
        `(${this.failedQuestions} genuine failure, ` +
        `${this.benignSkipQuestions} benign/transient skip). ` +
        `Recall for those questions may have run embedding-OFF; do not read this ` +
        `run as a clean embedding-ON measurement without checking the per-question ` +
        `warnings above.`
    );
  }
}
