/**
 * PathPlasticityTask: Garden integration for residual path-axis usage
 * watermarks. The Librarian may dispatch `path_plasticity_update`; upgraded
 * compute must not write PathRelation.strength. The historical
 * `PathPlasticityService` mutation owner is not selected on this target.
 */

export const PATH_PLASTICITY_TASK_DEFAULTS = {
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
    readonly sinceRevision: number;
    readonly untilRevision: number;
    readonly abortSignal?: AbortSignal;
    /**
     * Residual hook from the retired write path. Attribution-only compute
     * never calls it, because no PathRelation row is mutated.
     */
    readonly onMutationBoundaryEntered?: () => void;
  }): Promise<PathPlasticityComputeResult>;
  markProcessed?(params: {
    readonly workspaceId: string;
    readonly processedThroughRevision: number;
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

const REVISION_CURSOR = /^\d+$/u;

export function parsePathPlasticityRevisionCursor(
  value: string | undefined
): number | undefined {
  if (value === undefined || !REVISION_CURSOR.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Lower exclusive EventLog revision cursor. Integer refs only — wall-clock
 * ISO strings are not a monotonic watermark and must not be substituted.
 */
export function resolvePathPlasticitySinceRevision(
  targetObjectRefs: readonly string[],
  fallbackRevision = 0
): number {
  return parsePathPlasticityRevisionCursor(targetObjectRefs[0]) ?? fallbackRevision;
}

/**
 * Inclusive upper EventLog revision cursor captured before compute starts.
 * Missing integer refs do not fall back to "now".
 */
export function resolvePathPlasticityUntilRevision(
  targetObjectRefs: readonly string[],
  fallbackRevision: number
): number {
  return parsePathPlasticityRevisionCursor(targetObjectRefs[1]) ?? fallbackRevision;
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
