import type {
  SelectGammaPort,
  SelectGammaRequest
} from "@do-soul/alaya-protocol";
import { estimateCandidateTokens } from
  "../fine-assessment-selection/admission.js";
import type {
  FineAssessmentCandidate,
  FineAssessmentSelectionContext,
  FineAssessmentSelectionParams
} from "../fine-assessment-selection/types.js";
import { gateSelectGammaEligibility } from "./eligibility.js";
import { selectGammaQuality } from "./quality.js";
import { createSelectGammaPort } from "./select-gamma.js";
import type {
  SelectGammaEligibilityInput,
  SelectGammaFeatureWeights,
  SelectGammaFormulaCandidate
} from "./types.js";

const PINNED_GENERATION_ID = `sha256:${"a".repeat(64)}`;
const PINNED_CONDITION_DIGEST = `sha256:${"b".repeat(64)}`;

export function deriveSelectGammaEligibility(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): SelectGammaEligibilityInput {
  return Object.freeze({
    candidate_key: candidate.fusion.candidate_key,
    risk: resolveRiskEligibility(candidate, context),
    authority: resolveAuthorityEligibility(candidate, context)
  });
}

export function eligibleFineAssessmentKeys(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext
): readonly string[] {
  return gateSelectGammaEligibility(candidates.map((candidate) =>
    deriveSelectGammaEligibility(candidate, context)
  ));
}

export function bindFineAssessmentSelectGammaPort(
  params: FineAssessmentSelectionParams,
  context: FineAssessmentSelectionContext
): SelectGammaPort {
  return createSelectGammaPort({
    candidates: formulaCandidates(params.orderedCandidates, context),
    feature_weights: featureWeights(params.orderedCandidates, context),
    max_selected: context.config.budgets.max_entries
  });
}

export function buildSelectGammaRequest(
  params: FineAssessmentSelectionParams,
  context: FineAssessmentSelectionContext,
  orderedCandidates: readonly FineAssessmentCandidate[]
): SelectGammaRequest {
  return Object.freeze({
    workspace_id: params.orderedCandidates[0]?.entry.workspace_id ?? "workspace-1",
    generation_id: pinnedIdentity(params.generation_id, PINNED_GENERATION_ID),
    condition_digest: pinnedIdentity(params.condition_digest, PINNED_CONDITION_DIGEST),
    eligible_candidate_keys: eligibleFineAssessmentKeys(orderedCandidates, context),
    token_budget: context.config.budgets.max_total_tokens
  });
}

function formulaCandidates(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext
): readonly SelectGammaFormulaCandidate[] {
  return Object.freeze(candidates.map((candidate) => Object.freeze({
    candidate_key: candidate.fusion.candidate_key,
    token_cost: Math.max(1, estimateCandidateTokens(candidate, context)),
    quality: selectGammaQuality({
      relevance: context.coverageRelevanceByCandidateKey.get(
        candidate.fusion.candidate_key
      ) ?? candidate.fusion.fused_score,
      authority: 0,
      temporal_fit: 0,
      path_support: candidate.effectiveFactors.graph_support ?? 0
    }),
    cover: candidateCover(candidate, context)
  })));
}

function candidateCover(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): Readonly<Record<string, number>> {
  const gist = context.supplementaryData.evidenceGistsByMemoryId[candidate.entry.object_id];
  const lineage = context.supplementaryData.sourceCohortKeys[candidate.entry.object_id];
  return Object.freeze({
    ...(gist === undefined ? {} : { [`gist:${gist}`]: 1 }),
    ...(lineage === undefined ? {} : { [`lineage:${lineage}`]: 1 })
  });
}

function featureWeights(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext
): SelectGammaFeatureWeights {
  const weights: Record<string, number> = {};
  for (const candidate of candidates) {
    for (const feature of Object.keys(candidateCover(candidate, context))) {
      weights[feature] = 1;
    }
  }
  return Object.freeze(weights);
}

function resolveRiskEligibility(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): SelectGammaEligibilityInput["risk"] {
  if (!context.config.conflict_awareness) return "clear";
  const penalty = candidate.effectiveFactors.conflict_penalty ?? 0;
  const contradictions = candidate.entry.contradiction_count ?? 0;
  return penalty > 0 || contradictions > 0 ? "blocked" : "clear";
}

function resolveAuthorityEligibility(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): SelectGammaEligibilityInput["authority"] {
  const ceiling = context.supplementaryData?.governanceCeilingByMemoryId?.[
    candidate.entry.object_id
  ];
  return ceiling === 0 ? "blocked" : "clear";
}

function pinnedIdentity(value: string | undefined, fallback: string): string {
  if (value === undefined || value.length === 0 || value === "unspecified") {
    return fallback;
  }
  return value;
}
