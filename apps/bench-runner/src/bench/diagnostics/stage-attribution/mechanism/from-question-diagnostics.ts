import type {
  LongMemEvalGoldDiagnostic,
  LongMemEvalQuestionDiagnostic
} from "../../schema/diagnostics-types.js";
import type {
  ControlTreatment,
  GammaDecisionObservation,
  GoldMechanismObservation,
  MechanismQuestionObservation
} from "./types.js";

const DECISION_KINDS = new Set([
  "duplicate",
  "dimension_limit",
  "quality_displaced",
  "coverage_displaced",
  "max_entries",
  "max_total_tokens"
]);

/** Projects persisted arm diagnostics into the receipt's paired observation shape. */
export function pairMechanismQuestions(
  control: readonly LongMemEvalQuestionDiagnostic[],
  treatment: readonly LongMemEvalQuestionDiagnostic[]
): readonly MechanismQuestionObservation[] {
  const controlById = new Map(control.map((question) => [question.question_id, question]));
  return treatment
    .map((treatmentQuestion) => pairQuestion(
      controlById.get(treatmentQuestion.question_id), treatmentQuestion
    ))
    .sort((left, right) => left.question_id < right.question_id ? -1 : 1);
}

function pairQuestion(
  control: LongMemEvalQuestionDiagnostic | undefined,
  treatment: LongMemEvalQuestionDiagnostic
): MechanismQuestionObservation {
  const controlGolds = new Map(control?.gold.map((gold) => [gold.object_id, gold]) ?? []);
  const goldIds = new Set(treatment.gold.map((gold) => gold.object_id));
  for (const gold of control?.gold ?? []) goldIds.add(gold.object_id);
  const golds = [...goldIds].sort().map((goldKey) => pairGold(
    controlGolds.get(goldKey),
    treatment.gold.find((gold) => gold.object_id === goldKey),
    control,
    treatment,
    goldKey
  ));
  return {
    question_id: treatment.question_id,
    delivered_hit: pair(control?.hit_at_5, treatment.hit_at_5),
    field_member: pair(
      control === undefined ? undefined : fieldMember(control),
      fieldMember(treatment)
    ),
    compatibility: pair(
      control === undefined ? undefined : compatibilityMember(control),
      compatibilityMember(treatment)
    ),
    binding_solutions: pair(
      control === undefined ? undefined : bindingSolutions(control),
      bindingSolutions(treatment)
    ),
    activation: pair(
      control === undefined ? undefined : activationValue(control),
      activationValue(treatment)
    ),
    candidates: mergeCandidates(control, treatment),
    golds
  };
}

function pairGold(
  control: LongMemEvalGoldDiagnostic | undefined,
  treatment: LongMemEvalGoldDiagnostic | undefined,
  controlQuestion: LongMemEvalQuestionDiagnostic | undefined,
  treatmentQuestion: LongMemEvalQuestionDiagnostic,
  goldKey: string
): GoldMechanismObservation {
  const treatmentGold = treatment;
  const controlCandidate = control === undefined || controlQuestion === undefined
    ? undefined
    : controlQuestion.candidates.find((candidate) => candidate.object_id === control.object_id);
  const treatmentCandidate = treatmentGold === undefined ? undefined :
    treatmentQuestion.candidates.find((candidate) => candidate.object_id === treatmentGold.object_id);
  const prefix = pairPrefixEligibility(controlCandidate, treatmentCandidate, controlQuestion,
    treatmentQuestion);
  const treatmentDecision = treatmentGold === undefined
    ? undefined
    : decisionFor(treatmentGold);
  const controlDecision = control === undefined ? undefined : decisionFor(control);
  return {
    gold_key: goldKey,
    ...(treatmentCandidate?.candidate_key === undefined && controlCandidate?.candidate_key === undefined
      ? {} : {
      candidate_key: treatmentCandidate?.candidate_key ?? controlCandidate?.candidate_key
    }),
    ...(control === undefined && treatment === undefined ? {} : {
      delivered_hit: pair(
        control === undefined ? undefined : isDelivered(control),
        treatment === undefined ? undefined : isDelivered(treatment)
      )
    }),
    prefix_eligible: prefix,
    activation: pair(
      controlCandidate === undefined || controlQuestion === undefined
        ? undefined : candidateActivation(controlQuestion, controlCandidate.candidate_key),
      treatmentCandidate === undefined
        ? undefined : candidateActivation(treatmentQuestion, treatmentCandidate.candidate_key)
    ),
    fused_rank: pair(control?.fused_rank, treatment?.fused_rank),
    rank_after_fusion: treatment?.rank_after_fusion ?? null,
    rank_after_feature_rerank: treatment?.rank_after_feature_rerank ?? null,
    rank_after_coverage_selector: treatment?.rank_after_coverage_selector ?? null,
    gamma_decision: pair(controlDecision, treatmentDecision)
  };
}

function fieldMember(question: LongMemEvalQuestionDiagnostic): boolean | undefined {
  return question.query_open_semantic_factor_formation === undefined ||
    question.query_open_semantic_factor_formation === null
    ? undefined
    : question.query_open_semantic_factor_formation.status === "formed";
}

