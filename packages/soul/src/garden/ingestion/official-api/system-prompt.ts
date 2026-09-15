import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OPEN_SEMANTIC_DURATION_ROLE,
  OPEN_SEMANTIC_LOCATION_ROLE,
  SOURCE_INTERPRETATION_CONTRACT
} from "@do-soul/alaya-protocol";
import { OFFICIAL_API_GROUNDED_EXAMPLES } from "./source-examples.js";

const ENVELOPE_PROMPT_PARTS = Object.freeze([
  "You extract source-supported interpretation candidates from one bounded source assertion batch.",
  `The response interpretation contract is ${SOURCE_INTERPRETATION_CONTRACT}.`,
  'Return strict JSON only with shape {"interpretations":[...]} and no markdown.',
  "Do not output analysis or reasoning. Emit the JSON object immediately and keep it compact.",
  "Do not repeat source text outside predicate, argument, and qualifier phrases."
]);

const INTERPRETATION_PROMPT_PARTS = Object.freeze([
  'Each interpretation is {"assertion_id":N,"relations":[...]}.',
  "Return only assertion_id from the provided source_assertions catalog; never invent or rewrite a catalog assertion.",
  "The server-derived source_assertions catalog contains only User assertions the runtime can ground without unresolved references; no other conversation content is available or authoritative.",
  'Each relation is {"predicate":{"text":EXACT_SUBSTRING},"arguments":[...],"qualifiers":[...]}.',
  'Each argument or qualifier is {"role":OPEN_NAME,"phrase":{"text":EXACT_SUBSTRING}}.',
  'For any repeated exact substring, add zero-based "occurrence":N on the phrase, including "occurrence":0 for the first match.',
  "Copy exact source wording, capitalization, punctuation, and spacing in every phrase.",
  "Roles are model interpretations of source attachment, not ontology types, persistence kinds, or certified facts.",
  "Do not emit confidence, object_kind, signal_kind, matched_text, source_locator, identity_observation, temporal_projection, preference_profile, ISO timestamps, graph ids, or semantic_identity.",
  "IDs, spans, schema versions, and interval arithmetic are runtime responsibilities."
]);

const SCOPE_PROMPT_PARTS = Object.freeze([
  "Inspect each source_assertions entry independently; the batch contains no hidden context and every assertion_id keeps its original catalog identity.",
  "Keep pronouns unresolved unless their antecedent is explicit inside the selected catalog assertion.",
  'Unresolved does not mean omitted: an explicit "I" remains an argument or qualifier phrase with text "I"; do not rename it to an inferred person or silently drop it.',
  "Preserve relative-date meaning as source-supported phrases; never infer an absolute date absent from the assertion.",
  "Preserve every concrete detail (names, numbers, dates, places) that appears in the selected catalog assertion.",
  "Do not invent facts or summarize away detail. Split only demonstrably independent assertions into separate interpretations.",
  "Preserve each selected relation's participants, modality, time, and conditions as arguments or qualifiers.",
  "Preserve role: do not invent an agent, speaker, promiser, or intention actor that the quote does not state.",
  "Do not assign a product, object, or theme as promiser or speaker.",
  "Keep not, only, if, unless, and promise markers as exact phrases; never drop them to make a simpler claim.",
  "When a nested or conditional span cannot be independently grounded, keep the complete adjunct as one opaque qualifier phrase.",
  "Do not force facts into subject/relation/value/qualifier/time slots.",
  "The catalog is a source inventory, not a claim that every entry deserves a memory. Omit questions, one-off requests, roleplay and invented scenarios. Do not turn an instruction to the assistant into the user's standing policy or preference.",
  "Do not return an empty interpretations array merely because a durable assertion uses narrative, list, template, or conversational wording.",
  "Before returning an empty interpretations array for a non-empty source_assertions catalog, inspect every catalog entry once more and emit any source-supported relation that satisfies the same grounding and durability rules.",
  "Do not lower the durability threshold: transient tasks, procedures, and formatting instructions are not durable assertions unless they explicitly state a lasting preference or policy.",
  'Return {"interpretations":[]} when the catalog does not contain durable memory candidates.'
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
  "predicate_factor_id and factor reference_id must name existing factor_id values, never proposition_id values. An action is not its own actor: retain the explicitly stated speaker or participant instead of using the predicate or its object as a substitute.",
  "Do not emit alternative, explanatory, or otherwise unused nodes; an unreferenced factor or variable makes the entire graph invalid.",
  "Each factor or variable surface must own a non-overlapping exact source span; never emit a node for text contained inside another emitted node.",
  "Do not emit character spans; the runtime grounds exact surfaces and derives spans.",
  "Do not force facts into subject/relation/value/qualifier/time slots and do not invent entity, event, attribute, or answer-family categories."
]);

export const OFFICIAL_API_SYSTEM_PROMPT = joinPrompt([
  ...ENVELOPE_PROMPT_PARTS,
  ...INTERPRETATION_PROMPT_PARTS,
  "The following fictional examples demonstrate the format and grounding rules; extract only from the actual request, never from these examples.",
  ...OFFICIAL_API_GROUNDED_EXAMPLES.map((example) =>
    `<example>${JSON.stringify(example)}</example>`),
  ...SCOPE_PROMPT_PARTS
]);

export const OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT = joinPrompt([
  OFFICIAL_API_SYSTEM_PROMPT,
  "This is a coverage repair request containing exactly one source_assertions entry that produced no valid candidate in the primary extraction.",
  "Re-evaluate that assertion independently and preserve every durable source-supported detail if it qualifies.",
  "A bare topic, search phrase, title, or information request is not a durable assertion; return an empty interpretations array for it.",
  "The repair pass does not lower the durability threshold; return an empty interpretations array when the assertion is not durable."
]);

const SYSTEM_PROMPTS_BY_SHA256 = createPromptRegistry();

/** Frozen snapshot verification resolves its own prompt instead of current code state. */
export function resolveOfficialApiSystemPrompt(
  systemPromptSha256: string
): string | undefined {
  return SYSTEM_PROMPTS_BY_SHA256.get(systemPromptSha256);
}

function createPromptRegistry(): ReadonlyMap<string, string> {
  return new Map([
    [sha256(OFFICIAL_API_SYSTEM_PROMPT), OFFICIAL_API_SYSTEM_PROMPT],
    [
      sha256(OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT),
      OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT
    ],
    ...loadHistoricalOfficialApiSystemPrompts()
  ]);
}

function loadHistoricalOfficialApiSystemPrompts(): ReadonlyArray<readonly [string, string]> {
  const directory = resolveHistoricalPromptDirectory();
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
    .map((entry) => {
      const text = fs.readFileSync(path.join(directory, entry.name), "utf8");
      return [sha256(text), text] as const;
    });
}

function resolveHistoricalPromptDirectory(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "historical-prompts"),
    path.join(here, "../../../../src/garden/ingestion/official-api/historical-prompts")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("historical official API system prompt files are missing");
}

function joinPrompt(parts: readonly string[]): string {
  return parts.join(" ");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
