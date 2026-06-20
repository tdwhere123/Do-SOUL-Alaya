import {
  DYNAMICS_CONSTANTS,
  type ConsolidationCyclePlan,
  type ConsolidationTriggerBudget,
  type ConsolidationTriggerSource,
  type MergedLoserRecallBiasSign,
  type PathRelation,
  type PathRelationMergedLoser
} from "@do-soul/alaya-protocol";
import type { EventPublisher } from "../runtime/event-publisher.js";

export const CONSOLIDATION_FUSE_MAX_RETRIES =
  DYNAMICS_CONSTANTS.path_plasticity.consolidation_fuse_max_retries;
export const CONSOLIDATION_FUSE_COOLDOWN_MS =
  DYNAMICS_CONSTANTS.path_plasticity.consolidation_fuse_cooldown_ms;
const CONSOLIDATION_MERGE_WHY_MAX_ENTRIES =
  DYNAMICS_CONSTANTS.path_plasticity.consolidation_merge_why_max_entries;

export interface ConsolidationPathRelationPort {
  findById(pathId: string): Promise<Readonly<PathRelation> | null>;
  update(
    pathId: string,
    updates: Partial<
      Pick<
        PathRelation,
        "constitution" | "plasticity_state" | "lifecycle" | "legitimacy" | "updated_at"
      >
    >
  ): Readonly<PathRelation>;
  delete(pathId: string): void;
}

export interface ConsolidationBudgetStorePort {
  findByTriggerSource(
    triggerSource: ConsolidationTriggerSource
  ): Promise<ConsolidationTriggerBudget | null>;
  upsert(budget: ConsolidationTriggerBudget): Promise<void>;
}

export interface ConsolidationExecutorDependencies {
  readonly pathRelationRepo: ConsolidationPathRelationPort;
  readonly budgetStore: ConsolidationBudgetStorePort;
  readonly eventPublisher: EventPublisher;
  readonly now?: () => string;
}

export interface ConsolidationCycleInput {
  readonly triggerSource: ConsolidationTriggerSource;
  readonly plan: ConsolidationCyclePlan;
}

export interface PreparedMutation {
  readonly pathId: string;
  readonly updates: Partial<
    Pick<
      PathRelation,
      "constitution" | "plasticity_state" | "lifecycle" | "legitimacy" | "updated_at"
    >
  >;
}

export interface PreparedMerge {
  readonly survivorPathId: string;
  readonly survivorUpdates: Partial<
    Pick<PathRelation, "constitution" | "legitimacy" | "updated_at">
  >;
  readonly loserPathIds: readonly string[];
  readonly relationKind: string;
  readonly survivorWhyEntryCount: number;
  readonly mergedLosers: readonly PathRelationMergedLoser[];
}

export function concatMergeWhy(
  survivor: Readonly<PathRelation>,
  losers: readonly Readonly<PathRelation>[]
): readonly string[] {
  return dedupeBounded(
    survivor.constitution.why_this_relation_exists,
    losers.flatMap((loser) => loser.constitution.why_this_relation_exists)
  );
}

export function concatMergeEvidence(
  survivor: Readonly<PathRelation>,
  losers: readonly Readonly<PathRelation>[]
): readonly string[] {
  return dedupeBounded(
    survivor.legitimacy.evidence_basis,
    losers.flatMap((loser) => loser.legitimacy.evidence_basis)
  );
}

export function isDormantAtApply(path: Readonly<PathRelation>): boolean {
  return path.lifecycle.status === "dormant";
}

export function summarizeMergedLoser(
  loser: Readonly<PathRelation>
): PathRelationMergedLoser {
  return Object.freeze({
    path_id: loser.path_id,
    why_this_relation_exists: Object.freeze([
      ...loser.constitution.why_this_relation_exists
    ]),
    evidence_basis: Object.freeze([...loser.legitimacy.evidence_basis]),
    recall_bias_sign: recallBiasSign(loser.effect_vector.recall_bias),
    recall_bias_magnitude: Math.abs(loser.effect_vector.recall_bias),
    direction_bias: loser.plasticity_state.direction_bias
  });
}

export function assertNoPathIdOverlap(plan: ConsolidationCyclePlan): void {
  const seen = new Set<string>();
  const claim = (pathId: string, lane: string): void => {
    if (seen.has(pathId)) {
      throw new Error(
        `Consolidation cycle path relation ${pathId} appears in more than one mutation (overlap at ${lane}).`
      );
    }
    seen.add(pathId);
  };

  for (const promotion of plan.promotions) {
    claim(promotion.path_id, "promotions");
  }
  for (const change of plan.governance_changes) {
    claim(change.path_id, "governance_changes");
  }
  for (const change of plan.direction_changes) {
    claim(change.path_id, "direction_changes");
  }
  for (const retirement of plan.retirements) {
    claim(retirement.path_id, "retirements");
  }
  for (const merge of plan.merges ?? []) {
    claim(merge.survivor_path_id, "merges.survivor");
    for (const loserPathId of merge.merged_path_ids) {
      claim(loserPathId, "merges.loser");
    }
  }
}

function dedupeBounded(
  survivorEntries: readonly string[],
  absorbedEntries: readonly string[]
): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of survivorEntries) {
    if (entry.length === 0 || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    result.push(entry);
  }
  for (const entry of absorbedEntries) {
    if (result.length >= CONSOLIDATION_MERGE_WHY_MAX_ENTRIES) {
      break;
    }
    if (entry.length === 0 || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    result.push(entry);
  }
  return Object.freeze(result);
}

function recallBiasSign(recallBias: number): MergedLoserRecallBiasSign {
  if (recallBias > 0) {
    return "positive";
  }
  if (recallBias < 0) {
    return "negative";
  }
  return "zero";
}
