import { createHash } from "node:crypto";
import {
  OPEN_SEMANTIC_DURATION_ROLE,
  OPEN_SEMANTIC_LOCATION_ROLE
} from "@do-soul/alaya-protocol";
import { OFFICIAL_API_OBJECT_KINDS } from "./object-kind-contract.js";

export const OFFICIAL_API_SIGNAL_CONTRACT_VERSION = 1;

const ENVELOPE_PROMPT_PARTS = Object.freeze([
  "You extract candidate durable memory signals from one bounded source assertion batch.",
  `The response signal contract version is ${OFFICIAL_API_SIGNAL_CONTRACT_VERSION}.`,
  'Return strict JSON only with shape {"signals":[...]} and no markdown.',
  "Do not output analysis or reasoning. Emit the JSON object immediately and keep it compact.",
  "Do not repeat source text outside matched_text or semantic_factor_graph surfaces.",
  'Each non-empty signal must include "object_kind", "confidence", "matched_text", "source_locator", and "semantic_factor_graph".',
  'A signal without semantic_factor_graph is invalid. object_kind is bounded routing metadata only; it is not a semantic role or an ontology.'
]);

const CURRENT_ENVELOPE_PROMPT_PARTS = Object.freeze([
  ...ENVELOPE_PROMPT_PARTS.slice(0, -2),
  'Each non-empty signal must include "object_kind", "confidence", "matched_text", "source_locator", "fact_frame", and "semantic_factor_graph".',
  'A signal without both a complete fact_frame and semantic_factor_graph is invalid. object_kind is bounded routing metadata only; it is not a semantic role or an ontology.'
]);

const HISTORICAL_ENVELOPE_PROMPT_PARTS = Object.freeze([
  "You extract candidate durable memory signals from a single operator turn.",
  'Return strict JSON only with shape {"signals":[...]} and no markdown.',
  'Each signal must include "signal_kind", "object_kind", "confidence", "matched_text", "distilled_fact", and "source_locator".'
]);

const CURRENT_CONFIDENCE_PROMPT_PARTS = Object.freeze([
  '"confidence" must be a JSON number from 0 through 1, never a string label such as "high", "medium", or "low".'
]);

const DURABLE_PROJECTION_PROMPT_PARTS = Object.freeze([
  `"object_kind" must be exactly one of: ${OFFICIAL_API_OBJECT_KINDS.join(", ")}. Use "open_semantic_observation" only when no more specific allowed kind is justified by the assertion.`,
  'Use "preference" for a durable like, dislike, or choice tendency; "decision" for a committed choice; "constraint" or "factual_policy" for a standing must, must-not, or rule; and "episode", "activity", or "outcome" for source-supported events and results.',
  'Include "canonical_entities" with at most 3 lowercase names or stable source phrases that occur in matched_text. Do not infer an alias, identity, or pronoun resolution that is absent from that assertion.',
  'When the assertion explicitly states event time or validity, include "temporal_projection" with "projection_schema_version":1, "time_precision", "time_source":"explicit", and only the applicable ISO fields.',
  'Use "event_time_start" and "event_time_end" for when an event occurred. Use "valid_from" and optional "valid_to" only for an explicitly effective or ongoing interval; omit "valid_to" for an open interval. Never copy event time into valid time.',
  'For relative dates, omit absolute temporal_projection values; the runtime resolves them from the trusted source observation.',
  'For a durable preference, include "preference_profile" with "projection_schema_version":1 and the exact keys "preference_subject", "preference_predicate", "preference_object", optional "preference_category", and "preference_polarity".',
  '"preference_polarity" must be exactly "positive", "negative", or "neutral".'
]);

