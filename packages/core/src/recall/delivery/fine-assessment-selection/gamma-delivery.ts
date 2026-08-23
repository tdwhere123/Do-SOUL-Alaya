import { buildRecallCandidate } from "../../runtime/recall-candidate-builder.js";
import {
  buildRecallCandidateDedupeKey,
  buildRecallLogicalObjectKey,
  isWorkspaceMemoryCandidate
} from "../../runtime/recall-service-helpers.js";
import { buildFinalScoreFactors, createFineAssessmentDiagnostic } from
  "../diagnostics/fine-assessment-diagnostics.js";
import type { SelectGammaDecision, SelectGammaWalkResult } from
  "../select-gamma/types.js";
import { assertSelectGammaWalkReceipts } from
  "../select-gamma/validation/decision-receipts.js";
import { createAdmissionState, recordAcceptedAdmission } from "./admission.js";
import type {
  FineAssessmentAccumulator,
  FineAssessmentAdmissionReceipt,
  FineAssessmentCandidate,
  FineAssessmentSelectionContext
} from "./types.js";

export function materializeSelectGammaAccumulator(
  candidates: readonly FineAssessmentCandidate[],
  walk: SelectGammaWalkResult,
  context: FineAssessmentSelectionContext,
  captureReceipts: boolean
): FineAssessmentAccumulator {
  assertSelectGammaWalkReceipts(walk);
  const byKey = new Map(candidates.map((candidate) => [
    candidate.fusion.candidate_key,
    candidate
  ]));
  return walk.decisions.reduce((accumulator, decision) => {
    const candidate = byKey.get(decision.candidate_key);
    if (candidate === undefined) {
      throw new Error("Select_Gamma decision references an unknown candidate");
    }
    if (decision.marginal_gain !== null) {
      context.coverageMarginalGainByCandidateKey.set(
        decision.candidate_key,
        decision.marginal_gain
      );
    }
    return appendDecision(accumulator, candidate, decision, context);
  }, createAccumulator(captureReceipts));
}

function createAccumulator(captureReceipts: boolean): FineAssessmentAccumulator {
  return {
    selected: [],
    diagnostics: [],
    admission: createAdmissionState(captureReceipts),
    ...(captureReceipts ? { admissionReceipts: [] } : {})
  };
}

function appendDecision(
  accumulator: FineAssessmentAccumulator,
  candidate: FineAssessmentCandidate,
  decision: SelectGammaDecision,
  context: FineAssessmentSelectionContext
): FineAssessmentAccumulator {
  const receipt = decision.receipt;
  accumulator.admissionReceipts?.push(receipt);
  if (receipt.kind !== "retained") {
    accumulator.diagnostics.push(createFineAssessmentDiagnostic(
      candidate, buildRecallCandidateDedupeKey(candidate), decision.selection_order,
      null, receipt.kind, context, "final_selector", receipt
    ));
    return accumulator;
  }
  return appendRetained(accumulator, candidate, decision, receipt, context);
}

function appendRetained(
  accumulator: FineAssessmentAccumulator,
  candidate: FineAssessmentCandidate,
  decision: SelectGammaDecision,
  receipt: Extract<FineAssessmentAdmissionReceipt, { readonly kind: "retained" }>,
  context: FineAssessmentSelectionContext
): FineAssessmentAccumulator {
  const candidateKey = buildRecallCandidateDedupeKey(candidate);
  const relevance = context.finalRelevanceByCandidateKey.get(candidateKey) ??
    candidate.fusion.fused_score;
  const next = buildRecallCandidate({
    candidate,
    relevanceScore: relevance,
    scoreFactors: buildFinalScoreFactors(candidate, relevance),
    finalRelevanceSource: context.answerRelevanceRankByCandidateKey.has(candidateKey)
      ? "answer_rerank" : "fusion",
    tokenEstimator: context.tokenEstimator,
    tokenEstimate: receipt.token_estimate,
    budgets: context.config.budgets,
    index: accumulator.selected.length,
    usedTokensBeforeCandidate: accumulator.admission.totalTokens,
    governanceCeiling: isWorkspaceMemoryCandidate(candidate)
      ? context.supplementaryData.governanceCeilingByMemoryId[candidate.entry.object_id]
      : undefined
  });
  accumulator.selected.push(next);
  accumulator.diagnostics.push(createFineAssessmentDiagnostic(
    candidate, candidateKey, decision.selection_order,
    decision.selected_rank, null, context, "final_selector", receipt
  ));
  recordAcceptedAdmission(
    accumulator.admission,
    candidate,
    buildRecallLogicalObjectKey(candidate),
    receipt.token_estimate
  );
  return accumulator;
}
