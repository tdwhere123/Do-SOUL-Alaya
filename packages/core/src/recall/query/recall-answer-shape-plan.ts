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
const DURATION_CUE =
  /\bhow long\b|\bhow many\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b/iu;
const DISTINCT_ENTITIES_CUE = /\bhow many\s+(?:different|distinct|unique)\b/iu;
const SUM_CUE =
  /\bhow much\s+total\b|\btotal\s+(?:money|amount|cost)\b|\b(?:sum|total)\b.{0,32}\b(?:spent|paid|expenses?|costs?)\b/iu;
const COUNT_CUE = /\bhow many\b/iu;

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
  if (PLACE_CUE.test(text)) shapes.push("place");
  if (DURATION_CUE.test(text)) shapes.push("duration");
  if (DISTINCT_ENTITIES_CUE.test(text)) {
    shapes.push("distinct_entities");
  } else if (SUM_CUE.test(text)) {
    shapes.push("sum");
  } else if (COUNT_CUE.test(text) && !DURATION_CUE.test(text)) {
    shapes.push("count");
  }
  return shapes;
}

function answerCueTerms(text: string): ReadonlySet<string> {
  const patterns = [
    PLACE_CUE,
    DURATION_CUE,
    DISTINCT_ENTITIES_CUE,
    SUM_CUE,
    COUNT_CUE
  ];
  return new Set(patterns.flatMap((pattern) => {
    const match = pattern.exec(text)?.[0];
    return match === undefined ? [] : splitLexicalTokens(match);
  }));
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
