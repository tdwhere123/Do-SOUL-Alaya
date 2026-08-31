import { compareText } from "../../../shared/compare-text.js";
import { freezeShadow, ShadowContractError } from "../contract-primitives.js";

type WalkConstraintCandidate = Readonly<{
  readonly candidate_key: string;
  readonly object_key: string;
  readonly token_cost: number;
  readonly dimension: string;
  readonly utility: Readonly<{
    readonly candidate_key: string;
    readonly object_key: string;
  }>;
  readonly static_frontier_index: number | null;
}>;

type WalkReject = "duplicate_object" | "dimension_limit" | "max_total_tokens";

export type WalkConstraintState<T extends WalkConstraintCandidate = WalkConstraintCandidate> = {
  remaining: Map<string, T>;
  object_keys: Set<string>;
  used_tokens: number;
  token_budget: number;
  per_dimension_limits: Readonly<Record<string, number>> | null;
  dim_count: Map<string, number>;
  walk_rejects: Array<{ readonly candidate_key: string; readonly walk_reject: WalkReject }>;
};

export function validateWalkCandidate(candidate: WalkConstraintCandidate): void {
  if (candidate.candidate_key !== candidate.utility.candidate_key ||
      candidate.object_key !== candidate.utility.object_key) {
    throw new ShadowContractError("walk candidate identity must match set-utility");
  }
  if (!Number.isFinite(candidate.token_cost) || candidate.token_cost <= 0) {
    throw new ShadowContractError("token_cost must be finite and positive");
  }
  if (candidate.dimension.length === 0) {
    throw new ShadowContractError("dimension is required");
  }
  const index = candidate.static_frontier_index;
  if (index !== null && (!Number.isInteger(index) || index < 1)) {
    throw new ShadowContractError("static_frontier_index is structure only");
  }
}

export function applyInfeasibleDrops<T extends WalkConstraintCandidate>(
  state: WalkConstraintState<T>
): void {
  const keys = [...state.remaining.keys()].sort(compareText);
  for (const key of keys) {
    const candidate = state.remaining.get(key);
    if (candidate === undefined) continue;
    const reason = infeasibleReason(candidate, state);
    if (reason === null) continue;
    state.remaining.delete(key);
    state.walk_rejects.push(freezeShadow({
      candidate_key: key,
      walk_reject: reason
    }));
  }
}

function infeasibleReason<T extends WalkConstraintCandidate>(
  candidate: T,
  state: WalkConstraintState<T>
): WalkReject | null {
  if (state.object_keys.has(candidate.object_key)) return "duplicate_object";
  if (state.used_tokens + candidate.token_cost > state.token_budget) {
    return "max_total_tokens";
  }
  if (dimensionExhausted(candidate, state)) return "dimension_limit";
  return null;
}

function dimensionExhausted<T extends WalkConstraintCandidate>(
  candidate: T,
  state: WalkConstraintState<T>
): boolean {
  if (state.per_dimension_limits === null) return false;
  const limit = state.per_dimension_limits[candidate.dimension];
  if (limit === undefined) return false;
  return (state.dim_count.get(candidate.dimension) ?? 0) >= limit;
}
