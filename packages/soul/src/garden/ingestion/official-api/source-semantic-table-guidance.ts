import { SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT } from "@do-soul/alaya-protocol";
import { sourceSemanticPreservationGuidance, SOURCE_SEMANTIC_OPERATOR_GUIDANCE,
  SOURCE_SEMANTIC_SCOPE_GUIDANCE, SOURCE_SEMANTIC_DOMAIN_GUIDANCE,
  SOURCE_SEMANTIC_ATTRIBUTION_GUIDANCE } from "./source-semantic-shared-guidance.js";

const support = (assertion_id: number, text: string) => ({ assertion_id, text });
const entity = (key: string) => ({ kind: "entity_ref", key });
const content = (key: string) => ({ kind: "content_ref", key });

export const SOURCE_SEMANTIC_RELATION_EXAMPLE = {
  contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT, outcome: { status: "interpreted" },
  content: {
    nodes: [
      { kind: "statement", key: "n1", predicate: { kind: "explicit", reading: "has color", support: support(1, "color is") },
        arguments: [{ role: "bearer", target: entity("e1") }, { role: "color value", target: entity("e2") }], qualifications: [] },
      { kind: "statement", key: "n2", predicate: { kind: "explicit", reading: "move", support: support(2, "move") },
        arguments: [{ role: "object moved", target: entity("e1") }, { role: "destination", target: entity("e3") }], qualifications: [] },
      { kind: "statement", key: "n3", predicate: { kind: "explicit", reading: "has color", support: support(3, "color") },
        arguments: [{ role: "bearer", target: entity("e1") }, { role: "color value", target: entity("e2") }], qualifications: [] }
    ],
    entities: [
      { form: "entity", key: "e1", mentions: [support(1, "panel"), support(2, "it"), support(3, "panel")] },
      { form: "entity", key: "e2", mentions: [support(1, "amber"), support(3, "amber")] },
      { form: "selection", key: "e3", selection: support(2, "bay D") }
    ],
    roots: [
      { act: "assertion", expression: content("n1") },
      { act: "directive", expression: content("n2") },
      { act: "question", expression: content("n3") }
    ],
    gaps: []
  }
} as const;

export const SOURCE_SEMANTIC_TABLE_EXAMPLE = {
  contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT, outcome: { status: "interpreted" },
  content: {
    nodes: [
      { kind: "statement", key: "first_validity", predicate: { kind: "explicit", reading: "valid", support: support(1, "valid") },
        arguments: [{ role: "subject", target: entity("permitFirst") }],
        qualifications: [{ role: "exclusive applicability day", support: support(1, "Tuesday only"), target: entity("tuesday") }] },
      { kind: "statement", key: "later_validity", predicate: { kind: "explicit", reading: "valid", support: support(2, "valid") },
        arguments: [{ role: "subject", target: entity("permitLater") }, { role: "applicability day", target: entity("thursday") }],
        qualifications: [] },
      { kind: "statement", key: "knowledge", predicate: { kind: "explicit", reading: "know whether", support: support(2, "know whether") },
        arguments: [{ role: "knower", target: entity("clerk") },
          { role: "proposition whose truth is unknown", support: support(2, "whether"), target: content("later_validity") }],
        qualifications: [] },
      { kind: "not", key: "unknown_validity", support: support(2, "does not"), content: content("knowledge") }
    ],
    entities: [
      { form: "entity", key: "permitFirst", semantic_key: "permit", mentions: [support(1, "permit")] },
      { form: "entity", key: "permitLater", semantic_key: "permit", mentions: [support(2, "permit")] },
      { form: "selection", key: "tuesday", selection: support(1, "Tuesday") },
      { form: "selection", key: "clerk", selection: support(2, "The clerk") },
      { form: "selection", key: "thursday", selection: support(2, "Thursday") }
    ],
    roots: [
      { act: "assertion", expression: content("first_validity") },
      { act: "assertion", expression: content("unknown_validity") }
    ],
    gaps: []
  }
} as const;

export function sourceSemanticRelationGuidance(taskScoped = false): string {
  return (taskScoped ? "Represent each expressed relation required by the declared task" : "Represent each expressed relation") +
    " with its actual participants and values, including an attribute's value as an argument. A compound sentence can need several nodes. Do not replace its propositions with one predicate summarizing what the speaker states, praises or asks. A User/Assistant transport label does not add a saying or reporting event. If the source actually describes a speech or mental event, preserve its content as separately represented nested propositions with their own arguments.";
}

