export const RECALL_MECHANISM_SPLIT_KIND = "recall_mechanism_split_v1" as const;
export const RECALL_MECHANISM_SPLIT_SCHEMA_VERSION = 1 as const;
export const GOLD_EXCLUSION_FIRST_REASONS = Object.freeze([
  "quality_displaced",
  "coverage_displaced",
  "duplicate_source",
  "duplicate_object",
  "dimension_limit",
  "token_budget",
  "entry_budget"
] as const);

export type GoldExclusionFirstReason = (typeof GOLD_EXCLUSION_FIRST_REASONS)[number];
export type UnavailableObservation = "unavailable";
export type MechanismQuestionIds = readonly string[] | UnavailableObservation;
export type GoldExclusionReason = GoldExclusionFirstReason | UnavailableObservation;
export type PrefixEligibility = boolean | UnavailableObservation;

export interface ControlTreatment<T> {
  readonly control: T;
  readonly treatment: T;
}

export interface GammaDecisionObservation {
  readonly kind: string;
  readonly reason?: string;
  readonly identity_channel?: "object" | "source" | "lineage";
}

export interface GoldMechanismObservation {
  readonly gold_key: string;
  readonly candidate_key?: string;
  readonly first_reason?: GoldExclusionReason;
  readonly prefix_eligible?: PrefixEligibility;
  readonly delivered_hit?: ControlTreatment<boolean>;
  readonly field_member?: ControlTreatment<boolean>;
  readonly compatibility?: ControlTreatment<boolean>;
  readonly binding_solutions?: ControlTreatment<readonly string[]>;
  readonly activation?: ControlTreatment<number>;
  readonly fused_rank?: ControlTreatment<number | null>;
  readonly fused_in_top5?: ControlTreatment<boolean>;
  readonly gamma_decision?: ControlTreatment<GammaDecisionObservation>;
}

export interface PrefixCandidateObservation {
  readonly candidate_key: string;
  readonly prefix_eligible?: PrefixEligibility;
}

export interface MechanismQuestionObservation {
  readonly question_id: string;
  readonly delivered_hit?: ControlTreatment<boolean>;
  readonly field_member?: ControlTreatment<boolean>;
  readonly compatibility?: ControlTreatment<boolean>;
  readonly binding_solutions?: ControlTreatment<readonly string[]>;
  readonly activation?: ControlTreatment<number>;
  readonly fused_rank?: ControlTreatment<number | null>;
  readonly fused_in_top5?: ControlTreatment<boolean>;
  readonly gamma_decision?: ControlTreatment<GammaDecisionObservation>;
  readonly golds?: readonly GoldMechanismObservation[];
  readonly candidates?: readonly PrefixCandidateObservation[];
}

export interface RecallMechanismSplitInput {
  readonly questions: readonly MechanismQuestionObservation[];
}

export interface GoldExclusionRow {
  readonly question_id: string;
  readonly gold_key: string;
  readonly first_reason: GoldExclusionReason;
}

export interface PrefixEligibilityRow {
  readonly question_id: string;
  readonly candidate_key: string;
  readonly eligible: PrefixEligibility;
}

export interface RecallMechanismSplitReceipt {
  readonly schema_version: 1;
  readonly kind: typeof RECALL_MECHANISM_SPLIT_KIND;
  readonly field_member_added: MechanismQuestionIds;
  readonly compatibility_added: MechanismQuestionIds;
  readonly binding_solution_added: MechanismQuestionIds;
  readonly activation_changed: MechanismQuestionIds;
  readonly fused_rank_changed: MechanismQuestionIds;
  readonly gamma_admission_changed: MechanismQuestionIds;
  readonly delivered_hit_changed: MechanismQuestionIds;
  readonly gold_exclusions: readonly GoldExclusionRow[];
  readonly bounded_candidate_prefix: readonly PrefixEligibilityRow[];
}

const FIRST_REASON_SET = new Set<string>(GOLD_EXCLUSION_FIRST_REASONS);

export function buildRecallMechanismSplit(
  input: RecallMechanismSplitInput
): RecallMechanismSplitReceipt {
  const questions = indexedQuestions(input.questions);
  return Object.freeze({
    schema_version: RECALL_MECHANISM_SPLIT_SCHEMA_VERSION,
    kind: RECALL_MECHANISM_SPLIT_KIND,
    field_member_added: collect(questions, classifyFieldMemberAdded),
    compatibility_added: collect(questions, classifyCompatibilityAdded),
    binding_solution_added: collect(questions, classifyBindingAdded),
    activation_changed: collect(questions, classifyActivationChanged),
    fused_rank_changed: collect(questions, classifyFusedRankChanged),
    gamma_admission_changed: collect(questions, classifyGammaAdmissionChanged),
    delivered_hit_changed: collect(questions, classifyDeliveredHitChanged),
    gold_exclusions: freezeGoldExclusions(questions),
    bounded_candidate_prefix: freezePrefixRows(questions)
  });
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
  return reduceBool(question, goldActivationChanged, () => questionActivationChanged(question));
}

