import { buildCandidateSelectorObservation } from
  "../diagnostics/candidate-selector-observation.js";
import {
  buildRecallCandidateDedupeKey,
  buildRecallLogicalObjectKey
} from "../../runtime/recall-service-helpers.js";
import type {
  FineAssessmentCandidate,
  FineAssessmentSelectionContext
} from "../fine-assessment-selection.js";
import {
  RECALL_FUSION_FAMILY_IDS,
  RECALL_FUSION_FAMILY_STREAMS
} from "../fusion-delivery-families.js";
import {
  refineIncumbentNestedSet,
  selectLexicographicNestedSet,
  type IncumbentNestedSetInput,
  type NestedSetCandidate,
  type NestedSetSelectionResult
} from "./lexicographic-set-selector.js";

export interface FineAssessmentNestedSelection {
  readonly status: "selected" | "no_semantic_observation";
  readonly orderedCandidates: readonly FineAssessmentCandidate[];
  readonly plan: Readonly<NestedSetSelectionResult> | null;
}

const DEMAND_ACTIVATION_SCENARIOS = Object.freeze([
  "semantic",
  "lexical",
  "structural",
  "graph_path",
  "temporal_facet",
  "evidence_semantic"
]);

export function selectNestedFineAssessmentCandidates(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext
): Readonly<FineAssessmentNestedSelection> {
  const projected = projectFineAssessmentNestedField(candidates, context);
  if (!projected.some((candidate) => finiteRank(candidate.scenarioRanks.semantic))) {
    return Object.freeze({
      status: "no_semantic_observation",
      orderedCandidates: candidates,
      plan: null
    });
  }
  const packSize = Math.min(context.config.budgets.max_entries, candidates.length);
  const plan = selectLexicographicNestedSet(projected, {
    headSize: Math.min(5, packSize),
    packSize
  });
  return Object.freeze({
    status: "selected",
    orderedCandidates: reorderCandidates(candidates, plan.packKeys),
    plan
  });
}

export function refineNestedFineAssessmentCandidates(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext,
  incumbent: Readonly<IncumbentNestedSetInput>
): Readonly<FineAssessmentNestedSelection> {
  const projected = projectFineAssessmentNestedField(candidates, context);
  if (!projected.some((candidate) => finiteRank(candidate.scenarioRanks.semantic))) {
    return Object.freeze({
      status: "no_semantic_observation",
      orderedCandidates: candidates,
      plan: null
    });
  }
  const packSize = Math.min(context.config.budgets.max_entries, incumbent.packKeys.length);
  const plan = refineIncumbentNestedSet(projected, incumbent, {
    headSize: Math.min(5, packSize),
    packSize
  });
  return Object.freeze({
    status: "selected",
    orderedCandidates: reorderCandidates(candidates, plan.packKeys),
    plan
  });
}

export function projectFineAssessmentNestedField(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext
): readonly NestedSetCandidate[] {
  const evidenceRankByKey = rankEvidenceSemanticScores(candidates, context);
  const projected = candidates.map((candidate, index) =>
    projectFineAssessmentNestedCandidate(candidate, index + 1, context, {
      evidence_semantic: evidenceRankByKey.get(
        buildRecallCandidateDedupeKey(candidate)
      ) ?? null
    })
  );
  return gateDemandCoverage(
    calibrateScenarioRankTies(projected),
    context.config.budgets.max_entries
  );
}

export function projectFineAssessmentNestedCandidate(
  candidate: FineAssessmentCandidate,
  deliveryRank: number,
  context: FineAssessmentSelectionContext,
  additionalScenarioRanks: Readonly<Record<string, number | null>> = {}
): NestedSetCandidate {
  const observation = buildCandidateSelectorObservation(candidate, context);
  const demandMatches = observation.demand.matches;
  const activation = context.supplementaryData.keyActivationByOwnerIdentity?.get(
    buildRecallLogicalObjectKey(candidate)
  );
  return Object.freeze({
    key: buildRecallCandidateDedupeKey(candidate),
    scenarioRanks: Object.freeze({
      delivery: deliveryRank,
      fusion: candidate.fusion.fused_rank,
      ...familyScenarioRanks(candidate),
      ...additionalScenarioRanks
    }),
    coreDemandIds: Object.freeze(demandEvidenceIsValid(observation) ? demandMatches
      .filter(({ priority }) => priority === "core")
      .map(({ id }) => id) : []),
    supportingDemandIds: Object.freeze(demandMatches
      .filter(({ priority }) => priority === "supporting")
      .map(({ id }) => id)),
    evidenceGroup: evidenceGroup(candidate, context),
    proposalSupport: activation?.proposal_activation ?? 0,
    risk: selectorRisk(observation),
    tokenCost: candidate.entry.content.length
  });
}

