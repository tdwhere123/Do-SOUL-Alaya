import type { MemoryEntry, RecallPolicy, StorageTier } from "@do-soul/alaya-protocol";
import {
  compareMemoryEntriesForActivationAdmission,
  matchesDeterministicFilter,
  matchesPrecomputedRankFilter
} from "../../runtime/recall-service-helpers.js";
import type { RecallServiceMemoryRepoPort } from "../../runtime/recall-service-types.js";
import { selectBoundedTopK } from "./bounded-top-k.js";

export function selectActivationAdmissionTopKFromWindow(
  eligible: readonly Readonly<MemoryEntry>[],
  limit: number
): readonly Readonly<MemoryEntry>[] {
  return selectBoundedTopK(eligible, limit, compareMemoryEntriesForActivationAdmission);
}

export async function loadActivationAdmissionTopK(params: Readonly<{
  readonly memoryRepo: RecallServiceMemoryRepoPort;
  readonly workspaceId: string;
  readonly tier: StorageTier;
  readonly config: Readonly<RecallPolicy>["coarse_filter"];
  readonly eligible: readonly Readonly<MemoryEntry>[];
  readonly excludeObjectIds: ReadonlySet<string>;
  readonly allowSql: boolean;
  readonly fallbackOnSqlFailure?: boolean;
}>): Promise<readonly Readonly<MemoryEntry>[]> {
  const limit = params.config.precomputed_rank.max_candidates;
  const eligible = params.eligible.filter((entry) =>
    matchesPrecomputedRankFilter(entry, params.config)
  );
  if (!params.allowSql || limit <= 0) {
    return selectActivationAdmissionTopKFromWindow(eligible, limit);
  }
  const loadSql = params.memoryRepo.findRecallActivationTopK;
  if (loadSql === undefined) {
    return selectActivationAdmissionTopKFromWindow(eligible, limit);
  }
  try {
    const rows = await loadSql.call(params.memoryRepo, {
      workspaceId: params.workspaceId,
      tier: params.tier,
      limit,
      min_activation_score: params.config.precomputed_rank.min_activation_score,
      exclude_object_ids: [...params.excludeObjectIds]
    });
    return selectActivationAdmissionTopKFromWindow(
      rows.filter((entry) =>
        !params.excludeObjectIds.has(entry.object_id) &&
        matchesDeterministicFilter(entry, params.config) &&
        matchesPrecomputedRankFilter(entry, params.config)
      ),
      limit
    );
  } catch (error) {
    // Empty eligible is not a HOT window; swallowing would drop the activation plane.
    if (params.fallbackOnSqlFailure === false) throw error;
    return selectActivationAdmissionTopKFromWindow(eligible, limit);
  }
}

export function canUseSqlActivationAdmissionTopK(
  config: Readonly<RecallPolicy>["coarse_filter"],
  timeFilter: unknown
): boolean {
  return timeFilter === undefined &&
    config.deterministic_match.scope_filter === null &&
    config.deterministic_match.dimension_filter === null &&
    config.deterministic_match.domain_tag_filter === null;
}