function compatibilityMember(question: LongMemEvalQuestionDiagnostic): boolean | undefined {
  const trace = question.open_semantic_factor_compatibility_trace;
  if (trace === undefined || trace === null) return undefined;
  if (trace.entries.some((entry) => entry.receipt.status === "compatible")) return true;
  if (trace.entries.some((entry) => entry.receipt.status === "incompatible")) return false;
  return trace.incomparable_seal === "none" ? false : undefined;
}

function bindingSolutions(question: LongMemEvalQuestionDiagnostic): readonly string[] | undefined {
  const composition = question.open_semantic_factor_composition;
  if (composition === undefined || composition === null) return undefined;
  return composition.solutions.map((solution) => JSON.stringify(solution)).sort();
}

function activationValue(question: LongMemEvalQuestionDiagnostic): number | undefined {
  const activation = question.open_semantic_factor_activation;
  if (activation === undefined || activation === null) return undefined;
  if (activation.status === "unavailable" || activation.status === "ineligible" ||
      activation.status === "rejected") return undefined;
  return activation.entries.reduce((max, entry) => Math.max(max, entry.activation), 0);
}

function mergeCandidates(
  control: LongMemEvalQuestionDiagnostic | undefined,
  treatment: LongMemEvalQuestionDiagnostic
) {
  const byKey = new Map<string, { candidate_key: string; prefix_eligible: boolean | "unavailable" }>();
  for (const candidate of [...(control?.candidates ?? []), ...treatment.candidates]) {
    const existing = byKey.get(candidate.candidate_key);
    if (existing !== undefined) continue;
    byKey.set(candidate.candidate_key, {
      candidate_key: candidate.candidate_key,
      prefix_eligible: candidatePrefixEligibility(control, treatment, candidate.candidate_key)
    });
  }
  return [...byKey.values()].sort((left, right) => left.candidate_key.localeCompare(right.candidate_key));
}

function candidatePrefixEligibility(
  control: LongMemEvalQuestionDiagnostic | undefined,
  treatment: LongMemEvalQuestionDiagnostic,
  candidateKey: string
): boolean | "unavailable" {
  const controlKnown = control?.open_semantic_factor_candidate_activations !== undefined;
  const treatmentKnown = treatment.open_semantic_factor_candidate_activations !== undefined;
  if (!controlKnown || !treatmentKnown) return "unavailable";
  return candidateActivationEntry(control!, candidateKey) !== undefined &&
    candidateActivationEntry(treatment, candidateKey) !== undefined;
}

function pairPrefixEligibility(
  controlCandidate: LongMemEvalQuestionDiagnostic["candidates"][number] | undefined,
  treatmentCandidate: LongMemEvalQuestionDiagnostic["candidates"][number] | undefined,
  controlQuestion: LongMemEvalQuestionDiagnostic | undefined,
  treatmentQuestion: LongMemEvalQuestionDiagnostic
): boolean | "unavailable" | undefined {
  if (controlCandidate === undefined && treatmentCandidate === undefined) return undefined;
  if (controlQuestion === undefined || controlCandidate === undefined || treatmentCandidate === undefined) {
    return "unavailable";
  }
  const controlKnown = controlQuestion.open_semantic_factor_candidate_activations !== undefined;
  const treatmentKnown = treatmentQuestion.open_semantic_factor_candidate_activations !== undefined;
  if (!controlKnown || !treatmentKnown) return "unavailable";
  return candidateActivationEntry(controlQuestion, controlCandidate.candidate_key) !== undefined &&
    candidateActivationEntry(treatmentQuestion, treatmentCandidate.candidate_key) !== undefined;
}

function candidateActivation(
  question: LongMemEvalQuestionDiagnostic,
  candidateKey: string
): number | undefined {
  return candidateActivationEntry(question, candidateKey)?.receipt.score;
}

function candidateActivationEntry(
  question: LongMemEvalQuestionDiagnostic,
  candidateKey: string
) {
  return question.open_semantic_factor_candidate_activations?.find((entry) =>
    entry.candidate_key === candidateKey
  );
}

function decisionFor(gold: LongMemEvalGoldDiagnostic): GammaDecisionObservation {
  if (gold.select_gamma_decision !== undefined) return gold.select_gamma_decision;
  const dropped = gold.budget_drop_reason;
  if (dropped !== null && DECISION_KINDS.has(dropped)) {
    return { kind: dropped };
  }
  return isDelivered(gold) ? { kind: "retained" } : { kind: "unavailable" };
}

function isDelivered(gold: LongMemEvalGoldDiagnostic): boolean {
  return gold.candidate_status === "delivered" ||
    gold.candidate_status === "active_constraint_delivered";
}

function pair<T>(
  control: T | undefined,
  treatment: T | undefined
): ControlTreatment<T> | undefined {
  if (control === undefined || treatment === undefined) return undefined;
  return { control, treatment };
}