function rankEvidenceSemanticScores(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext
): ReadonlyMap<string, number> {
  const scores = context.supplementaryData.evidenceSemanticScoresByCandidateKey;
  const ordered = candidates.flatMap((candidate) => {
    const key = buildRecallCandidateDedupeKey(candidate);
    const score = scores.get(key);
    return score !== undefined && Number.isFinite(score) && score > 0
      ? [{ key, score }]
      : [];
  }).sort((left, right) => right.score - left.score || left.key.localeCompare(right.key));
  const ranks = new Map<string, number>();
  let previousScore: number | undefined;
  let rank = 0;
  for (const [index, candidate] of ordered.entries()) {
    if (previousScore === undefined || candidate.score !== previousScore) rank = index + 1;
    ranks.set(candidate.key, rank);
    previousScore = candidate.score;
  }
  return ranks;
}

function familyScenarioRanks(
  candidate: FineAssessmentCandidate
): Readonly<Record<string, number | null>> {
  return Object.freeze(Object.fromEntries(RECALL_FUSION_FAMILY_IDS.map((family) => [
    family,
    bestFiniteRank(RECALL_FUSION_FAMILY_STREAMS[family].map(
      (stream) => candidate.fusion.per_stream_rank[stream]
    ))
  ])));
}

function evidenceGroup(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): string | null {
  const document = candidate.evidenceDocumentIdentity?.trim();
  if (document !== undefined && document.length > 0) {
    return `${candidate.evidenceSourceRole ?? "unknown"}:${document}`;
  }
  const cohort = context.supplementaryData.sourceCohortKeys[candidate.entry.object_id];
  if (cohort !== undefined) return `cohort:${cohort}`;
  const evidenceRef = candidate.entry.evidence_refs[0];
  return evidenceRef === undefined ? null : `evidence:${evidenceRef}`;
}

function selectorRisk(
  observation: ReturnType<typeof buildCandidateSelectorObservation>
): number {
  let risk = 0;
  if (observation.evidence.event_status === "negated" ||
      observation.evidence.event_status === "reversed") risk += 1;
  if (observation.temporal.compatibility === "conflicted") risk += 1;
  if (observation.evidence.validity === "unresolved") risk += 1;
  return risk;
}

function reorderCandidates(
  candidates: readonly FineAssessmentCandidate[],
  packKeys: readonly string[]
): readonly FineAssessmentCandidate[] {
  const byKey = new Map(candidates.map((candidate) => [
    buildRecallCandidateDedupeKey(candidate), candidate
  ]));
  const selected = packKeys.flatMap((key) => {
    const candidate = byKey.get(key);
    return candidate === undefined ? [] : [candidate];
  });
  const selectedKeys = new Set(packKeys);
  return Object.freeze([
    ...selected,
    ...candidates.filter((candidate) =>
      !selectedKeys.has(buildRecallCandidateDedupeKey(candidate)))
  ]);
}

function bestFiniteRank(values: readonly (number | null)[]): number | null {
  const observed = values.filter(finiteRank);
  return observed.length === 0 ? null : Math.min(...observed);
}

function calibrateScenarioRankTies(
  candidates: readonly NestedSetCandidate[]
): readonly NestedSetCandidate[] {
  return Object.freeze(candidates.map((candidate) => Object.freeze({
    ...candidate,
    scenarioRanks: Object.freeze(Object.fromEntries(
      Object.entries(candidate.scenarioRanks).map(([scenario, rank]) => [
        scenario,
        finiteRank(rank) ? conservativeScenarioRank(candidates, scenario, rank) : null
      ])
    ))
  })));
}

function conservativeScenarioRank(
  candidates: readonly NestedSetCandidate[],
  scenario: string,
  rank: number
): number {
  const observedBeforeOrTied = candidates.filter((candidate) => {
    const candidateRank = candidate.scenarioRanks[scenario];
    return finiteRank(candidateRank) && candidateRank <= rank;
  }).length;
  return Math.max(rank, observedBeforeOrTied);
}

function gateDemandCoverage(
  candidates: readonly NestedSetCandidate[],
  packSize: number
): readonly NestedSetCandidate[] {
  return Object.freeze(candidates.map((candidate) => Object.freeze({
    ...candidate,
    coreDemandIds: hasCorroboratedDemandActivation(candidate, packSize)
      ? candidate.coreDemandIds
      : Object.freeze([])
  })));
}

function hasCorroboratedDemandActivation(
  candidate: NestedSetCandidate,
  packSize: number
): boolean {
  const observed = DEMAND_ACTIVATION_SCENARIOS.filter((scenario) => {
    const rank = candidate.scenarioRanks[scenario];
    return finiteRank(rank) && rank <= packSize;
  });
  return observed.length >= 2;
}

function demandEvidenceIsValid(
  observation: ReturnType<typeof buildCandidateSelectorObservation>
): boolean {
  return observation.evidence.validity === "behavior_eligible" ||
    observation.evidence.validity === "recall_qualified" ||
    observation.evidence.validity === "observed_reference";
}

function finiteRank(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0;
}
