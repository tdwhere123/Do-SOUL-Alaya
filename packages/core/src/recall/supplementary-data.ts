import {
  isPathRecallEligible,
  type ManifestationState,
  type MemoryEntry,
  type PathAnchorRef,
  type PathRelation,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import type { RecallQueryProbes } from "../recall-query-probes.js";
import {
  clamp01,
  mapBudgetPenalty,
  normalizeGraphSupport,
  toErrorMessage
} from "../recall-service-helpers.js";
import type {
  RecallServiceDependencies,
  RecallServiceWarnPort,
  RecallSupplementaryData
} from "../recall-service-types.js";
import {
  GOVERNANCE_CEILING_FAILSAFE_BAND,
  memoryGovernanceCeiling,
  type PathGovernanceContribution
} from "../path-graph/path-manifestation-policy.js";
import { computeMaxWeightTransferAmount } from "./scoring.js";
import { anchorMemoryId, uniqueStrings } from "./path-relations.js";

const RECALLS_EDGE_COLD_THRESHOLD = 50;

export async function collectSupplementaryData(params: {
  readonly dependencies: Pick<
    RecallServiceDependencies,
    | "budgetPenaltyPort"
    | "evidenceSearchPort"
    | "graphSupportPort"
    | "pathExpansionPort"
    | "pathPlasticityPort"
  >;
  readonly warn: RecallServiceWarnPort;
  readonly candidates: readonly Readonly<MemoryEntry>[];
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly queryText: string | null;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly policy: Readonly<RecallPolicy>;
  readonly coarseFtsRanks: Readonly<Record<string, number>>;
  readonly coarseTrigramFtsRanks: Readonly<Record<string, number>>;
  readonly coarseSynthesisFtsRanks: Readonly<Record<string, number>>;
  readonly coarseEvidenceFtsRanks: Readonly<Record<string, number>>;
  readonly coarseEvidenceFtsRanksPerRef: Readonly<Record<string, number>>;
  readonly coarseSourceProximityScores: Readonly<Record<string, number>>;
  readonly coarseSourceCohortKeys: Readonly<Record<string, string>>;
  readonly coarseStructuralScores: Readonly<Record<string, number>>;
  readonly coarseGraphExpansionScores: Readonly<Record<string, number>>;
  readonly coarseEntitySeedScores: Readonly<Record<string, number>>;
  readonly coarsePathExpansionScores: Readonly<Record<string, number>>;
  readonly coarsePathSuppressionScores: Readonly<Record<string, number>>;
}): Promise<RecallSupplementaryData> {
  const candidates = params.candidates;

  // graph_support is a weighted inbound aggregate across edge types; the
  // storage repo owns the concrete edge_type weight map.
  const graphSupportCounts: Record<string, number> = Object.fromEntries(
    await Promise.all(
      candidates.map(async (candidate): Promise<readonly [string, number]> => {
        const count =
          params.dependencies.graphSupportPort === undefined
            ? 0
            : await params.dependencies.graphSupportPort.countInboundEdgesWeighted(
                candidate.object_id,
                params.workspaceId
              );
        return [
          candidate.object_id,
          count
        ];
      })
    )
  );
  const recallEdgeCounts: Record<string, number> = Object.fromEntries(
    await Promise.all(
      candidates.map(async (candidate): Promise<readonly [string, number]> => {
        const count =
          params.dependencies.graphSupportPort?.countInboundRecalls === undefined
            ? 0
            : await params.dependencies.graphSupportPort.countInboundRecalls(
                candidate.object_id,
                params.workspaceId
              );
        return [
          candidate.object_id,
          count
        ];
      })
    )
  );

  let budgetPenaltyFactor = 0;
  if (params.runId !== null && params.dependencies.budgetPenaltyPort !== undefined) {
    const snapshot = await params.dependencies.budgetPenaltyPort.getSnapshot(params.runId);
    budgetPenaltyFactor = mapBudgetPenalty(snapshot);
  }

  let plasticityFactors: Readonly<Record<string, number>> = Object.freeze({});
  if (params.dependencies.pathPlasticityPort !== undefined && candidates.length > 0) {
    try {
      const strengthMap = await params.dependencies.pathPlasticityPort.getStrengthByMemoryId(
        params.workspaceId,
        candidates.map((candidate) => candidate.object_id)
      );
      plasticityFactors = Object.freeze(
        Object.fromEntries(
          [...strengthMap.entries()].map(([memoryId, strength]) => [memoryId, clamp01(strength)])
        )
      );
    } catch (error) {
      // Plasticity is a recall supplement; a port failure must not block
      // the recall request. Fall back to no plasticity boost.
      params.warn("path plasticity port lookup failed", {
        workspace_id: params.workspaceId,
        candidate_count: candidates.length,
        error: toErrorMessage(error)
      });
    }
  }

  const graphAndPathCold =
    candidates.length > 0 &&
    candidates.every(
      (candidate) =>
        normalizeGraphSupport(graphSupportCounts[candidate.object_id] ?? 0) === 0 &&
        clamp01(plasticityFactors[candidate.object_id] ?? 0) === 0
    );
  const recallsEdgeCount = Object.values(recallEdgeCounts).reduce((sum, count) => sum + count, 0);
  const recallsColdScore =
    params.dependencies.graphSupportPort?.countInboundRecalls === undefined
      ? (graphAndPathCold ? 1 : 0)
      : clamp01(1 - recallsEdgeCount / RECALLS_EDGE_COLD_THRESHOLD);
  const graphAndPathColdScore = graphAndPathCold ? recallsColdScore : 0;
  const weightTransferAmount = computeMaxWeightTransferAmount({
    candidates,
    policy: params.policy,
    graphAndPathColdScore,
    warn: params.warn
  });

  // Evidence gist piggy-back: for the small subset of candidates whose
  // entry into the pool came through an evidence FTS hit, fetch the
  // associated evidence capsules so the feature rerank can score against
  // the gist paraphrase. A missing findByIds port (or fetch failure) is
  // fail-soft → empty map → rerank falls back to content-only.
  const evidenceGistsByMemoryId = await collectEvidenceGistsByMemoryId({
    dependencies: params.dependencies,
    warn: params.warn,
    workspaceId: params.workspaceId,
    candidates,
    coarseEvidenceFtsRanks: params.coarseEvidenceFtsRanks,
    coarseEvidenceFtsRanksPerRef: params.coarseEvidenceFtsRanksPerRef
  });

  const governanceCeilingByMemoryId = await collectGovernanceCeilings({
    dependencies: params.dependencies,
    warn: params.warn,
    workspaceId: params.workspaceId,
    candidates
  });

  return Object.freeze({
    queryProbes: params.queryProbes,
    ftsRanks: params.coarseFtsRanks,
    trigramFtsRanks: params.coarseTrigramFtsRanks,
    synthesisFtsRanks: params.coarseSynthesisFtsRanks,
    evidenceFtsRanks: params.coarseEvidenceFtsRanks,
    sourceProximityScores: params.coarseSourceProximityScores,
    sourceCohortKeys: params.coarseSourceCohortKeys,
    structuralScores: params.coarseStructuralScores,
    graphExpansionScores: params.coarseGraphExpansionScores,
    entitySeedScores: params.coarseEntitySeedScores,
    pathExpansionScores: params.coarsePathExpansionScores,
    pathSuppressionScores: params.coarsePathSuppressionScores,
    embeddingSimilarityScores: Object.freeze({}),
    graphSupportCounts: Object.freeze(graphSupportCounts),
    budgetPenaltyFactor,
    plasticityFactors,
    graphAndPathColdScore,
    recallsEdgeCount,
    weightTransferAmount,
    evidenceGistsByMemoryId,
    governanceCeilingByMemoryId
  });
}

async function collectEvidenceGistsByMemoryId(params: {
  readonly dependencies: Pick<RecallServiceDependencies, "evidenceSearchPort">;
  readonly warn: RecallServiceWarnPort;
  readonly workspaceId: string;
  readonly candidates: readonly Readonly<MemoryEntry>[];
  readonly coarseEvidenceFtsRanks: Readonly<Record<string, number>>;
  readonly coarseEvidenceFtsRanksPerRef: Readonly<Record<string, number>>;
}): Promise<Readonly<Record<string, string>>> {
  const candidates = params.candidates;
  const coarseEvidenceFtsRanksPerRef = params.coarseEvidenceFtsRanksPerRef;
  const evidenceSearchPort = params.dependencies.evidenceSearchPort;
  if (evidenceSearchPort?.findByIds === undefined) {
    return Object.freeze({});
  }
  // Restrict to candidates that already landed in the pool through an
  // evidence FTS hit — their gists are the ones whose paraphrase carries
  // recall-relevant semantics. Avoids an unbounded findByIds over every
  // memory's full evidence_refs set.
  const relevantCandidates = candidates.filter(
    (entry) =>
      entry.evidence_refs.length > 0 &&
      (params.coarseEvidenceFtsRanks[entry.object_id] ?? 0) > 0
  );
  if (relevantCandidates.length === 0) {
    return Object.freeze({});
  }
  // invariant: findByIds payload bounded by evidence-FTS hit set, not the
  // candidate's full evidence_refs cardinality. see also: P2-R2-E.
  //
  // invariant: per-memory evidence_refs cardinality is capped at
  // MAX_REFS_PER_MEMORY before the findByIds payload is built. A typical
  // memory carries 1-3 evidence_refs; an outlier with thousands of refs
  // (whether legitimate aggregation or adversarial) would dominate the
  // tokenizer / new Set fan-out inside the rerank loop. Cap reflects the
  // semantic assumption "one memory should not need more than this many
  // evidence anchors to recall well" — refs beyond the cap are sorted by
  // per-ref evidence-FTS rank and only the top MAX_REFS_PER_MEMORY are
  // forwarded; the best-rank ref (used by the gist picker below) is
  // always preserved.
  const MAX_REFS_PER_MEMORY = 8;
  const evidenceIds = uniqueStrings(
    relevantCandidates.flatMap((entry) => {
      const hitRefs = entry.evidence_refs.filter(
        (ref) => (coarseEvidenceFtsRanksPerRef[ref] ?? 0) > 0
      );
      if (hitRefs.length <= MAX_REFS_PER_MEMORY) {
        return hitRefs;
      }
      return [...hitRefs]
        .sort(
          (left, right) =>
            (coarseEvidenceFtsRanksPerRef[right] ?? 0) -
            (coarseEvidenceFtsRanksPerRef[left] ?? 0)
        )
        .slice(0, MAX_REFS_PER_MEMORY);
    })
  );
  if (evidenceIds.length === 0) {
    return Object.freeze({});
  }
  try {
    const evidenceCapsules = await evidenceSearchPort.findByIds(params.workspaceId, evidenceIds);
    const gistById = new Map<string, string>();
    for (const evidence of evidenceCapsules) {
      if (evidence.workspace_id !== params.workspaceId) {
        continue;
      }
      const gist = evidence.gist?.trim() ?? "";
      if (gist.length > 0) {
        gistById.set(evidence.object_id, gist);
      }
    }
    const gistsByMemory: Record<string, string> = {};
    for (const entry of relevantCandidates) {
      // invariant: pick gist from the highest-ranked ref in evidence_refs
      // (per coarseEvidenceFtsRanksPerRef); stable by evidence_refs order
      // on ties. see also: P2-R2-B in collectEvidenceGistsByMemoryId callers.
      const refsWithRank = entry.evidence_refs.map((ref) => Object.freeze({
        ref,
        rank: coarseEvidenceFtsRanksPerRef[ref] ?? 0
      }));
      const orderedRefs = [...refsWithRank].sort((left, right) => right.rank - left.rank);
      for (const { ref } of orderedRefs) {
        const gist = gistById.get(ref);
        if (gist !== undefined && gist.length > 0) {
          gistsByMemory[entry.object_id] = gist;
          break;
        }
      }
      // fallback: aggregated rank > 0 but no per-ref rank populated; mirrors
      // legacy first-non-empty-gist rule so future producers that only
      // populate the aggregate stay correct.
      // unreachable under current producer (coarseEvidenceFtsRanksPerRef
      // always populates every ref in evidence_refs); kept for forward-compat
      // with future producers that only emit the aggregate rank.
      if (gistsByMemory[entry.object_id] === undefined) {
        for (const ref of entry.evidence_refs) {
          const gist = gistById.get(ref);
          if (gist !== undefined && gist.length > 0) {
            gistsByMemory[entry.object_id] = gist;
            break;
          }
        }
      }
    }
    return Object.freeze(gistsByMemory);
  } catch (error) {
    params.warn("evidence gist lookup for rerank failed", {
      workspace_id: params.workspaceId,
      error: toErrorMessage(error)
    });
    return Object.freeze({});
  }
}

// invariant: governance_class is a HARD CEILING on recall manifestation.
// Absent path expansion is fail-open; path read failure is fail-closed to the
// safe hint band for every candidate.
async function collectGovernanceCeilings(params: {
  readonly dependencies: Pick<RecallServiceDependencies, "pathExpansionPort">;
  readonly warn: RecallServiceWarnPort;
  readonly workspaceId: string;
  readonly candidates: readonly Readonly<MemoryEntry>[];
}): Promise<Readonly<Record<string, ManifestationState>>> {
  const candidates = params.candidates;
  const pathExpansionPort = params.dependencies.pathExpansionPort;
  if (pathExpansionPort === undefined || candidates.length === 0) {
    return Object.freeze({});
  }
  const candidateIds = new Set(candidates.map((candidate) => candidate.object_id));
  const anchors: PathAnchorRef[] = [...candidateIds].map((object_id) => ({
    kind: "object",
    object_id
  }));
  let paths: readonly Readonly<PathRelation>[];
  try {
    paths = await pathExpansionPort.findByAnchors(params.workspaceId, anchors);
  } catch (error) {
    params.warn("governance ceiling path lookup failed", {
      workspace_id: params.workspaceId,
      candidate_count: candidates.length,
      error: toErrorMessage(error)
    });
    // fail-CLOSED: cap every candidate to the safe band so a transient read
    // error cannot lift a governed memory to its full strength tier.
    const failsafeCeilings: Record<string, ManifestationState> = {};
    for (const object_id of candidateIds) {
      failsafeCeilings[object_id] = GOVERNANCE_CEILING_FAILSAFE_BAND;
    }
    return Object.freeze(failsafeCeilings);
  }
  const contributionsByMemoryId = new Map<string, PathGovernanceContribution[]>();
  for (const path of paths) {
    if (!isPathRecallEligible(path)) {
      continue;
    }
    // invariant: the ceiling is INBOUND — keyed on the path's target memory.
    // findByAnchors also returns paths where the candidate is the SOURCE
    // anchor; those govern the path's target, not the source, so they must
    // not raise/lower the source memory's ceiling.
    const targetMemoryId = anchorMemoryId(path.anchors.target_anchor);
    if (targetMemoryId === undefined || !candidateIds.has(targetMemoryId)) {
      continue;
    }
    const contribution: PathGovernanceContribution = {
      governance_class: path.legitimacy.governance_class,
      evidence_basis: path.legitimacy.evidence_basis
    };
    const contributions = contributionsByMemoryId.get(targetMemoryId);
    if (contributions === undefined) {
      contributionsByMemoryId.set(targetMemoryId, [contribution]);
    } else {
      contributions.push(contribution);
    }
  }
  const ceilingByMemoryId: Record<string, ManifestationState> = {};
  for (const [memoryId, contributions] of contributionsByMemoryId) {
    ceilingByMemoryId[memoryId] = memoryGovernanceCeiling(contributions);
  }
  return Object.freeze(ceilingByMemoryId);
}
