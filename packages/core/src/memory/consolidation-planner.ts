import {
  DYNAMICS_CONSTANTS,
  serializePathAnchorRef,
  type ConsolidationCyclePlan,
  type PathRelation
} from "@do-soul/alaya-protocol";
import {
  classifyPathImportance,
  isConsolidationDeletable,
  isConsolidationSurvivorEligible
} from "../importance-gate.js";

const CONSOLIDATION_DORMANT_AGE_MS =
  DYNAMICS_CONSTANTS.path_plasticity.consolidation_dormant_age_ms;
const CONSOLIDATION_MERGE_MIN_CLUSTER_SIZE =
  DYNAMICS_CONSTANTS.path_plasticity.consolidation_merge_min_cluster_size;

/**
 * The slice of `PathRelationRepo` the planner reads. Injected so the planner is
 * constructable and unit-testable without the daemon wiring or a live DB.
 * see also: packages/storage/src/repos/path-relation-repo.ts findDormant.
 */
export interface ConsolidationPlannerPathRelationPort {
  findDormant(
    workspaceId: string,
    olderThanIso: string
  ): Promise<readonly Readonly<PathRelation>[]>;
}

export interface ConsolidationPlannerDependencies {
  readonly pathRelationRepo: ConsolidationPlannerPathRelationPort;
  readonly now?: () => string;
}

/**
 * ConsolidationPlanner scans dormant PathRelation rows and emits a populated
 * `ConsolidationCyclePlan` for the ConsolidationExecutor to commit. It is a
 * rule-based, no-LLM planner: it clusters dormant paths by
 * (relation_kind, normalized anchor pair), filters each cluster through the
 * shared importance gate, and emits a MERGE for every cluster that still holds
 * at least `consolidation_merge_min_cluster_size` mergeable members after the
 * gate. The merge keeps the evidence-richest survivor and lists the losers; the
 * executor performs the why-concat and loser deletion transactionally.
 *
 * Truth boundary: consolidation is a SYSTEM Garden decision (Alaya decides).
 * No agent input drives a merge; the planner reads only durable PathRelation
 * state. Override-pinned and strictly-governed paths are never merged or
 * deleted (the importance gate enforces this).
 *
 * see also: packages/core/src/importance-gate.ts (the shared proxy gate spec).
 * see also: packages/core/src/memory/consolidation-executor.ts (consumer of the plan).
 */
export class ConsolidationPlanner {
  private readonly now: () => string;

