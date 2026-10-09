import { SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT, SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT,
  sourceSemanticPresentationContracts, type SourceSemanticGenerationSchemaContract,
  type SourceSemanticGenerationTask } from "@do-soul/alaya-protocol";
import { sourceSemanticTableSystemPrompt, sourceSemanticRelationGuidance,
  sourceSemanticRootGuidance } from "./source-semantic-table-guidance.js";
import { sourceSemanticPreservationGuidance, SOURCE_SEMANTIC_OPERATOR_GUIDANCE,
  SOURCE_SEMANTIC_SCOPE_GUIDANCE, SOURCE_SEMANTIC_DOMAIN_GUIDANCE,
  SOURCE_SEMANTIC_ATTRIBUTION_GUIDANCE } from "./source-semantic-shared-guidance.js";

const support = (assertion_id: number, text: string) => ({ assertion_id, text });
const entity = (key: string | undefined, assertion_id: number, text: string) => ({ kind: "entity",
  ...(key === undefined ? {} : { key }), mentions: [support(assertion_id, text)] });
const content = (key: string) => ({ kind: "content_ref", key });
export const SOURCE_SEMANTIC_INLINE_EXAMPLE = {
  contract: SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT, outcome: { status: "interpreted" },
  content: {
    nodes: [
      { kind: "statement", key: "first_validity", predicate: { kind: "explicit", reading: "valid", support: support(1, "valid") },
        arguments: [{ role: "subject", target: entity("permit", 1, "permit") }],
        qualifications: [{ role: "exclusive applicability day", support: support(1, "Tuesday only"), target: entity(undefined, 1, "Tuesday") }] },
      { kind: "statement", key: "later_validity", predicate: { kind: "explicit", reading: "valid", support: support(2, "valid") },
        arguments: [{ role: "subject", target: entity("permit", 2, "permit") }, { role: "applicability day", target: entity(undefined, 2, "Thursday") }], qualifications: [] },
      { kind: "statement", key: "knowledge", predicate: { kind: "explicit", reading: "know whether", support: support(2, "know whether") },
        arguments: [{ role: "knower", target: entity(undefined, 2, "The clerk") },
          { role: "proposition whose truth is unknown", support: support(2, "whether"), target: content("later_validity") }], qualifications: [] },
      { kind: "not", key: "unknown_validity", support: support(2, "does not"), content: content("knowledge") }
    ], roots: [{ act: "assertion", expression: content("first_validity") },
      { act: "assertion", expression: content("unknown_validity") }], gaps: []
  }
} as const;

