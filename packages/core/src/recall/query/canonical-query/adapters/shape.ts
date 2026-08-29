import { CJK_COPULAR_MEASURE_FORMS } from
  "../../../../shared/fact-frame-grammar/cjk-interrogative-forms.js";
import { isRuleBasedCopularMeasureValue } from
  "../../../../shared/fact-frame-grammar/result-slots.js";
import { compileRecallAnswerShapePlan, type RecallAnswerShapePlan } from
  "../../recall-answer-shape-plan.js";
import type { RecallQueryProbes } from "../../recall-query-probes.js";
import type { CanonicalConstantV1, CanonicalPredicateV1 } from "../types.js";
import { naryPredicate, pushUnresolved, type AdapterUnresolved } from "./phi.js";

export const SHAPE_PRODUCER = "recall_answer_shape_plan";
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const COUNT_CUE = /\bhow many\b/iu;
const DISTINCT_CUE = /\bhow many\s+(?:different|distinct|unique)\b/iu;

export function collectProbeHoles(
  probes: Readonly<RecallQueryProbes>,
  unresolved: AdapterUnresolved[]
): void {
  // Shape overrides must not drop probe-derived count/duration holes.
  const text = probes.normalized_query ?? "";
  const derived = compileRecallAnswerShapePlan(probes);
  if (CJK.test(text) && (derived.shape === "duration" || hasCjkDurationForm(text))) {
    pushUnresolved(unresolved, { code: "unsupported_nesting", source: "probes" });
    pushUnresolved(unresolved, { code: "ambiguous_cjk_segmentation", source: "probes" });
  }
  if (COUNT_CUE.test(text) && !DISTINCT_CUE.test(text)) {
    pushUnresolved(unresolved, { code: "count_sum_unsupported", source: "probes" });
  }
}

export function rejectUnsupportedShape(
  shape: Readonly<RecallAnswerShapePlan>,
  unresolved: AdapterUnresolved[]
): boolean {
  let skip = false;
  if (shape.shape === "count" || shape.shape === "sum") {
    pushUnresolved(unresolved, { code: "count_sum_unsupported", source: "shape" });
    skip = true;
  }
  if (shape.shape === "duration") {
    pushUnresolved(unresolved, { code: "unsupported_nesting", source: "shape" });
    skip = true;
  }
  if (shape.status === "ambiguous") {
    pushUnresolved(unresolved, { code: "conflicting_shape", source: "shape" });
    skip = true;
  }
  if (shape.status === "high_confidence" && shape.relation_terms.length === 0) {
    pushUnresolved(unresolved, { code: "unknown_relation", source: "shape" });
  }
  if (shape.relation_terms.length > 8) {
    pushUnresolved(unresolved, {
      code: "limit_overflow",
      source: "shape",
      detail: "relation_terms"
    });
    skip = true;
  }
  return skip;
}

export function shapeProgram(shape: Readonly<RecallAnswerShapePlan>): {
  readonly predicates: CanonicalPredicateV1[];
  readonly constants: CanonicalConstantV1[];
} {
  const constants = constantsFromTargets(shape.target_terms);
  const arguments_ = [...constants.map((constant) => constant.name), "x0"];
  return {
    constants,
    predicates: shape.relation_terms.map((relation, index) => naryPredicate(
      `shape_rel_${index}`,
      relation,
      arguments_,
      { source_id: "shape.relation_terms", producer: SHAPE_PRODUCER }
    ))
  };
}

function constantsFromTargets(terms: readonly string[]): CanonicalConstantV1[] {
  const seen = new Set<string>();
  const constants: CanonicalConstantV1[] = [];
  for (const term of terms) {
    if (term.length === 0 || term.trim() !== term || seen.has(term)) continue;
    seen.add(term);
    constants.push(Object.freeze({ name: term, sort: "entity" as const, value: term }));
  }
  return constants;
}

function hasCjkDurationForm(text: string): boolean {
  return CJK_COPULAR_MEASURE_FORMS.some((form) =>
    text.includes(form) && isRuleBasedCopularMeasureValue(form)
  );
}
