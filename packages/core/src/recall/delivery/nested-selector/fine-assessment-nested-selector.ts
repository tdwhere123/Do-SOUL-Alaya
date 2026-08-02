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
  readonly orderedCandidates: readonly FineAssessmentCandidate[];
  readonly plan: Readonly<NestedSetSelectionResult>;
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
  const packSize = Math.min(context.config.budgets.max_entries, candidates.length);
  const plan = selectLexicographicNestedSet(projected, {
    headSize: Math.min(5, packSize),
    packSize
  });
  return Object.freeze({
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
  const packSize = Math.min(context.config.budgets.max_entries, incumbent.packKeys.length);
  const plan = refineIncumbentNestedSet(projected, incumbent, {
    headSize: Math.min(5, packSize),
    packSize
  });
  return Object.freeze({
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
  return calibrateDemandCoverage(gateDemandCoverage(
    calibrateOrderingDemandCoverage(
      calibrateScenarioRankTies(projected), candidates
    ),
    context.config.budgets.max_entries
  ), context.config.budgets.max_entries);
}

export function projectFineAssessmentNestedCandidate(
  candidate: FineAssessmentCandidate,
  deliveryRank: number,
  context: FineAssessmentSelectionContext,
  additionalScenarioRanks: Readonly<Record<string, number | null>> = {}
): NestedSetCandidate {
  const observation = buildCandidateSelectorObservation(candidate, context);
  const demandMatches = observation.demand.matches;
  const coreDemandIds = validCoreDemandIds(observation);
  const conjunctiveDemandIds = conjunctiveCoreDemandIds(
    demandMatches, coreDemandIds
  );
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
    coreDemandIds,
    conjunctiveCoreDemandIds: conjunctiveDemandIds,
    supportingDemandIds: validSupportingDemandIds(observation),
    applicabilityDemandIds: applicabilityDemandIds(
      demandMatches, conjunctiveDemandIds
    ),
    demandCoverage: Object.freeze({}),
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

function calibrateOrderingDemandCoverage(
  projected: readonly NestedSetCandidate[],
  candidates: readonly FineAssessmentCandidate[]
): readonly NestedSetCandidate[] {
  const sourceByKey = new Map(candidates.map((candidate) => [
    buildRecallCandidateDedupeKey(candidate), candidate
  ]));
  const orderingIds = new Set(projected.flatMap(({ coreDemandIds }) =>
    coreDemandIds.filter((id) => id.startsWith("ordering:"))
  ));
  const eligibleByOrdering = new Map([...orderingIds].map((id) => [
    id, eligibleOrderingKeys(id, projected, sourceByKey)
  ]));
  return Object.freeze(projected.map((candidate) => Object.freeze({
    ...candidate,
    coreDemandIds: filterOrderingIds(candidate.coreDemandIds, candidate.key, eligibleByOrdering),
    conjunctiveCoreDemandIds: filterOrderingIds(
      candidate.conjunctiveCoreDemandIds, candidate.key, eligibleByOrdering
    )
  })));
}

function eligibleOrderingKeys(
  orderingId: string,
  projected: readonly NestedSetCandidate[],
  sourceByKey: ReadonlyMap<string, FineAssessmentCandidate>
): ReadonlySet<string> {
  const applicable = projected.filter((candidate) =>
    candidate.coreDemandIds.includes(orderingId) &&
    candidate.supportingDemandIds.some((id) =>
      id.startsWith("lexical_term:") || id.startsWith("phrase:"))
  );
  if (orderingId === "ordering:sequence") {
    return new Set(applicable.map(({ key }) => key));
  }
  const times = applicable.map(({ key }) => ({
    key,
    time: Date.parse(sourceByKey.get(key)?.entry.event_time_start ?? "")
  })).filter(({ time }) => Number.isFinite(time));
  if (times.length === 0) return new Set();
  const extreme = orderingId === "ordering:earliest"
    ? Math.min(...times.map(({ time }) => time))
    : Math.max(...times.map(({ time }) => time));
  return new Set(times.filter(({ time }) => time === extreme).map(({ key }) => key));
}

function filterOrderingIds(
  ids: readonly string[],
  candidateKey: string,
  eligibleByOrdering: ReadonlyMap<string, ReadonlySet<string>>
): readonly string[] {
  return Object.freeze(ids.filter((id) => [...eligibleByOrdering].every(
    ([orderingId, eligible]) =>
      !containsDemandId(id, orderingId) || eligible.has(candidateKey)
  )));
}

function containsDemandId(id: string, demandId: string): boolean {
  return id === demandId || id.startsWith(`conjunction:${demandId}&`) ||
    id.endsWith(`&${demandId}`);
}

function gateDemandCoverage(
  candidates: readonly NestedSetCandidate[],
  packSize: number
): readonly NestedSetCandidate[] {
  return Object.freeze(candidates.map((candidate) => {
    const observed = observedDemandScenarios(candidate, packSize);
    const conjunctive = observed.length === 1 &&
      candidate.conjunctiveCoreDemandIds.length > 0;
    return Object.freeze({
      ...candidate,
      coreDemandIds: observed.length >= 2 || conjunctive
        ? candidate.coreDemandIds
        : Object.freeze([]),
      supportingDemandIds: observed.length >= 2 || conjunctive
        ? candidate.supportingDemandIds
        : Object.freeze([])
    });
  }));
}

function observedDemandScenarios(
  candidate: NestedSetCandidate,
  packSize: number
): readonly string[] {
  return DEMAND_ACTIVATION_SCENARIOS.filter((scenario) => {
    const rank = candidate.scenarioRanks[scenario];
    return finiteRank(rank) && rank <= packSize;
  });
}

function calibrateDemandCoverage(
  candidates: readonly NestedSetCandidate[],
  packSize: number
): readonly NestedSetCandidate[] {
  const documentFrequency = new Map<string, number>();
  for (const candidate of candidates) {
    const ids = new Set([...candidate.coreDemandIds, ...candidate.supportingDemandIds]);
    for (const id of ids) {
      documentFrequency.set(id, (documentFrequency.get(id) ?? 0) + 1);
    }
  }
  return Object.freeze(candidates.map((candidate) => Object.freeze({
    ...candidate,
    demandCoverage: demandCoverage(
      candidate, candidates.length, documentFrequency, packSize
    )
  })));
}

function demandCoverage(
  candidate: NestedSetCandidate,
  fieldSize: number,
  documentFrequency: ReadonlyMap<string, number>,
  packSize: number
): Readonly<Record<string, number>> {
  const ids = new Set([...candidate.coreDemandIds, ...candidate.supportingDemandIds]);
  const relevance = robustDemandRelevance(candidate, packSize);
  return Object.freeze(Object.fromEntries([...ids].map((id) => {
    const frequency = documentFrequency.get(id) ?? fieldSize;
    const information = Math.log1p(fieldSize / Math.max(1, frequency)) /
      Math.log1p(Math.max(1, fieldSize));
    return [id, information * relevance];
  })));
}

function robustDemandRelevance(candidate: NestedSetCandidate, packSize: number): number {
  const ranks = observedDemandScenarios(candidate, packSize)
    .map((scenario) => candidate.scenarioRanks[scenario])
    .filter(finiteRank);
  return ranks.length === 0 ? 0 : 1 / Math.max(...ranks);
}

function validCoreDemandIds(
  observation: ReturnType<typeof buildCandidateSelectorObservation>
): readonly string[] {
  if (!demandEvidenceIsValid(observation)) return Object.freeze([]);
  return Object.freeze(observation.demand.matches
    .filter(({ priority }) => priority === "core")
    .map(({ id }) => id));
}

function validSupportingDemandIds(
  observation: ReturnType<typeof buildCandidateSelectorObservation>
): readonly string[] {
  if (!demandEvidenceIsValid(observation)) return Object.freeze([]);
  return Object.freeze(observation.demand.matches
    .filter(isSelectorSupportingMatch)
    .map(({ id }) => id));
}

function conjunctiveCoreDemandIds(
  matches: ReturnType<typeof buildCandidateSelectorObservation>["demand"]["matches"],
  coreDemandIds: readonly string[]
): readonly string[] {
  const coreMatches = matches.filter(({ priority }) => priority === "core");
  const exactCore = coreMatches.some(({ kind }) =>
    kind === "object_id" || kind === "evidence_ref");
  const supportingPairs = coreMatches.flatMap((core) =>
    matches.filter(isSelectorSupportingMatch)
      .map((supporting) => conjunctionId(core.id, supporting.id))
  );
  return exactCore || supportingPairs.length > 0
    ? Object.freeze([...new Set([
        ...(exactCore ? coreDemandIds : []),
        ...supportingPairs
      ])])
    : Object.freeze([]);
}

function isSelectorSupportingMatch(
  match: ReturnType<typeof buildCandidateSelectorObservation>["demand"]["matches"][number]
): boolean {
  return match.priority === "supporting" &&
    (match.kind === "lexical_term" || match.kind === "phrase" ||
      match.kind === "facet");
}

function applicabilityDemandIds(
  matches: ReturnType<typeof buildCandidateSelectorObservation>["demand"]["matches"],
  conjunctiveIds: readonly string[]
): readonly string[] {
  const supporting = matches.filter(isSelectorSupportingMatch).map(({ id }) => id);
  return Object.freeze([...new Set([...supporting, ...conjunctiveIds])]);
}

function conjunctionId(left: string, right: string): string {
  return `conjunction:${[left, right].sort().join("&")}`;
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