const GROUNDED_SIGNAL_PROMPT_PARTS = Object.freeze([
  'Do not include "signal_kind"; the runtime derives it deterministically from the bounded object_kind.',
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

export const OPEN_SEMANTIC_STRUCTURAL_ROLE_PROMPT_PARTS = Object.freeze([
  "binding_identity is a concise, relation-local name. Names other than the structural tokens duration and location stay open text; they are not a fixed role list or a cross-graph identity. Use the same name for repeated parallel values of one relation-local binding.",
  `When the argument is a duration measure, binding_identity must be "${OPEN_SEMANTIC_DURATION_ROLE}". When it is a location or place participant, binding_identity must be "${OPEN_SEMANTIC_LOCATION_ROLE}". Other open role names remain allowed.`
]);

export const OPEN_SEMANTIC_FACTOR_COMMON_PROMPT_PARTS = Object.freeze([
  'Each factor is {"factor_id":LOCAL_ID,"surface":EXACT_SUBSTRING,"semantic_identity":CANONICAL_TEXT}; add "source_occurrence":N only when selecting a repeated surface after its first occurrence.',
  'semantic_identity is NFKC lowercase text: use a stable lemma for predicates and a stable source-supported name or phrase for other factors, so morphological variants such as "bought" and "buy" share an identity.',
  "Keep a factor as a whole phrase when finer decomposition would add inference or lose its meaning.",
  'Each proposition is {"proposition_id":LOCAL_ID,"predicate_factor_id":FACTOR_ID,"arguments":[...]}; every argument is {"position":N,"binding_identity":OPEN_NAME,"reference_kind":"factor" or "variable","reference_id":LOCAL_ID}.',
  "Argument positions start at 0 and are contiguous, and preserve the predicate's semantic argument order.",
  ...OPEN_SEMANTIC_STRUCTURAL_ROLE_PROMPT_PARTS,
  "Every factor must be used as a predicate or argument. Reuse one factor in multiple propositions when the same source phrase has the same meaning.",
  "Do not emit alternative, explanatory, or otherwise unused nodes; an unreferenced factor or variable makes the entire graph invalid.",
  "Each factor or variable surface must own a non-overlapping exact source span; never emit a node for text contained inside another emitted node.",
  "Do not emit character spans; the runtime grounds exact surfaces and derives spans.",
  "Do not force facts into subject/relation/value/qualifier/time slots and do not invent entity, event, attribute, or answer-family categories."
]);

const KIND_PROJECTION_PROMPT_PARTS = Object.freeze([
  'Optional independent sibling only: when a source-named instance has a conventional category that is not already a factor surface, you may include "kind_projection":{"factor_id":FACTOR_ID,"kind_values":[KIND]}.',
  "At most two unique kind values. Omit the field when no kind is justified.",
  "Never put kind into semantic_factor_graph. kind_projection is rebuildable routing, not durable truth.",
  "A missing or invalid kind_projection must not change the base graph."
]);

const OPEN_SEMANTIC_FACTOR_PROMPT_PARTS = Object.freeze([
  'Use "semantic_factor_graph":{"schema_version":2,"source_kind":"evidence","factors":[...],"variables":[],"result_variable_ids":[],"propositions":[...]}.',
  'For a single atomic assertion, a valid graph has one predicate factor, every explicit relation participant as an argument, and at least one proposition; never omit the graph or replace it with fact_frame.',
  "Represent every explicit, source-grounded participant of a relation as its own factor argument, preserving the relation's stated arity and semantic order; never collapse a multi-participant relation into a unary proposition.",
  'Example structure only: {"factors":[{"factor_id":"predicate","surface":"give","semantic_identity":"give"},{"factor_id":"participant","surface":"A","semantic_identity":"a"},{"factor_id":"answer","surface":"B","semantic_identity":"b"}],"variables":[],"result_variable_ids":[],"propositions":[{"proposition_id":"relation","predicate_factor_id":"predicate","arguments":[{"position":0,"binding_identity":"giver","reference_kind":"factor","reference_id":"participant"},{"position":1,"binding_identity":"recipient","reference_kind":"factor","reference_id":"answer"}]}]}.',
  "Do not emit variables in evidence graphs.",
  ...OPEN_SEMANTIC_FACTOR_COMMON_PROMPT_PARTS
]);

const CURRENT_OPEN_SEMANTIC_FACTOR_PROMPT_PARTS = Object.freeze([
  ...OPEN_SEMANTIC_FACTOR_PROMPT_PARTS,
  'fact_frame and semantic_factor_graph must describe the same complete proposition: one relation/predicate and every explicit participant in identical argument order; never omit either representation.'
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

const HISTORICAL_PROMPT_C3D83273 = joinPrompt([
  ...ENVELOPE_PROMPT_PARTS,
  ...CURRENT_CONFIDENCE_PROMPT_PARTS,
  ...GROUNDED_SIGNAL_PROMPT_PARTS,
  ...DURABLE_PROJECTION_PROMPT_PARTS,
  ...OPEN_SEMANTIC_FACTOR_PROMPT_PARTS,
  ...FINAL_PROMPT_PARTS
]);
const HISTORICAL_PROMPT_C3D83273_SHA256 =
  "c3d8327375c4942e4fbe66c4c3173780dc329cd3afc513e7e7c18af7651646f8";

const HISTORICAL_PROMPT_785CBDCC = joinPrompt([
  ...ENVELOPE_PROMPT_PARTS,
  ...CURRENT_CONFIDENCE_PROMPT_PARTS,
  ...GROUNDED_SIGNAL_PROMPT_PARTS,
  ...DURABLE_PROJECTION_PROMPT_PARTS,
  ...OPEN_SEMANTIC_FACTOR_PROMPT_PARTS,
  ...KIND_PROJECTION_PROMPT_PARTS,
  ...FINAL_PROMPT_PARTS
]);
const HISTORICAL_PROMPT_785CBDCC_SHA256 =
  "785cbdcc8645424b94cb9ed030508bf66413258b38fb05236e98ed979e83acac";

export const OFFICIAL_API_SYSTEM_PROMPT = joinPrompt([
  ...CURRENT_ENVELOPE_PROMPT_PARTS,
  ...CURRENT_CONFIDENCE_PROMPT_PARTS,
  ...GROUNDED_SIGNAL_PROMPT_PARTS,
  ...DURABLE_PROJECTION_PROMPT_PARTS,
  ...CURRENT_OPEN_SEMANTIC_FACTOR_PROMPT_PARTS,
  ...KIND_PROJECTION_PROMPT_PARTS,
  ...FINAL_PROMPT_PARTS
]);

export const OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT = joinPrompt([
  OFFICIAL_API_SYSTEM_PROMPT,
  "This is a coverage repair request containing exactly one source_assertions entry that produced no valid candidate in the primary extraction.",
  "Re-evaluate that assertion independently and preserve every durable source-supported detail if it qualifies.",
  "A bare topic, search phrase, title, or information request is not a durable assertion; return an empty signals array for it.",
  "The repair pass does not lower the durability threshold; return an empty signals array when the assertion is not durable."
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
  if (sha256(HISTORICAL_PROMPT_C3D83273) !== HISTORICAL_PROMPT_C3D83273_SHA256) {
    throw new Error("historical official API system prompt identity drifted");
  }
  if (sha256(HISTORICAL_PROMPT_785CBDCC) !== HISTORICAL_PROMPT_785CBDCC_SHA256) {
    throw new Error("historical official API system prompt identity drifted");
  }
  return new Map([
    [currentSha256, OFFICIAL_API_SYSTEM_PROMPT],
    [
      sha256(OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT),
      OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT
    ],
    [HISTORICAL_PROMPT_5EC274_SHA256, HISTORICAL_PROMPT_5EC274],
    [HISTORICAL_PROMPT_C3D83273_SHA256, HISTORICAL_PROMPT_C3D83273],
    [HISTORICAL_PROMPT_785CBDCC_SHA256, HISTORICAL_PROMPT_785CBDCC]
  ]);
}

function joinPrompt(parts: readonly string[]): string {
  return parts.join(" ");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
