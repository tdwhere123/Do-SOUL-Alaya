import { isGoldExclusionReason } from "./types.js";
import type {
  ControlTreatment,
  GammaDecisionObservation,
  GoldExclusionOutcome,
  GoldExclusionReason,
  GoldMechanismObservation,
  MechanismQuestionIds,
  MechanismQuestionObservation,
  UnavailableObservation
} from "./types.js";

export function classifyMechanismFields(
  questions: readonly MechanismQuestionObservation[]
): {
  readonly field_member_added: MechanismQuestionIds;
  readonly compatibility_added: MechanismQuestionIds;
  readonly binding_solution_added: MechanismQuestionIds;
  readonly activation_changed: MechanismQuestionIds;
  readonly fused_rank_changed: MechanismQuestionIds;
  readonly gamma_admission_changed: MechanismQuestionIds;
  readonly delivered_hit_changed: MechanismQuestionIds;
} {
  return {
    field_member_added: collect(questions, classifyFieldMemberAdded),
    compatibility_added: collect(questions, classifyCompatibilityAdded),
    binding_solution_added: collect(questions, classifyBindingAdded),
    activation_changed: collect(questions, classifyActivationChanged),
    fused_rank_changed: collect(questions, classifyFusedRankChanged),
    gamma_admission_changed: collect(questions, classifyGammaAdmissionChanged),
    delivered_hit_changed: collect(questions, classifyDeliveredHitChanged)
  };
}

export function resolveFirstReason(gold: GoldMechanismObservation): GoldExclusionReason {
  if (gold.first_reason !== undefined) {
    if (!isGoldExclusionReason(gold.first_reason)) {
      throw new Error(`invalid gold first_reason: ${String(gold.first_reason)}`);
    }
    return gold.first_reason;
  }
  if (isCoverageDisplaced(gold)) return "coverage_displaced";
  return mapGammaDecision(gold.gamma_decision?.treatment);
}

export function goldOutcome(
  gold: GoldMechanismObservation,
  firstReason: GoldExclusionReason
): GoldExclusionOutcome {
  if (firstReason !== "unavailable") return "excluded";
  if (gold.gamma_decision?.treatment.kind === "retained") return "admitted";
  return "unavailable";
}

function classifyDeliveredHitChanged(
  question: MechanismQuestionObservation
): boolean | UnavailableObservation {
  return reduceBool(question, (gold) => changed(gold.delivered_hit),
    () => changed(question.delivered_hit));
}

function classifyFieldMemberAdded(
  question: MechanismQuestionObservation
): boolean | UnavailableObservation {
  return reduceBool(question, (gold) => added(gold.field_member),
    () => added(question.field_member));
}

function classifyCompatibilityAdded(
  question: MechanismQuestionObservation
): boolean | UnavailableObservation {
  return reduceBool(question, (gold) => added(gold.compatibility),
    () => added(question.compatibility));
}

function classifyBindingAdded(
  question: MechanismQuestionObservation
): boolean | UnavailableObservation {
  return reduceBool(question, (gold) => bindingAdded(gold.binding_solutions),
    () => bindingAdded(question.binding_solutions));
}

function classifyFusedRankChanged(
  question: MechanismQuestionObservation
): boolean | UnavailableObservation {
  return reduceBool(question, (gold) => changed(gold.fused_rank),
    () => changed(question.fused_rank));
}

function classifyActivationChanged(
  question: MechanismQuestionObservation
): boolean | UnavailableObservation {
  const golds = question.golds ?? [];
  if (golds.length > 0) return orClauses(golds.map(goldActivationChanged));
  return questionActivationChanged(question);
}

function classifyGammaAdmissionChanged(
  question: MechanismQuestionObservation
): boolean | UnavailableObservation {
  return orClauses([
    both(fusedInTop5BothArms(question), classifyDeliveredHitChanged(question)),
    gammaDecisionChanged(question)
  ]);
}

function goldActivationChanged(
  gold: GoldMechanismObservation
): boolean | UnavailableObservation {
  // Unscored prefix candidates are not representation/activation failures.
  if (gold.prefix_eligible === false) return false;
  if (gold.prefix_eligible !== true) return "unavailable";
  return changed(gold.activation);
}

function questionActivationChanged(
  question: MechanismQuestionObservation
): boolean | UnavailableObservation {
  const marks = (question.candidates ?? [])
    .map((candidate) => candidate.prefix_eligible)
    .filter((value) => value !== undefined);
  if (marks.length === 0) return "unavailable";
  if (marks.includes("unavailable") || marks.some((value) => value !== true)) {
    return "unavailable";
  }
  return changed(question.activation);
}

