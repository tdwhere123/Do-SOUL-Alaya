import type {
  SelectGammaPort,
  SelectGammaRequest,
  SelectGammaResult
} from "@do-soul/alaya-protocol";
import { collectAdmittedCandidates } from
  "../fine-assessment-selection/admission.js";
import type {
  FineAssessmentCandidate,
  FineAssessmentSelectionContext,
  FineAssessmentSelectionParams
} from "../fine-assessment-selection/types.js";
import { gateSelectGammaEligibility } from "./eligibility.js";
import type { SelectGammaEligibilityInput } from "./types.js";

export function deriveSelectGammaEligibility(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): SelectGammaEligibilityInput {
  return Object.freeze({
    candidate_key: candidate.fusion.candidate_key,
    risk: resolveRiskEligibility(candidate, context),
    authority: "clear"
  });
}

export function eligibleFineAssessmentKeys(
  candidates: readonly FineAssessmentCandidate[]
): readonly string[] {
  return gateSelectGammaEligibility(candidates.map((candidate) =>
    Object.freeze({
      candidate_key: candidate.fusion.candidate_key,
      risk: "clear" as const,
      authority: "clear" as const
    })
  ));
}

export function bindFineAssessmentSelectGammaPort(
  params: FineAssessmentSelectionParams,
  context: FineAssessmentSelectionContext
): SelectGammaPort {
  return Object.freeze({
    select: (request: SelectGammaRequest): SelectGammaResult => Object.freeze({
      selected_candidate_keys: selectFineAssessmentGamma(
        params,
        context,
        request
      )
    })
  });
}

export function selectFineAssessmentGamma(
  params: FineAssessmentSelectionParams,
  context: FineAssessmentSelectionContext,
  request: SelectGammaRequest
): readonly string[] {
  const eligible = new Set(request.eligible_candidate_keys);
  const candidates = params.orderedCandidates.filter((candidate) =>
    eligible.has(candidate.fusion.candidate_key)
  );
  if (candidates.length !== request.eligible_candidate_keys.length) {
    throw new Error("Select_Gamma eligible keys must exist in the candidate field");
  }
  const tokenContext = withTokenBudget(context, request.token_budget);
  return Object.freeze(collectAdmittedCandidates(candidates, tokenContext).map(
    (candidate) => candidate.fusion.candidate_key
  ));
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

function withTokenBudget(
  context: FineAssessmentSelectionContext,
  tokenBudget: number
): FineAssessmentSelectionContext {
  if (!Number.isFinite(tokenBudget) || tokenBudget < 0) {
    throw new Error("Select_Gamma token_budget must be finite and non-negative");
  }
  return Object.freeze({
    ...context,
    config: Object.freeze({
      ...context.config,
      budgets: Object.freeze({
        ...context.config.budgets,
        max_total_tokens: tokenBudget
      })
    })
  });
}
