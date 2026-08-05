import { createHash } from "node:crypto";

const ENVELOPE_PROMPT_PARTS = Object.freeze([
  "You extract candidate durable memory signals from a single operator turn.",
  'Return strict JSON only with shape {"signals":[...]} and no markdown.',
  'Each signal must include "signal_kind", "object_kind", "confidence", "matched_text", "distilled_fact", and "source_locator".'
]);

const CURRENT_CONFIDENCE_PROMPT_PARTS = Object.freeze([
  '"confidence" must be a JSON number from 0 through 1, never a string label such as "high", "medium", or "low".'
]);

const GROUNDED_SIGNAL_PROMPT_PARTS = Object.freeze([
  'Use only supported signal kinds such as "potential_preference" and "potential_claim".',
  'Use "source_locator":{"contract_version":2,"kind":"assertion_catalog","assertion_id":N} for every signal.',
  "Return only assertion_id from the provided source_assertions catalog for evidence selection; never invent or rewrite a catalog assertion.",
  "Only User source spans may support durable memory; server-derived source_assertions contain only User content, and source_assertions contain only assertions the runtime can ground without unresolved references. Assistant spans are context only and never appear in source_assertions.",
  "For each signal, work quote-first, then distill.",
  "First copy the shortest contiguous exact substring that contains the complete atomic assertion and every explicit local antecedent needed to resolve its references into matched_text; preserve capitalization, punctuation, spacing, and wording.",
  "Then write distilled_fact using only what that quote entails.",
  "Do not use surrounding text to add facts or guess unresolved references.",
  "Do not return an empty signals array merely because a durable assertion uses narrative, list, template, or conversational wording.",
  "Before returning an empty signals array for a non-empty source_assertions catalog, inspect every catalog entry once more and emit any durable personal fact, preference, relationship, possession, past event, or ongoing condition that satisfies the same grounding and durability rules.",
  "Do not lower the durability threshold: transient tasks, procedures, and formatting instructions are not durable assertions unless they explicitly state a lasting preference or policy.",
  '"matched_text" is an exact verbatim substring containing the complete atomic assertion, not isolated keywords.',
  '"distilled_fact" must be a self-contained declarative sentence carrying exactly one assertion.',
  'When a synthesis signal cites existing evidence or memories by ID, include "evidence_refs" and "source_memory_refs" arrays.',
  'When a signal has an event or valid-time fact, include optional "temporal_projection" with "projection_schema_version":1, ISO "event_time_start"/"event_time_end", ISO "valid_from"/"valid_to", "time_precision", and "time_source".',
  "For relative dates, omit absolute temporal_projection dates; the runtime resolves them from source observation.",
  'When a signal is a durable preference, include optional "preference_profile" with "projection_schema_version":1, "subject", "predicate", "object", "category", and "polarity".'
]);

const CURRENT_FACT_FRAME_PROMPT_PARTS = Object.freeze([
  'For every atomic fact that can be decomposed without inference, include "fact_frame":{"schema_version":1,"slots":[...]}.',
  'Fact-frame slots use only roles "subject", "relation", "value", "qualifier", or "time"; include subject, relation, and value, keep source order, and copy every slot text as an exact non-overlapping substring of matched_text.',
  "The fact frame is a routing index over the assertion, not a rewrite: omit it when exact source slots cannot express the fact."
]);

const FINAL_PROMPT_PARTS = Object.freeze([
  'Include "canonical_entities": an array of at most 3 lowercase canonical names for the entities or subjects the distilled_fact is about, resolving pronouns and aliases so the SAME real-world entity always yields the SAME string across turns.',
  "Resolve pronouns and non-temporal references in distilled_fact using only the turn text.",
  "Preserve relative-date wording exactly; never infer an absolute date absent from the turn text.",
  "Preserve every concrete detail (names, numbers, dates, places) that appears in the turn.",
  "Do not invent facts and do not summarize away detail; split compound statements into separate signals.",
  'Return {"signals":[]} when the turn does not contain durable memory candidates.'
]);

const HISTORICAL_PROMPT_5EC274 = joinPrompt([
  ...ENVELOPE_PROMPT_PARTS,
  ...GROUNDED_SIGNAL_PROMPT_PARTS,
  ...FINAL_PROMPT_PARTS
]);
const HISTORICAL_PROMPT_5EC274_SHA256 =
  "5ec2740bd63923305b376b240d5a219383f3cbfe8a7d9198d504f7f8de542326";

export const OFFICIAL_API_SYSTEM_PROMPT = joinPrompt([
  ...ENVELOPE_PROMPT_PARTS,
  ...CURRENT_CONFIDENCE_PROMPT_PARTS,
  ...GROUNDED_SIGNAL_PROMPT_PARTS,
  ...CURRENT_FACT_FRAME_PROMPT_PARTS,
  ...FINAL_PROMPT_PARTS
]);

const SYSTEM_PROMPTS_BY_SHA256 = createPromptRegistry();

/** Frozen snapshot verification resolves its own prompt instead of current code state. */
export function resolveOfficialApiSystemPrompt(
  systemPromptSha256: string
): string | undefined {
  return SYSTEM_PROMPTS_BY_SHA256.get(systemPromptSha256);
}

function createPromptRegistry(): ReadonlyMap<string, string> {
  const currentSha256 = sha256(OFFICIAL_API_SYSTEM_PROMPT);
  if (sha256(HISTORICAL_PROMPT_5EC274) !== HISTORICAL_PROMPT_5EC274_SHA256) {
    throw new Error("historical official API system prompt identity drifted");
  }
  return new Map([
    [currentSha256, OFFICIAL_API_SYSTEM_PROMPT],
    [HISTORICAL_PROMPT_5EC274_SHA256, HISTORICAL_PROMPT_5EC274]
  ]);
}

function joinPrompt(parts: readonly string[]): string {
  return parts.join(" ");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
