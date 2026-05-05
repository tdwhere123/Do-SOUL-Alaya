/**
 * PathPlasticityTask: Garden integration for the path-axis plasticity feedback
 * loop (A3). The Librarian dispatches a `path_plasticity_update` task kind onto
 * a Garden tier so plasticity computation never runs on the recall request
 * path. The actual computation lives in `@do-soul/alaya-core`'s
 * `PathPlasticityService`; this file defines the *port* that Librarian depends
 * on so the soul package stays free of any core dependency (Package
 * Dependency Direction invariant).
 */

export const PATH_PLASTICITY_TASK_DEFAULTS = {
  /**
   * Default lookback window when the task descriptor does not embed an
   * explicit `since` timestamp. v0.1 keeps it conservative (24h) — wider
   * windows can be configured by the daemon when wiring the descriptor.
   */
  DEFAULT_LOOKBACK_MS: 24 * 60 * 60 * 1000,
  MAX_EXECUTION_MS: 30_000
} as const;

export interface PathPlasticityComputeResult {
  readonly reinforced: number;
  readonly weakened: number;
  readonly retired: number;
  readonly affectedPathIds: readonly string[];
}

/**
 * The minimal contract the Garden Librarian needs from a path-plasticity
 * compute service. Implemented structurally by
 * `@do-soul/alaya-core`'s `PathPlasticityService`.
 */
export interface PathPlasticityComputePort {
  computeAndApplyPlasticity(params: {
    readonly workspaceId: string;
    readonly sinceIso: string;
    readonly untilIso?: string;
    readonly abortSignal?: AbortSignal;
    /**
     * Called immediately before the compute service enters the EventPublisher
     * mutation boundary. After this point a timeout must not cancel the
     * operation because PathRelation rows may become durable before
     * post-commit propagation returns.
     */
    readonly onMutationBoundaryEntered?: () => void;
  }): Promise<PathPlasticityComputeResult>;
  markProcessed?(params: {
    readonly workspaceId: string;
    readonly processedThroughIso: string;
    readonly processedAuditEventId?: string | null;
  }): Promise<void> | void;
}

export interface PathPlasticityPendingPort {
  clearPendingWorkspace(workspaceId: string): Promise<void> | void;
}

/**
 * Computes the lower watermark for a plasticity task. If the daemon embeds an
 * ISO timestamp in `target_object_refs[0]` the task uses that; otherwise the
 * task falls back to `now - DEFAULT_LOOKBACK_MS`.
 */
export function resolvePathPlasticitySinceIso(
  targetObjectRefs: readonly string[],
  nowIso: string
): string {
  const candidate = targetObjectRefs[0];
  if (candidate !== undefined && Number.isFinite(Date.parse(candidate))) {
    return candidate;
  }
  return new Date(
    Date.parse(nowIso) - PATH_PLASTICITY_TASK_DEFAULTS.DEFAULT_LOOKBACK_MS
  ).toISOString();
}

/**
 * Computes the inclusive upper watermark for a plasticity task. Daemon wiring
 * passes the enqueue-time upper bound in `target_object_refs[1]`; the Librarian
 * marks it processed only after compute succeeds.
 */
export function resolvePathPlasticityUntilIso(
  targetObjectRefs: readonly string[],
  nowIso: string
): string {
  const candidate = targetObjectRefs[1];
  if (candidate !== undefined && Number.isFinite(Date.parse(candidate))) {
    return candidate;
  }
  return nowIso;
}

export async function runPathPlasticityWithinBudget<T>(
  startOperation: (
    abortSignal: AbortSignal,
    onMutationBoundaryEntered: () => void
  ) => Promise<T>,
  budgetMs: number,
  label: string
): Promise<T> {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    return await startOperation(new AbortController().signal, () => undefined);
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new Error(`${label} timed out after ${budgetMs}ms`);
  let mutationBoundaryEntered = false;
  const clearBudgetTimer = (): void => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };
  const onMutationBoundaryEntered = (): void => {
    mutationBoundaryEntered = true;
    clearBudgetTimer();
  };

  try {
    const operation = startOperation(controller.signal, onMutationBoundaryEntered);
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        if (mutationBoundaryEntered) {
          return;
        }
        controller.abort(timeoutError);
        reject(timeoutError);
      }, budgetMs);
    });
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    clearBudgetTimer();
  }
}
