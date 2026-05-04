/**
 * PathPlasticityTask: Garden integration for the path-axis plasticity feedback
 * loop (A3). The Auditor dispatches a `path_plasticity_update` task kind onto
 * a Garden tier so plasticity computation never runs on the recall request
 * path. The actual computation lives in `@do-soul/alaya-core`'s
 * `PathPlasticityService`; this file defines the *port* that Auditor depends
 * on so the soul package stays free of any core dependency (Package
 * Dependency Direction invariant).
 */

export const PATH_PLASTICITY_TASK_DEFAULTS = {
  /**
   * Default lookback window when the task descriptor does not embed an
   * explicit `since` timestamp. v0.1 keeps it conservative (24h) — wider
   * windows can be configured by the daemon when wiring the descriptor.
   */
  DEFAULT_LOOKBACK_MS: 24 * 60 * 60 * 1000
} as const;

export interface PathPlasticityComputeResult {
  readonly reinforced: number;
  readonly weakened: number;
  readonly retired: number;
  readonly affectedPathIds: readonly string[];
}

/**
 * The minimal contract the Garden Auditor needs from a path-plasticity
 * compute service. Implemented structurally by
 * `@do-soul/alaya-core`'s `PathPlasticityService`.
 */
export interface PathPlasticityComputePort {
  computeAndApplyPlasticity(params: {
    readonly workspaceId: string;
    readonly sinceIso: string;
  }): Promise<PathPlasticityComputeResult>;
}

/**
 * Computes the `since` watermark for a plasticity task. If the daemon embeds
 * an ISO timestamp in `target_object_refs[0]` the task uses that; otherwise
 * the task falls back to `now - DEFAULT_LOOKBACK_MS`.
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
