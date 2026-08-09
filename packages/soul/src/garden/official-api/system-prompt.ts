import { createHash } from "node:crypto";

const ENVELOPE_PROMPT_PARTS = Object.freeze([
  "You extract candidate durable memory signals from one bounded source assertion batch.",
  'Return strict JSON only with shape {"signals":[...]} and no markdown.',
  'Each non-empty signal must include "signal_kind", "object_kind", "confidence", "matched_text", "source_locator", and "semantic_factor_graph".',
  'A signal without semantic_factor_graph is invalid. signal_kind and object_kind are routing metadata only; they are not semantic roles or an ontology.'
]);

const HISTORICAL_ENVELOPE_PROMPT_PARTS = Object.freeze([
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
  "The server-derived source_assertions catalog contains only User assertions the runtime can ground without unresolved references; no other conversation content is available or authoritative.",
  "For each signal, work quote-first, then distill.",
  "First copy the shortest contiguous exact substring that contains the complete atomic assertion and every explicit local antecedent needed to resolve its references into matched_text; preserve capitalization, punctuation, spacing, and wording.",
  "Then represent only what that quote entails in semantic_factor_graph.",
  "Do not use surrounding text to add facts or guess unresolved references.",
  "Do not return an empty signals array merely because a durable assertion uses narrative, list, template, or conversational wording.",
  "Before returning an empty signals array for a non-empty source_assertions catalog, inspect every catalog entry once more and emit any durable personal fact, preference, relationship, possession, past event, or ongoing condition that satisfies the same grounding and durability rules.",
  "Do not lower the durability threshold: transient tasks, procedures, and formatting instructions are not durable assertions unless they explicitly state a lasting preference or policy.",
  '"matched_text" is an exact verbatim substring containing the complete atomic assertion, not isolated keywords.',
  'When a synthesis signal cites existing evidence or memories by ID, include "evidence_refs" and "source_memory_refs" arrays.'
]);

const HISTORICAL_GROUNDED_SIGNAL_PROMPT_PARTS = Object.freeze([
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

export const OPEN_SEMANTIC_FACTOR_COMMON_PROMPT_PARTS = Object.freeze([
  'Each factor is {"factor_id":LOCAL_ID,"surface":EXACT_SUBSTRING,"semantic_identity":CANONICAL_TEXT}; add "source_occurrence":N only when selecting a repeated surface after its first occurrence.',
  'semantic_identity is NFKC lowercase text: use a stable lemma for predicates and a stable source-supported name or phrase for other factors, so morphological variants such as "bought" and "buy" share an identity.',
  "Keep a factor as a whole phrase when finer decomposition would add inference or lose its meaning.",
  'Each proposition is {"proposition_id":LOCAL_ID,"predicate_factor_id":FACTOR_ID,"arguments":[...]}; every argument is {"position":N,"binding_identity":OPEN_NAME,"reference_kind":"factor" or "variable","reference_id":LOCAL_ID}.',
  "Argument positions start at 0 and are contiguous. binding_identity is a concise, relation-local canonical name; it is open text, not a fixed role list.",
  "Every factor must be used as a predicate or argument. Reuse one factor in multiple propositions when the same source phrase has the same meaning.",
  "Do not emit alternative, explanatory, or otherwise unused factors; an unreferenced factor has no graph meaning and is discarded.",
  "Do not emit character spans; the runtime grounds exact surfaces and derives spans.",
  "Do not force facts into subject/relation/value/qualifier/time slots and do not invent entity, event, attribute, or answer-family categories."
]);

const OPEN_SEMANTIC_FACTOR_PROMPT_PARTS = Object.freeze([
  'Use "semantic_factor_graph":{"schema_version":1,"source_kind":"evidence","factors":[...],"variables":[],"result_variable_ids":[],"propositions":[...]}.',
  'For a single atomic assertion, a minimal valid graph still has one predicate factor, one argument factor, and one proposition; never omit the graph or replace it with fact_frame.',
  'Example structure only: {"factors":[{"factor_id":"f0","surface":"A","semantic_identity":"a"},{"factor_id":"f1","surface":"B","semantic_identity":"b"}],"variables":[],"result_variable_ids":[],"propositions":[{"proposition_id":"p0","predicate_factor_id":"f0","arguments":[{"position":0,"binding_identity":"argument","reference_kind":"factor","reference_id":"f1"}]}]}.',
  "Do not emit variables in evidence graphs.",
  ...OPEN_SEMANTIC_FACTOR_COMMON_PROMPT_PARTS
]);

const FINAL_PROMPT_PARTS = Object.freeze([
  "Inspect each source_assertions entry independently; the batch contains no hidden context and every assertion_id keeps its original catalog identity.",
  "Keep pronouns unresolved unless their antecedent is explicit inside the selected catalog assertion.",
  "Preserve relative-date meaning as source-supported factors; never infer an absolute date absent from the assertion.",
  "Preserve every concrete detail (names, numbers, dates, places) that appears in the selected catalog assertion.",
  "Do not invent facts or summarize away detail. Split independent durable assertions into separate signals, but keep dependent propositions together in one graph.",
  'Return {"signals":[]} when the catalog does not contain durable memory candidates.'
]);

const HISTORICAL_FINAL_PROMPT_PARTS = Object.freeze([
  'Include "canonical_entities": an array of at most 3 lowercase canonical names for the entities or subjects the distilled_fact is about, resolving pronouns and aliases so the SAME real-world entity always yields the SAME string across turns.',
  "Resolve pronouns and non-temporal references in distilled_fact using only the turn text.",
  "Preserve relative-date wording exactly; never infer an absolute date absent from the turn text.",
  "Preserve every concrete detail (names, numbers, dates, places) that appears in the turn.",
  "Do not invent facts and do not summarize away detail; split compound statements into separate signals.",
  'Return {"signals":[]} when the turn does not contain durable memory candidates.'
]);

const HISTORICAL_PROMPT_5EC274 = joinPrompt([
  ...HISTORICAL_ENVELOPE_PROMPT_PARTS,
  ...HISTORICAL_GROUNDED_SIGNAL_PROMPT_PARTS,
  ...HISTORICAL_FINAL_PROMPT_PARTS
]);
const HISTORICAL_PROMPT_5EC274_SHA256 =
  "5ec2740bd63923305b376b240d5a219383f3cbfe8a7d9198d504f7f8de542326";

export const OFFICIAL_API_SYSTEM_PROMPT = joinPrompt([
  ...ENVELOPE_PROMPT_PARTS,
  ...CURRENT_CONFIDENCE_PROMPT_PARTS,
  ...GROUNDED_SIGNAL_PROMPT_PARTS,
  ...OPEN_SEMANTIC_FACTOR_PROMPT_PARTS,
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
