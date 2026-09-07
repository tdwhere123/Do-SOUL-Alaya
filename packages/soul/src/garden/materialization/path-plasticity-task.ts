/**
 * PathPlasticityTask: Garden integration for residual path-axis usage
 * watermarks. The Librarian may dispatch `path_plasticity_update`; upgraded
 * compute must not write PathRelation.strength. The historical
 * `PathPlasticityService` mutation owner is not selected on this target.
 */

export const PATH_PLASTICITY_TASK_DEFAULTS = {
  /**
   * Default lookback window when the task descriptor does not embed an
   * explicit `since` timestamp. Conservative (24h) — wider windows can be
   * configured by the daemon when wiring the descriptor.
   */
  DEFAULT_LOOKBACK_MS: 24 * 60 * 60 * 1000,
  MAX_EXECUTION_MS: 30_000
} as const;

export const PATH_PLASTICITY_NO_MUTATION_RESULT = Object.freeze({
  reinforced: 0,
  weakened: 0,
  retired: 0,
  affectedPathIds: Object.freeze([]) as readonly string[]
});

export interface PathPlasticityComputeResult {
  readonly reinforced: number;
  readonly weakened: number;
  readonly retired: number;
  readonly affectedPathIds: readonly string[];
}

/**
 * Residual Librarian contract. Supported implementations attribute usage and
 * may advance watermarks; they must not persist PathRelation plasticity.
 */
export interface PathPlasticityComputePort {
  computeAndApplyPlasticity(params: {
    readonly workspaceId: string;
    readonly sinceIso: string;
    readonly untilIso?: string;
    readonly abortSignal?: AbortSignal;
    /**
     * Residual hook from the retired write path. Attribution-only compute
     * never calls it, because no PathRelation row is mutated.
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

export function createAttributionOnlyPathPlasticityPort(options?: {
  readonly markProcessed?: PathPlasticityComputePort["markProcessed"];
}): PathPlasticityComputePort {
  return {
    async computeAndApplyPlasticity() {
      return PATH_PLASTICITY_NO_MUTATION_RESULT;
    },
    ...(options?.markProcessed === undefined ? {} : { markProcessed: options.markProcessed })
  };
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
    // Abandoned work that rejects after timeout must not become an unhandledRejection.
    operation.catch(() => undefined);
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