export function sourceSemanticRootGuidance(taskScoped = false): string {
  return (taskScoped ? "Declare each independent proposition required by the declared task" : "Declare each independent proposition") +
    " as a root with act assertion, question, directive or unresolved. A statement node can be the content of any of these acts; a directive or question does not require a negation, reporting or uncertainty operator. Add an operator only when the source supports its meaning. Give every statement or operator one node key; a root expression is {kind:\"content_ref\",key}. Every root and content reference must resolve to an emitted node. One content_ref in an argument or operator operand defines the nested node's governing parent. A content_reference reuses an already defined node only under that same immediate parent. An occurrence_ref is an ordinary non-governing reference to a declared node, including one under a different root. Do not assert nested content independently.";
}

export function sourceSemanticTableSystemPrompt(taskScoped = false): string {
  return [
  ...(taskScoped ? [] : ["Interpret every supplied source unit locally and return compact strict JSON matching the finite source occurrence table schema, with no indentation or formatting line breaks. Use short local table keys and reuse their exact references. Preserve full evidence selections, predicate and role meanings, qualifications, scope and gaps; compact serialization must not omit source meaning."]),
  `Use {"contract":"${SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT}","outcome":{"status":"interpreted"},"content":CONTENT}; legal non-interpreted outcomes omit content.`,
  sourceSemanticPreservationGuidance(taskScoped),
  sourceSemanticRelationGuidance(taskScoped),
  "Construct the occurrence nodes first, including their complete arguments, qualifications and scope. Derive the entity table from actual materializing references in these nodes and any required domains or measurements; gap targets alone do not count. Do not predeclare a narrator, speaker or other participant merely because a transport role or possible analysis suggests one. Declare the independent roots after their nodes. Before returning, remove any unused entity declaration without adding invented relations to justify it; " +
    (taskScoped ? "preserve all supported propositions and qualifications required by the declared task." : "preserve all supported propositions and qualifications."),
  sourceSemanticRootGuidance(taskScoped),
  "A statement has an explicit or implicit predicate, ordered arguments and qualifications. A qualification retains its own support; arguments and qualifications share the native eight-slot limit. Entity table keys are typed local lookups, separate from native semantic_key aliases and occurrence keys. Define each entity row once and use it in an argument, qualification, reporter, domain member or exclusion, or measurement subject. A gap alone cannot materialize an entity row. Compatible rows may share a semantic alias only when every row has a materializing use. Put multiple lawful mentions on the used row when one entity has multiple source mentions.",
  'Select exact original text as {assertion_id,text}, adding a zero-based occurrence only when multiple catalog-eligible exact matches exist in that assertion. Eligible matches start and end at complete ASCII-word or Unicode-scalar boundaries; overlapping matches count in start order. Missing, ambiguous, out-of-range or word-internal selections are rejected. Select a full contiguous phrase in one object; use a list for discontinuous support. This one selection form applies to predicates, arguments, operators, mentions, gaps, domains, measurements and no-proposition context_support. Never invent offsets or segment IDs. Entity rows have form "selection" with one selection or form "entity" with mentions and optional semantic_key/referent_kind. Use {kind:"unresolved"} plus supported evidence and a gap when the participant is unresolved.',
  SOURCE_SEMANTIC_OPERATOR_GUIDANCE,
  SOURCE_SEMANTIC_SCOPE_GUIDANCE,
  SOURCE_SEMANTIC_DOMAIN_GUIDANCE,
  "A gap has exact support and affected typed entity_ref or occurrence_ref entries. An entity gap target requires its declared semantic_key and a separate materializing use. Multiple affected entries retain multiple incidents; [] is source-local residual support. Do not infer attachment from local key spelling or a nearby phrase. Leave domain and measurement arrays absent when unsupported; retain their native evidence, context, member, exclusion, restriction, closure, owner, population and value fields when used.",
  SOURCE_SEMANTIC_ATTRIBUTION_GUIDANCE,
  "Relation and source-act example: assertion 1 is User: The panel's color is amber. Assertion 2 is Please move it to bay D. Assertion 3 is Assistant: Is the panel's color amber? The color value is an argument; the requested move and asked color proposition retain their source acts without becoming completed facts. Transport labels add no participants or speech events.",
  `Relation and source-act example response:\n${JSON.stringify(SOURCE_SEMANTIC_RELATION_EXAMPLE)}`,
  "Neutral example: assertion 1 is The permit is valid on Tuesday only. Assertion 2 is The clerk does not know whether the permit is valid on Thursday. Tuesday's restriction belongs to the first validity statement; unknown truth still has explicit Thursday content. Use your supplied assertion IDs and exact text.",
  `Example response:\n${JSON.stringify(SOURCE_SEMANTIC_TABLE_EXAMPLE)}`
].join("\n");
}

export const SOURCE_SEMANTIC_SYSTEM_PROMPT = sourceSemanticTableSystemPrompt();
