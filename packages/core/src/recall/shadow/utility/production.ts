import { compareCodeUnits } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { compileRecallQueryDemand } from "../../query/recall-query-demand.js";
import { collectFactFrameSemanticFactorsFromCapture } from
  "../../field/query-attribution/query-fact-frame-attribution-producer.js";
import { materializeAttributedQueryFacilityDemand } from
  "../../field/query-facility-demand.js";
import { materializeAttributedFacilityMatches } from
  "../../field/facility/match-materialization.js";
import { resolveCandidateCoverageReceipt } from
  "../../delivery/fine-assessment-selection/coverage-atoms.js";
import { attachContentOwnedFactProjection } from
  "../../delivery/fine-assessment-selection/content-owned-fact-key.js";
import {
  buildRecallCandidateDedupeKey,
  buildRecallLogicalObjectKey
} from "../../runtime/recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallSupplementaryData
} from "../../runtime/recall-service-types.js";
import {
  parseSetUtilityInput,
  type ShadowCidReceipt,
  type ShadowFacilityObligationReceipt,
  type ShadowOsfStatus,
  type ShadowSetUtilityInput,
  type ShadowValuePair
} from "../capture.js";

const DEMAND_WEIGHTS = Object.freeze({
  entity: 1,
  relation: 1,
  time: 1,
  logical_object: 1,
  independent_evidence: 1
});

export function buildProductionSetUtilities(input: Readonly<{
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly supplementaryData: RecallSupplementaryData;
}>): ReadonlyMap<string, ShadowSetUtilityInput> {
  const demand = materializeAttributedQueryFacilityDemand({
    query_demand: compileRecallQueryDemand(input.supplementaryData.queryProbes),
    weights: DEMAND_WEIGHTS,
    semantic_factors: input.supplementaryData.queryFactFrameExtraction === undefined
      ? []
      : collectFactFrameSemanticFactorsFromCapture(
        input.supplementaryData.queryFactFrameExtraction
      )
  });
  const covered = input.candidates.map((candidate) => candidateCoverage(
    candidate,
    input.supplementaryData
  ));
  const matches = materializeAttributedFacilityMatches({ demand, candidates: covered });
  const coverageByKey = new Map(covered.map((candidate) => [
    candidate.candidate_key, candidate.coverage
  ] as const));
  return new Map(input.candidates.map((candidate) => {
    const key = buildRecallCandidateDedupeKey(candidate);
    return [key, utilityForCandidate(
      candidate,
      key,
      demand.demand_atoms,
      matches.get(key) ?? [],
      coverageByKey.get(key)!,
      input.supplementaryData
    )] as const;
  }));
}

function candidateCoverage(
  candidate: Readonly<CoarseRecallCandidate>,
  supplementaryData: RecallSupplementaryData
) {
  const candidateKey = buildRecallCandidateDedupeKey(candidate);
  const coverage = resolveCandidateCoverageReceipt({
    ...candidate,
    effectiveFactors: Object.freeze({ activation: 0, relevance: 0 }),
    fusion: Object.freeze({ candidate_key: candidateKey })
  }, {
    embeddingSimilarityScores: supplementaryData.embeddingSimilarityScores,
    evidenceSemanticActivationsByCandidateKey:
      supplementaryData.evidenceSemanticActivationsByCandidateKey,
    openSemanticFactorCandidateActivationsByCandidateKey:
      supplementaryData.openSemanticFactorCandidateActivationsByCandidateKey,
    evidenceProjectionMatchesByRef: supplementaryData.evidenceProjectionMatchesByRef
  });
  return Object.freeze({
    candidate_key: candidateKey,
    object_id: candidate.entry.object_id,
    coverage: attachContentOwnedFactProjection(coverage, {
      objectId: candidate.entry.object_id,
      content: candidate.entry.content
    })
  });
}