  public constructor(private readonly dependencies: ConsolidationPlannerDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  /**
   * Builds a plan whose only populated section is `merges`. Promotions,
   * retirements, governance and direction changes are left empty: those are
   * the plasticity service's lane, not consolidation's. The fuse is left
   * un-blown so the executor's budget gate decides whether to commit.
   */
  public async planCycle(workspaceId: string): Promise<ConsolidationCyclePlan> {
    const plannedAt = this.now();
    const olderThanIso = new Date(
      Date.parse(plannedAt) - CONSOLIDATION_DORMANT_AGE_MS
    ).toISOString();

    const dormantPaths = await this.dependencies.pathRelationRepo.findDormant(
      workspaceId,
      olderThanIso
    );

    const merges = buildMerges(dormantPaths);

    return Object.freeze({
      workspace_id: workspaceId,
      planned_at: plannedAt,
      promotions: Object.freeze([]),
      retirements: Object.freeze([]),
      governance_changes: Object.freeze([]),
      direction_changes: Object.freeze([]),
      merges,
      fuse_state: Object.freeze({ blown: false, retry_count: 0 })
    }) as ConsolidationCyclePlan;
  }
}

type MergeEntry = NonNullable<ConsolidationCyclePlan["merges"]>[number];

function buildMerges(
  dormantPaths: readonly Readonly<PathRelation>[]
): readonly MergeEntry[] {
  const clusters = clusterByRelationAndAnchors(dormantPaths);
  const merges: MergeEntry[] = [];

  for (const cluster of clusters.values()) {
    // Drop the untouchable members (protected / report_only) before sizing the
    // cluster: a strictly-governed or override-pinned path is neither a
    // survivor nor a loser. What remains are survivor-eligible (keep /
    // mergeable) members.
    const survivorEligible = cluster.filter((path) => isConsolidationSurvivorEligible(path));
    const deletable = survivorEligible.filter((path) => isConsolidationDeletable(path));

    // A merge needs at least one deletable loser, and the cluster must hold at
    // least the configured minimum number of survivor-eligible members. With
    // only one survivor-eligible member there is nothing to fold in.
    if (
      survivorEligible.length < CONSOLIDATION_MERGE_MIN_CLUSTER_SIZE ||
      deletable.length === 0
    ) {
      continue;
    }

    const survivor = pickEvidenceRichestSurvivor(survivorEligible);
    const losers = deletable.filter((path) => path.path_id !== survivor.path_id);
    if (losers.length === 0) {
      continue;
    }

    merges.push(
      Object.freeze({
        survivor_path_id: survivor.path_id,
        merged_path_ids: Object.freeze(losers.map((path) => path.path_id))
      })
    );
  }

  // Deterministic order so a replay of the same dormant set yields the same
  // plan regardless of Map iteration nuances.
  merges.sort((left, right) => left.survivor_path_id.localeCompare(right.survivor_path_id));
  return Object.freeze(merges);
}

function clusterByRelationAndAnchors(
  paths: readonly Readonly<PathRelation>[]
): ReadonlyMap<string, Readonly<PathRelation>[]> {
  const clusters = new Map<string, Readonly<PathRelation>[]>();
  for (const path of paths) {
    const key = clusterKey(path);
    const bucket = clusters.get(key);
    if (bucket === undefined) {
      clusters.set(key, [path]);
    } else {
      bucket.push(path);
    }
  }
  return clusters;
}

// invariant: paths expressing the same relation_kind between the same anchor
// pair are merge candidates regardless of direction. direction_bias is a
// separate plasticity field, so the anchor pair is normalized order-independent
// (the two serialized anchor keys are sorted) to collapse A->B and B->A of the
// same relation into one cluster.
// invariant: the recall_bias SIGN is part of the key so a positive
// (amplifying) and a negative (suppressing) path of the same relation_kind over
// the same anchors can NEVER co-cluster and therefore never merge into one
// survivor — belt-and-suspenders even if relation_kind already implies a sign,
// so any future sign-ambiguous kind cannot fold opposite-meaning relations.
function clusterKey(path: Readonly<PathRelation>): string {
  const sourceKey = serializePathAnchorRef(path.anchors.source_anchor);
  const targetKey = serializePathAnchorRef(path.anchors.target_anchor);
  const [first, second] = [sourceKey, targetKey].sort();
  return JSON.stringify([
    path.constitution.relation_kind,
    recallBiasSign(path.effect_vector.recall_bias),
    first,
    second
  ]);
}

function recallBiasSign(recallBias: number): "positive" | "negative" | "zero" {
  if (recallBias > 0) {
    return "positive";
  }
  if (recallBias < 0) {
    return "negative";
  }
  return "zero";
}

// The survivor is the evidence-richest member: most distinct evidence sources,
// then most why_this_relation_exists provenance entries, then strongest, then
// the deterministic earliest (created_at, path_id) tiebreak. A "keep"-classified
// path (evidence-rich / well-supported) outranks a bare "mergeable" one on the
// evidence_basis comparison already, so the gate's keep-vs-mergeable split and
// this ranking agree without a special case.
function pickEvidenceRichestSurvivor(
  candidates: readonly Readonly<PathRelation>[]
): Readonly<PathRelation> {
  return [...candidates].sort(compareSurvivorPriority)[0]!;
}

function compareSurvivorPriority(
  left: Readonly<PathRelation>,
  right: Readonly<PathRelation>
): number {
  const evidenceDelta =
    right.legitimacy.evidence_basis.length - left.legitimacy.evidence_basis.length;
  if (evidenceDelta !== 0) {
    return evidenceDelta;
  }

  const whyDelta =
    right.constitution.why_this_relation_exists.length -
    left.constitution.why_this_relation_exists.length;
  if (whyDelta !== 0) {
    return whyDelta;
  }

  const strengthDelta = right.plasticity_state.strength - left.plasticity_state.strength;
  if (strengthDelta !== 0) {
    return strengthDelta;
  }

  if (left.created_at !== right.created_at) {
    return left.created_at.localeCompare(right.created_at);
  }

  return left.path_id.localeCompare(right.path_id);
}