function inlineSystemPrompt(taskScoped = false): string {
  return [
  ...(taskScoped ? [] : ["Interpret every supplied source unit locally and return compact strict JSON matching the finite source occurrence table with inline entity uses, with no indentation or formatting line breaks. Use short occurrence keys and exact references. Preserve full evidence selections, predicate and role meanings, qualifications, scope and gaps; compact serialization must not omit source meaning."]),
  `Use {"contract":"${SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT}","outcome":{"status":"interpreted"},"content":CONTENT}; legal non-interpreted outcomes omit content.`,
  sourceSemanticPreservationGuidance(taskScoped),
  sourceSemanticRelationGuidance(taskScoped),
  "Construct occurrence nodes with their complete arguments, qualifications and scope. At each materializing entity use emit {kind:\"entity\",mentions:[SELECTION,...]} with optional key and referent_kind. The optional key is your sole semantic identity token: use the same key only when the source supports the same referent, even across roots. Keep each use's local mention group separate; do not accumulate identity-wide mentions in every use. Distinct overlapping mention groups remain separate. The host derives evidence-row addresses mechanically; do not emit an entities table or semantic_key field. Do not invent participants from transport labels.",
  sourceSemanticRootGuidance(taskScoped),
  "A statement has an explicit or implicit predicate, ordered arguments and qualifications, sharing the native eight-slot limit. Entity constructors occur in arguments, qualifications, reporters, domain members/exclusions and measurement subjects. Ordinary argument support may be omitted: the host then uses that constructor's local mentions. Explicit argument support wins; qualification support is required. Other target kinds remain content_ref, occurrence_ref, content_reference, bound_variable and unresolved; absent support on those targets retains its empty fallback. Use unresolved plus supported evidence and a gap when the participant is unresolved.",
  'Select exact original text as {assertion_id,text}, adding a zero-based occurrence only when multiple catalog-eligible exact matches exist in that assertion. Eligible matches start and end at complete ASCII-word or Unicode-scalar boundaries; overlapping matches count in start order. Missing, ambiguous, out-of-range or word-internal selections are rejected. Select a full contiguous phrase in one object; use a list for discontinuous support. This selection form applies to predicates, arguments, operators, local mentions, gaps, domains, measurements and no-proposition context_support. Never invent offsets or segment IDs. Optional referent_kind retains grouped, unresolved, unexpressed or ambiguous meaning; absent kind retains native behavior.',
  SOURCE_SEMANTIC_OPERATOR_GUIDANCE,
  SOURCE_SEMANTIC_SCOPE_GUIDANCE,
  SOURCE_SEMANTIC_DOMAIN_GUIDANCE,
  'A gap has exact support and affected typed entity_ref or occurrence_ref entries. In an entity_ref gap, key names the semantic identity token of a real materializing inline use; a gap alone cannot create an entity. An unkeyed use cannot be named by an entity gap. Multiple affected entries retain multiple incidents; [] is source-local residual support. Do not infer attachment from key spelling or nearby text. Leave domain and measurement arrays absent when unsupported; retain their native evidence, context, member, exclusion, restriction, closure, owner, population and value fields when used.',
  SOURCE_SEMANTIC_ATTRIBUTION_GUIDANCE,
  "Neutral example: assertion 1 is The permit is valid on Tuesday only. Assertion 2 is The clerk does not know whether the permit is valid on Thursday. The two permit uses share one identity token and retain separate local mentions. Tuesday's restriction belongs to the first validity statement; unknown truth still has explicit Thursday content. Use your supplied assertion IDs and exact text.",
  `Example response:\n${JSON.stringify(SOURCE_SEMANTIC_INLINE_EXAMPLE)}`
].join("\n");
}

/** Guidance and schema are selected by the same explicit presentation contract. */
export function sourceSemanticGenerationSystemPrompt(contract?: SourceSemanticGenerationSchemaContract,
  task?: SourceSemanticGenerationTask): string {
  const prompt = sourceSemanticPresentationContracts(contract).generation_schema_contract === SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT
    ? inlineSystemPrompt(task !== undefined) : sourceSemanticTableSystemPrompt(task !== undefined);
  if (task === undefined) return prompt;
  const responsibilityGuidance = task.responsibility.kind === "all_supplied_meaning"
    ? "all_supplied_meaning requires every supplied unit's meaning, including meaning unrelated to the original query."
    : "original_query_task requires source meaning needed by the original question and every source-supported dependency of each published claim; other source meaning remains unassessed, including unrepresented meaning inside a represented unit.";
  return [
    `Interpret the supplied generation_task using the complete original_source and source catalog. Return compact strict JSON matching the selected source occurrence schema, with no indentation or formatting line breaks. The active responsibility is ${task.responsibility.kind}: ${responsibilityGuidance} Scope does not certify task completion, source fidelity or the irrelevance of omitted meaning.`,
    "The original_query is a responsibility cue only: it supplies no source facts, source-to-query identity or cross-source coidentity. Your output is an interpretation of this source under the declared responsibility. Downstream stages answer original_query and determine whether query-required computations or domain requirements are satisfied; you supply source-supported meaning, including any quantity, domain, closure or open-world limitation expressed in the source. An unanswered query alone is not a reason to withhold faithfully interpretable source meaning. Support H statements and referent identity solely from this source and recorded context. Necessary roles, qualifications, polarity, time, attribution and governing scope can occur anywhere in original_source. Preserve them for every claim. Keep a dependency that could change a claim conditional, unresolved with a located gap, or withhold the claim. If no faithful publishable occurrence is available, return abstained without content; do not invent H or use no_executable_proposition to claim no question-relevant fact exists. Neither abstention nor a zero-result computation certifies absence in the source or corpus. Emit no generation_task or original_source in your response; those are host-owned request metadata.",
    prompt
  ].join("\n");
}