function fusedInTop5BothArms(
  question: MechanismQuestionObservation
): boolean | UnavailableObservation {
  return reduceBool(question, pairFusedInTop5Both, () => pairFusedInTop5Both(question));
}

function gammaDecisionChanged(
  question: MechanismQuestionObservation
): boolean | UnavailableObservation {
  return reduceBool(question, (gold) => gammaChanged(gold.gamma_decision),
    () => gammaChanged(question.gamma_decision));
}

function pairFusedInTop5Both(observation: {
  readonly fused_in_top5?: ControlTreatment<boolean>;
  readonly fused_rank?: ControlTreatment<number | null>;
}): boolean | UnavailableObservation {
  if (observation.fused_in_top5 !== undefined) {
    return observation.fused_in_top5.control && observation.fused_in_top5.treatment;
  }
  if (observation.fused_rank === undefined) return "unavailable";
  return rankInTop5(observation.fused_rank.control) &&
    rankInTop5(observation.fused_rank.treatment);
}

function isCoverageDisplaced(gold: GoldMechanismObservation): boolean {
  const pre = gold.rank_after_feature_rerank ?? gold.rank_after_fusion;
  const coverage = gold.rank_after_coverage_selector;
  return pre != null && pre <= 5 && coverage != null && coverage > 5;
}

function mapGammaDecision(
  decision: GammaDecisionObservation | undefined
): GoldExclusionReason {
  if (decision === undefined) return "unavailable";
  if (decision.kind === "duplicate" && decision.identity_channel === "source") {
    return "duplicate_source";
  }
  if (decision.kind === "duplicate" && decision.identity_channel === "object") {
    return "duplicate_object";
  }
  if (decision.kind === "dimension_limit") return "dimension_limit";
  if (decision.kind === "max_total_tokens") return "token_budget";
  return "unavailable";
}

function collect(
  questions: readonly MechanismQuestionObservation[],
  classify: (question: MechanismQuestionObservation) => boolean | UnavailableObservation
): MechanismQuestionIds {
  const changed: string[] = [];
  for (const question of questions) {
    const verdict = classify(question);
    if (verdict === "unavailable") return "unavailable";
    if (verdict) changed.push(question.question_id);
  }
  return freezeSortedUnique(changed);
}

function reduceBool(
  question: MechanismQuestionObservation,
  fromGold: (gold: GoldMechanismObservation) => boolean | UnavailableObservation,
  fromQuestion: () => boolean | UnavailableObservation
): boolean | UnavailableObservation {
  const golds = question.golds ?? [];
  if (golds.length === 0) return fromQuestion();
  const verdicts = golds.map(fromGold);
  if (verdicts.every((verdict) => verdict === "unavailable")) return fromQuestion();
  return orClauses(verdicts);
}

function added(
  pair: ControlTreatment<boolean> | undefined
): boolean | UnavailableObservation {
  if (pair === undefined) return "unavailable";
  return !pair.control && pair.treatment;
}

function changed<T>(
  pair: ControlTreatment<T> | undefined
): boolean | UnavailableObservation {
  if (pair === undefined) return "unavailable";
  return pair.control !== pair.treatment;
}

function bindingAdded(
  pair: ControlTreatment<readonly string[]> | undefined
): boolean | UnavailableObservation {
  if (pair === undefined) return "unavailable";
  const prior = new Set(pair.control);
  return pair.treatment.some((value) => !prior.has(value));
}

function gammaChanged(
  pair: ControlTreatment<GammaDecisionObservation> | undefined
): boolean | UnavailableObservation {
  if (pair === undefined) return "unavailable";
  return pair.control.kind !== pair.treatment.kind ||
    pair.control.reason !== pair.treatment.reason ||
    pair.control.identity_channel !== pair.treatment.identity_channel;
}

function both(
  left: boolean | UnavailableObservation,
  right: boolean | UnavailableObservation
): boolean | UnavailableObservation {
  if (left === true && right === true) return true;
  if (left === false || right === false) return false;
  return "unavailable";
}

function orClauses(
  clauses: readonly (boolean | UnavailableObservation)[]
): boolean | UnavailableObservation {
  if (clauses.includes(true)) return true;
  if (clauses.every((clause) => clause === false)) return false;
  return "unavailable";
}

function rankInTop5(rank: number | null): boolean {
  return rank !== null && rank <= 5;
}

function freezeSortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}
