import type { MemoryEntry, RecallCandidate } from "@do-soul/alaya-protocol";
import type {
  RecallAnswerShape,
  RecallAnswerShapePlan
} from "./recall-answer-shape-plan.js";
import { splitLexicalTokens } from "./recall-query-probes.js";

export type RecallCandidateAnswerSupportStatus =
  | "compatible"
  | "value_only"
  | "unsupported"
  | "observation_only"
  | "ineligible";

export interface RecallCandidateAnswerSupport {
  readonly schema_version: 1;
  readonly shape: RecallAnswerShape;
  readonly status: RecallCandidateAnswerSupportStatus;
  readonly eligible: boolean;
  readonly value_supported: boolean;
  readonly target_supported: boolean;
  readonly relation_supported: boolean;
  readonly matched_target_terms: readonly string[];
  readonly matched_relation_terms: readonly string[];
}

const PLACE_VALUE_CUE =
  /\b(?:from|at|in|near|by|inside|outside|located\s+in|based\s+in)\s+(?:the\s+)?[\p{L}\p{N}]/iu;
const DURATION_VALUE_CUE =
  /\b(?:(?:over|under|about|around|nearly|more\s+than|less\s+than)\s+)?(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|a|an|half)\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b/iu;

const RELATION_ALIASES: readonly ReadonlySet<string>[] = [
  new Set(["buy", "bought", "purchase", "purchased", "from"]),
  new Set(["wait", "waited", "waiting"]),
  new Set(["attend", "attended", "visit", "visited"]),
  new Set(["live", "lived", "located", "based"]),
  new Set(["meet", "met"]),
  new Set(["redeem", "redeemed"]),
  new Set(["spend", "spent", "pay", "paid", "cost", "costs"])
];

export function buildRecallCandidateAnswerSupport(
  plan: Readonly<RecallAnswerShapePlan>,
  entry: Readonly<MemoryEntry>,
  objectKind: RecallCandidate["object_kind"]
): Readonly<RecallCandidateAnswerSupport> | null {
  if (plan.status !== "high_confidence" || plan.shape === null) return null;
  const eligible = objectKind === "memory_entry" && entry.evidence_refs.length > 0;
  if (!eligible) return emptySupport(plan.shape, "ineligible", false);
  if (isAggregateShape(plan.shape)) {
    return emptySupport(plan.shape, "observation_only", true);
  }

  const contentTokens = new Set(splitLexicalTokens(entry.content));
  const matchedTargetTerms = plan.target_terms.filter((term) => contentTokens.has(term));
  const matchedRelationTerms = matchRelationTerms(plan.relation_terms, contentTokens);
  const valueSupported = supportsScalarValue(plan.shape, entry.content);
  const targetSupported = matchedTargetTerms.length > 0;
  const relationSupported =
    plan.relation_terms.length === 0 || matchedRelationTerms.length > 0;
  const status = valueSupported && targetSupported && relationSupported
    ? "compatible"
    : valueSupported ? "value_only" : "unsupported";
  return freezeSupport({
    shape: plan.shape,
    status,
    eligible,
    valueSupported,
    targetSupported,
    relationSupported,
    matchedTargetTerms,
    matchedRelationTerms
  });
}

function matchRelationTerms(
  relationTerms: readonly string[],
  contentTokens: ReadonlySet<string>
): readonly string[] {
  return relationTerms.filter((term) => {
    if (contentTokens.has(term)) return true;
    const family = RELATION_ALIASES.find((aliases) => aliases.has(term));
    return family !== undefined && [...family].some((alias) => contentTokens.has(alias));
  });
}

function supportsScalarValue(shape: RecallAnswerShape, content: string): boolean {
  if (shape === "place") return PLACE_VALUE_CUE.test(content);
  if (shape === "duration") return DURATION_VALUE_CUE.test(content);
  return false;
}

function isAggregateShape(shape: RecallAnswerShape): boolean {
  return shape === "count" || shape === "sum" || shape === "distinct_entities";
}

function emptySupport(
  shape: RecallAnswerShape,
  status: "observation_only" | "ineligible",
  eligible: boolean
): Readonly<RecallCandidateAnswerSupport> {
  return freezeSupport({
    shape,
    status,
    eligible,
    valueSupported: false,
    targetSupported: false,
    relationSupported: false,
    matchedTargetTerms: [],
    matchedRelationTerms: []
  });
}

function freezeSupport(input: Readonly<{
  shape: RecallAnswerShape;
  status: RecallCandidateAnswerSupportStatus;
  eligible: boolean;
  valueSupported: boolean;
  targetSupported: boolean;
  relationSupported: boolean;
  matchedTargetTerms: readonly string[];
  matchedRelationTerms: readonly string[];
}>): Readonly<RecallCandidateAnswerSupport> {
  return Object.freeze({
    schema_version: 1,
    shape: input.shape,
    status: input.status,
    eligible: input.eligible,
    value_supported: input.valueSupported,
    target_supported: input.targetSupported,
    relation_supported: input.relationSupported,
    matched_target_terms: Object.freeze([...input.matchedTargetTerms]),
    matched_relation_terms: Object.freeze([...input.matchedRelationTerms])
  });
}
