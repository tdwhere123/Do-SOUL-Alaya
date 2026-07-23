import type { RecallQueryProbes } from "./recall-query-probes.js";

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

const ANSWER_OPERATOR_TERMS = new Set([
  "am",
  "are",
  "be",
  "been",
  "being",
  "can",
  "could",
  "did",
  "do",
  "does",
  "where",
  "how",
  "long",
  "many",
  "much",
  "total",
  "money",
  "amount",
  "cost",
  "different",
  "distinct",
  "unique",
  "current",
  "favorite",
  "favourite",
  "first",
  "last",
  "local",
  "new",
  "previous",
  "second",
  "seconds",
  "minute",
  "minutes",
  "hour",
  "hours",
  "day",
  "days",
  "week",
  "weeks",
  "month",
  "months",
  "year",
  "years",
  "may",
  "might",
  "should",
  "was",
  "were",
  "will",
  "would"
]);

const RELATION_TERMS = new Set([
  "attend",
  "attended",
  "assemble",
  "assembled",
  "bought",
  "buy",
  "collect",
  "collected",
  "complete",
  "completed",
  "cost",
  "costs",
  "have",
  "live",
  "lived",
  "marinate",
  "marinated",
  "meet",
  "met",
  "move",
  "moved",
  "own",
  "paid",
  "pay",
  "redeem",
  "redeemed",
  "spend",
  "spent",
  "take",
  "took",
  "visit",
  "visited",
  "wait",
  "waited"
]);

export function compileRecallAnswerShapePlan(
  probes: Readonly<RecallQueryProbes>
): Readonly<RecallAnswerShapePlan> {
  const text = probes.normalized_query ?? "";
  const shapes = detectAnswerShapes(text);
  if (shapes.length !== 1) {
    return emptyPlan(shapes.length > 1 ? "ambiguous" : "unknown");
  }

  const relationTerms = probes.lexical_terms.filter((term) => RELATION_TERMS.has(term));
  const targetTerms = probes.lexical_terms.filter(
    (term) => !ANSWER_OPERATOR_TERMS.has(term) && !RELATION_TERMS.has(term)
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
