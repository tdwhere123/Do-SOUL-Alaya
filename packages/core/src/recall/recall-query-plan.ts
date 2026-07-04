import { MemoryDimension } from "@do-soul/alaya-protocol";
import { recallIntentV2Enabled } from "../config/recall-env-access.js";
import type { RecallQueryProbes } from "./recall-query-probes.js";

export type RecallQueryIntent =
  | "single_fact"
  | "multi_fact"
  | "list"
  | "temporal"
  | "preference"
  | "knowledge_update";

export interface RecallQueryAnchors {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

const UPDATE_CUE =
  /\b(originally|now|currently|changed?|changes|updated?|switch(?:ed)?|no longer|后来|改成|原来|现在)\b/iu;
const TEMPORAL_CUE =
  /\b(before|after|since|until|earlier|later|first|last|ago|之前|之后|先前|最近)\b/iu;
const LIST_CUE = /\b(list|which|what were|all|both|each|哪些|列出|都有)\b/iu;
const COORDINATION_CUE = /\b(and|both|每|各|分别|以及)\b/iu;
const PREFERENCE_CUE =
  /\b(prefer|preferred|favou?rite|like|likes|avoid|usually|喜欢|偏好|倾向)\b/iu;
// Flag-gated recommendation/advice collocations; each requires a preference-bearing phrase, not a bare verb, so single_fact lookups are untouched.
const EXTENDED_PREFERENCE_CUE =
  /\b(?:recommend(?:ations?|ed|s)?|suggest(?:ions?|ed|s)?|advice|advise|go-to|help me (?:find|pick|choose|decide)|what should i|which\b.{0,40}\bshould i)\b|推荐|建议/iu;

function intentV2Enabled(): boolean {
  return recallIntentV2Enabled();
}

export function classifyRecallIntent(probes: Readonly<RecallQueryProbes>): RecallQueryIntent {
  const text = probes.normalized_query ?? "";
  const extendedPreference = intentV2Enabled() && EXTENDED_PREFERENCE_CUE.test(text);
  if (UPDATE_CUE.test(text)) return "knowledge_update";
  if (probes.date_terms.length >= 2 || TEMPORAL_CUE.test(text)) return "temporal";
  // Extended preference cues outrank list so "which X should I pick" reads as a recommendation, not an enumeration.
  if (extendedPreference) return "preference";
  if (LIST_CUE.test(text)) return "list";
  // Preference wins over coordination: a coordinated preference query is a word-gap problem, not a multi-fact split.
  if (probes.dimensions.includes(MemoryDimension.PREFERENCE) || PREFERENCE_CUE.test(text)) {
    return "preference";
  }
  if (COORDINATION_CUE.test(text) && probes.lexical_terms.length >= 4) return "multi_fact";
  return "single_fact";
}

// Intents whose golds spread across independent facts; per-anchor reserved quota stops the first anchor from crowding the rest out.
export function intentSplitsByAnchor(intent: RecallQueryIntent): boolean {
  return (
    intent === "multi_fact" ||
    intent === "list" ||
    intent === "temporal" ||
    intent === "knowledge_update"
  );
}

const ANCHOR_REQUIRED_CAP = 8;
const ANCHOR_OPTIONAL_CAP = 16;

// A long or structurally-marked content word is a deterministic low-DF proxy.
function isStrongLexicalAnchor(term: string): boolean {
  return term.length >= 6 || /[\d_-]/u.test(term);
}

export function extractRecallAnchors(probes: Readonly<RecallQueryProbes>): RecallQueryAnchors {
  const structural = unique([
    ...probes.object_ids,
    ...probes.evidence_refs,
    ...probes.run_ids,
    ...probes.surface_ids,
    ...probes.file_paths,
    ...probes.package_names,
    ...probes.task_refs,
    ...probes.date_terms,
    ...probes.phrases
  ]);
  let lexicalAnchors = probes.lexical_terms.filter(isStrongLexicalAnchor);
  if (lexicalAnchors.length === 0 && probes.lexical_terms.length > 0) {
    // Keep the lane firing on plain queries: the longest term is the rarest.
    lexicalAnchors = [...probes.lexical_terms].sort((a, b) => b.length - a.length).slice(0, 1);
  }
  const required = unique([...structural, ...lexicalAnchors]).slice(0, ANCHOR_REQUIRED_CAP);
  const requiredSet = new Set(required);
  const optional = unique([...probes.lexical_terms, ...probes.expanded_terms])
    .filter((term) => !requiredSet.has(term))
    .slice(0, ANCHOR_OPTIONAL_CAP);
  return { required, optional };
}

function unique(tokens: readonly string[]): readonly string[] {
  return [...new Set(tokens.map((token) => token.trim()).filter((token) => token.length > 0))];
}
