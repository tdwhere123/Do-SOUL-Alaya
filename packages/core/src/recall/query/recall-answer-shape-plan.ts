import { CJK_COPULAR_MEASURE_FORMS } from
  "../../shared/fact-frame-grammar/cjk-interrogative-forms.js";
import {
  COPULAR_MEASURE_WORDS,
  isRuleBasedCopularMeasureValue
} from "../../shared/fact-frame-grammar/result-slots.js";
import { isRecallScalarRelationTerm } from "./recall-answer-scalar-binding.js";
import {
  splitLexicalTokens,
  type RecallQueryProbes
} from "./recall-query-probes.js";

export type RecallAnswerShape =
  | "place"
  | "duration"
  | "count"
  | "sum"
  | "distinct_entities";

export type RecallAnswerShapeStatus = "high_confidence" | "ambiguous" | "unknown";

export interface RecallAnswerShapePlan {
  readonly schema_version: 1;
  readonly status: RecallAnswerShapeStatus;
  readonly shape: RecallAnswerShape | null;
  readonly target_terms: readonly string[];
  readonly relation_terms: readonly string[];
}

const PLACE_CUE = /\bwhere\b/iu;
// Unit WH ("how many hours/months") is COUNT_CUE; duration is copular-measure only.
const ENGLISH_COPULAR_MEASURE_CUE = new RegExp(
  String.raw`\bhow\s+(?:${[...COPULAR_MEASURE_WORDS].join("|")})\b`,
  "iu"
);
const CJK_COPULAR_MEASURE_CUE = new RegExp(
  [...CJK_COPULAR_MEASURE_FORMS]
    .slice()
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .join("|"),
  "u"
);
const DISTINCT_ENTITIES_CUE = /\bhow many\s+(?:different|distinct|unique)\b/iu;
const SUM_CUE =
  /\bhow much\s+total\b|\btotal\s+(?:money|amount|cost)\b|\b(?:sum|total)\b.{0,32}\b(?:spent|paid|expenses?|costs?)\b/iu;
const COUNT_CUE = /\bhow many\b/iu;

export function resolvePreparedAnswerShapePlan(
  probes: Readonly<RecallQueryProbes>,
  prepared?: Readonly<RecallAnswerShapePlan> | null
): Readonly<RecallAnswerShapePlan> {
  return prepared ?? compileRecallAnswerShapePlan(probes);
}

export function compileRecallAnswerShapePlan(
  probes: Readonly<RecallQueryProbes>
): Readonly<RecallAnswerShapePlan> {
  const text = probes.normalized_query ?? "";
  const shapes = detectAnswerShapes(text);
  if (shapes.length !== 1) {
    return emptyPlan(shapes.length > 1 ? "ambiguous" : "unknown");
  }

  const cueTerms = answerCueTerms(text);
  const relationTerms = probes.lexical_terms.filter(isRecallScalarRelationTerm);
  const targetTerms = probes.lexical_terms.filter(
    (term) => !cueTerms.has(term) && !isRecallScalarRelationTerm(term)
  );
  if (targetTerms.length === 0) {
    return emptyPlan("unknown");
  }

  return Object.freeze({
    schema_version: 1,
    status: "high_confidence",
    shape: shapes[0]!,
    target_terms: Object.freeze([...targetTerms]),
    relation_terms: Object.freeze([...relationTerms])
  });
}

export function recallAnswerShapeSupportsSingleSemanticLeader(
  plan: Readonly<RecallAnswerShapePlan> | null
): boolean {
  return plan?.shape !== "count" &&
    plan?.shape !== "sum" &&
    plan?.shape !== "distinct_entities";
}

function detectAnswerShapes(text: string): readonly RecallAnswerShape[] {
  const shapes: RecallAnswerShape[] = [];
  const durationCue = matchCopularMeasureCue(text);
  if (PLACE_CUE.test(text)) shapes.push("place");
  if (durationCue !== undefined) shapes.push("duration");
  if (DISTINCT_ENTITIES_CUE.test(text)) {
    shapes.push("distinct_entities");
  } else if (SUM_CUE.test(text)) {
    shapes.push("sum");
  } else if (COUNT_CUE.test(text) && durationCue === undefined) {
    shapes.push("count");
  }
  return shapes;
}

function answerCueTerms(text: string): ReadonlySet<string> {
  const fromPatterns = [
    PLACE_CUE,
    DISTINCT_ENTITIES_CUE,
    SUM_CUE,
    COUNT_CUE
  ].flatMap((pattern) => {
    const match = pattern.exec(text)?.[0];
    return match === undefined ? [] : splitLexicalTokens(match);
  });
  const duration = matchCopularMeasureCue(text);
  return new Set(
    duration === undefined
      ? fromPatterns
      : [...fromPatterns, ...splitLexicalTokens(duration)]
  );
}

function matchCopularMeasureCue(text: string): string | undefined {
  const english = text.match(ENGLISH_COPULAR_MEASURE_CUE)?.[0];
  if (english !== undefined && isRuleBasedCopularMeasureValue(english)) return english;
  const cjk = text.match(CJK_COPULAR_MEASURE_CUE)?.[0];
  if (cjk !== undefined && isRuleBasedCopularMeasureValue(cjk)) return cjk;
  return undefined;
}

function emptyPlan(
  status: Exclude<RecallAnswerShapeStatus, "high_confidence">
): Readonly<RecallAnswerShapePlan> {
  return Object.freeze({
    schema_version: 1,
    status,
    shape: null,
    target_terms: Object.freeze([]),
    relation_terms: Object.freeze([])
  });
}
