import { MemoryDimension } from "@do-soul/alaya-protocol";
import { parseRelativeTemporalTerm } from "@do-soul/alaya-graph-algorithms";
import type { RecallQueryProbes } from "./recall-query-probes.js";

export type RecallQueryIntent =
  | "single_fact"
  | "multi_fact"
  | "list"
  | "temporal"
  | "preference"
  | "knowledge_update";

const UPDATE_CUE =
  /\b(originally|now|currently|changed?|changes|updated?|switch(?:ed)?|no longer|后来|改成|原来|现在)\b/iu;
const TEMPORAL_CUE =
  /\b(before|after|since|until|earlier|later|ago|when|date|time|year|month|day)\b|(?:之前|之后|先前|最近|何时|什么时候|日期|时间|哪年|哪月|哪天)/iu;
const LIST_CUE = /\b(list|which|what were|all|both|each|哪些|列出|都有)\b/iu;
const COORDINATION_CUE = /\b(and|both|每|各|分别|以及)\b/iu;
const PREFERENCE_CUE =
  /\b(prefer|preferred|favou?rite|like|likes|avoid|usually|喜欢|偏好|倾向)\b/iu;
// Recommendation/advice collocations stay single_fact so they cannot hijack preference routing.
const EXTENDED_PREFERENCE_CUE =
  /\b(?:recommend(?:ations?|ed|s)?|suggest(?:ions?|ed|s)?|advice|advise|go-to|help me (?:find|pick|choose|decide)|what should i|which\b.{0,40}\bshould i)\b|推荐|建议/iu;

export function classifyRecallIntent(probes: Readonly<RecallQueryProbes>): RecallQueryIntent {
  const text = probes.normalized_query ?? "";
  if (UPDATE_CUE.test(text)) return "knowledge_update";
  if (EXTENDED_PREFERENCE_CUE.test(text)) return "single_fact";
  // Preference outranks list and coordination: "which X do I prefer" is a
  // preference lookup, while a coordinated preference is a word-gap problem.
  if (probes.dimensions.includes(MemoryDimension.PREFERENCE) ||
    PREFERENCE_CUE.test(text)) {
    return "preference";
  }
  if (LIST_CUE.test(text)) return "list";
  if (hasOpenTemporalCue(probes, text)) return "temporal";
  if (COORDINATION_CUE.test(text) && probes.lexical_terms.length >= 4) return "multi_fact";
  return "single_fact";
}

function hasOpenTemporalCue(
  probes: Readonly<RecallQueryProbes>,
  text: string
): boolean {
  return TEMPORAL_CUE.test(text) || probes.date_terms.some(
    (term) => isTemporalIntentTerm(term)
  );
}

function isTemporalIntentTerm(term: string): boolean {
  const parsed = parseRelativeTemporalTerm(term);
  if (parsed === null) return false;
  return parsed.kind !== "offset" || parsed.unit !== "day" || parsed.amount !== 0;
}

export function hasTemporalQuerySignal(
  probes: Readonly<RecallQueryProbes>,
  intent: RecallQueryIntent = classifyRecallIntent(probes)
): boolean {
  return probes.date_terms.length > 0 || intent === "temporal" || intent === "knowledge_update";
}