function classifyGammaAdmissionChanged(
  question: MechanismQuestionObservation
): boolean | UnavailableObservation {
  return orClauses([
    both(fusedInTop5(question), classifyDeliveredHitChanged(question)),
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
  const eligible = questionPrefixEligible(question);
  if (eligible === false) return false;
  if (eligible !== true) return "unavailable";
  return changed(question.activation);
}

function fusedInTop5(
  question: MechanismQuestionObservation
): boolean | UnavailableObservation {
  return reduceBool(question, goldFusedInTop5, () => pairFusedInTop5(question));
}

function gammaDecisionChanged(
  question: MechanismQuestionObservation
): boolean | UnavailableObservation {
  return reduceBool(question, (gold) => gammaChanged(gold.gamma_decision),
    () => gammaChanged(question.gamma_decision));
}

function goldFusedInTop5(
  gold: GoldMechanismObservation
): boolean | UnavailableObservation {
  return pairFusedInTop5(gold);
}

function pairFusedInTop5(observation: {
  readonly fused_in_top5?: ControlTreatment<boolean>;
  readonly fused_rank?: ControlTreatment<number | null>;
}): boolean | UnavailableObservation {
  if (observation.fused_in_top5 !== undefined) {
    return observation.fused_in_top5.control || observation.fused_in_top5.treatment;
  }
  if (observation.fused_rank === undefined) return "unavailable";
  return rankInTop5(observation.fused_rank.control) ||
    rankInTop5(observation.fused_rank.treatment);
}

function questionPrefixEligible(
  question: MechanismQuestionObservation
): boolean | UnavailableObservation {
  const marks = [
    ...(question.golds ?? []).map((gold) => gold.prefix_eligible),
    ...(question.candidates ?? []).map((candidate) => candidate.prefix_eligible)
  ].filter((value) => value !== undefined);
  if (marks.length === 0) return "unavailable";
  if (marks.includes("unavailable")) return "unavailable";
  if (marks.every((value) => value === false)) return false;
  if (marks.every((value) => value === true)) return true;
  return "unavailable";
}

function freezeGoldExclusions(
  questions: readonly MechanismQuestionObservation[]
): readonly GoldExclusionRow[] {
  const rows: GoldExclusionRow[] = [];
  const seen = new Set<string>();
  for (const question of questions) {
    for (const gold of question.golds ?? []) {
      const goldKey = requireToken(gold.gold_key, "gold_key");
      pushUnique(seen, pairKey(question.question_id, goldKey), "gold exclusion");
      rows.push(Object.freeze({
        question_id: question.question_id,
        gold_key: goldKey,
        first_reason: resolveFirstReason(gold)
      }));
    }
  }
  rows.sort(compareGoldRow);
  return Object.freeze(rows);
}

function freezePrefixRows(
  questions: readonly MechanismQuestionObservation[]
): readonly PrefixEligibilityRow[] {
  const rows: PrefixEligibilityRow[] = [];
  const seen = new Set<string>();
  for (const question of questions) {
    for (const gold of question.golds ?? []) {
      appendPrefixRow(rows, seen, question.question_id,
        gold.candidate_key ?? gold.gold_key, gold.prefix_eligible);
    }
    for (const candidate of question.candidates ?? []) {
      appendPrefixRow(rows, seen, question.question_id,
        candidate.candidate_key, candidate.prefix_eligible);
    }
  }
  rows.sort(comparePrefixRow);
  return Object.freeze(rows);
}

function appendPrefixRow(
  rows: PrefixEligibilityRow[],
  seen: Set<string>,
  questionId: string,
  candidateKey: string,
  eligible: PrefixEligibility | undefined
): void {
  const key = requireToken(candidateKey, "candidate_key");
  pushUnique(seen, pairKey(questionId, key), "prefix eligibility");
  rows.push(Object.freeze({
    question_id: questionId,
    candidate_key: key,
    eligible: eligible ?? "unavailable"
  }));
}

function resolveFirstReason(gold: GoldMechanismObservation): GoldExclusionReason {
  if (gold.first_reason !== undefined) {
    if (!isGoldExclusionReason(gold.first_reason)) {
      throw new Error(`invalid gold first_reason: ${String(gold.first_reason)}`);
    }
    return gold.first_reason;
  }
  return mapGammaDecision(gold.gamma_decision?.treatment);
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
  if (decision.kind === "max_entries") return "entry_budget";
  return "unavailable";
}

function collect(
  questions: readonly MechanismQuestionObservation[],
  classify: (question: MechanismQuestionObservation) => boolean | UnavailableObservation
): MechanismQuestionIds {
  const changed: string[] = [];
  let observed = false;
  for (const question of questions) {
    const verdict = classify(question);
    if (verdict === "unavailable") continue;
    observed = true;
    if (verdict) changed.push(question.question_id);
  }
  return observed ? freezeSortedUnique(changed) : "unavailable";
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

function indexedQuestions(
  questions: readonly MechanismQuestionObservation[]
): readonly MechanismQuestionObservation[] {
  const seen = new Set<string>();
  for (const question of questions) {
    const questionId = requireToken(question.question_id, "question_id");
    pushUnique(seen, questionId, "mechanism split question");
  }
  return questions;
}

function isGoldExclusionReason(value: unknown): value is GoldExclusionReason {
  return value === "unavailable" || FIRST_REASON_SET.has(value as string);
}

function compareGoldRow(left: GoldExclusionRow, right: GoldExclusionRow): number {
  return comparePair(left.question_id, left.gold_key, right.question_id, right.gold_key);
}

function comparePrefixRow(left: PrefixEligibilityRow, right: PrefixEligibilityRow): number {
  return comparePair(
    left.question_id, left.candidate_key, right.question_id, right.candidate_key
  );
}

function comparePair(
  leftId: string, leftKey: string, rightId: string, rightKey: string
): number {
  if (leftId !== rightId) return leftId < rightId ? -1 : 1;
  if (leftKey === rightKey) return 0;
  return leftKey < rightKey ? -1 : 1;
}

function freezeSortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function pushUnique(seen: Set<string>, key: string, label: string): void {
  if (seen.has(key)) throw new Error(`duplicate ${label}: ${key}`);
  seen.add(key);
}

function pairKey(questionId: string, key: string): string {
  return `${questionId}\0${key}`;
}

function requireToken(value: string, label: string): string {
  if (!isNonEmptyString(value)) throw new Error(`mechanism split ${label} is empty`);
  return value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