function utilityForCandidate(
  candidate: Readonly<CoarseRecallCandidate>,
  candidateKey: string,
  demands: ReturnType<typeof materializeAttributedQueryFacilityDemand>["demand_atoms"],
  matches: ReturnType<typeof materializeAttributedFacilityMatches> extends
    ReadonlyMap<string, infer T> ? T : never,
  coverage: ReturnType<typeof candidateCoverage>["coverage"],
  supplementaryData: RecallSupplementaryData
): ShadowSetUtilityInput {
  const byDemand = new Map<string, number>();
  for (const match of matches) {
    byDemand.set(match.demand_atom_id, Math.max(
      byDemand.get(match.demand_atom_id) ?? 0,
      match.match_strength
    ));
  }
  const values = valuesForCandidate(candidate, supplementaryData);
  const cid = evidenceIdentity(candidate, supplementaryData);
  const obligations = demands.map((demand) => {
    const cover = byDemand.get(demand.demand_atom_id) ?? 0;
    const completeness = coveredCompleteness(coverage);
    return {
      key: { kind: demand.kind, value: demand.value },
      raw_atom_ids: [demand.source_query_atom_id],
      availability: cover > 0 ? "available" as const : completeness,
      cover,
      evaluated: cover > 0 || completeness === "known_zero"
    };
  });
  return parseSetUtilityInput({
    schema_version: 1,
    candidate_key: candidateKey,
    object_key: buildRecallLogicalObjectKey(candidate),
    obligations,
    matches: matches.map((match) => {
      const demand = demands.find((item) => item.demand_atom_id === match.demand_atom_id)!;
      return {
        obligation: { kind: demand.kind, value: demand.value },
        raw_atom_id: match.coverage_atom_id,
        attribution_kind: demand.attribution_kind,
        match_strength: match.match_strength
      };
    }),
    values,
    cid,
    availability: {
      facility: facilityAvailability(obligations),
      values: values.status,
      evidence_identity: cid.status
    }
  });
}

function coveredCompleteness(
  coverage: ReturnType<typeof candidateCoverage>["coverage"]
): "known_zero" | "not_observed" {
  return coverage.evidence_semantic_completeness === "complete"
    ? "known_zero"
    : "not_observed";
}

function facilityAvailability(
  obligations: readonly ShadowFacilityObligationReceipt[]
): "not_applicable" | "available" | "partially_unavailable" | "unavailable" {
  if (obligations.length === 0) return "not_applicable";
  const observed = obligations.filter(({ evaluated }) => evaluated).length;
  if (observed === obligations.length) return "available";
  return observed === 0 ? "unavailable" : "partially_unavailable";
}

function valuesForCandidate(
  candidate: Readonly<CoarseRecallCandidate>,
  supplementaryData: RecallSupplementaryData
): Readonly<{ readonly status: ShadowOsfStatus; readonly values: readonly ShadowValuePair[] }> {
  const composition = supplementaryData.openSemanticFactorComposition;
  if (composition === undefined) return Object.freeze({ status: "unavailable", values: [] });
  if (composition.status !== "composed") {
    return Object.freeze({ status: composition.status, values: [] });
  }
  if (composition.truncated) return Object.freeze({ status: "truncated", values: [] });
  const evidenceIds = new Set(candidateEvidenceIds(candidate));
  const values = composition.variable_collections.flatMap((collection) =>
    collection.values.filter((value) => value.evidence_ids.some((id) => evidenceIds.has(id)))
      .map((value) => Object.freeze({
        variable_id: collection.variable_id,
        semantic_identity: value.semantic_identity
      }))
  );
  const unique = new Map(values.map((value) => [
    `${value.variable_id}\0${value.semantic_identity}`,
    value
  ]));
  const stable = Object.freeze([...unique.values()].sort((left, right) =>
    compareCodeUnits(left.variable_id, right.variable_id) ||
    compareCodeUnits(left.semantic_identity, right.semantic_identity)
  ));
  return Object.freeze({ status: stable.length > 0 ? "composed" : "no_match", values: stable });
}

function evidenceIdentity(
  candidate: Readonly<CoarseRecallCandidate>,
  _supplementaryData: RecallSupplementaryData
): ShadowCidReceipt {
  const content = candidate.entry.content.trim().normalize("NFC");
  return content.length > 0
    ? Object.freeze({ status: "available",
      cid: groundedCid("content", [content]), grounding: "content" })
    : Object.freeze({ status: "unavailable" });
}

function candidateEvidenceIds(
  candidate: Readonly<CoarseRecallCandidate>
): readonly string[] {
  const refs = [...candidate.entry.evidence_refs];
  if (candidate.objectKind === "evidence_capsule") refs.push(candidate.entry.object_id);
  return Object.freeze([...new Set(refs.filter((ref) => ref.trim().length > 0))]
    .sort(compareCodeUnits));
}

function groundedCid(
  grounding: "content" | "gist" | "ref",
  parts: readonly string[]
): string {
  return `${grounding}:sha256:${fieldContractSha256(JSON.stringify([
    "capture-grounded-cid-v1", grounding, parts
  ]))}`;
}
