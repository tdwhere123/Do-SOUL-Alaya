import { SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT } from "@do-soul/alaya-protocol";

const example = {
  contract: SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT,
  outcome: { status: "interpreted" },
  content: {
    roots: [
      { act: "assertion", expression: {
        kind: "statement",
        predicate: { kind: "explicit", reading: "promise", support: "a1s2" },
        arguments: [
          { role: "promisor", target: "a1s0" },
          { role: "promised content", support: "a1s6", target: {
            kind: "statement",
            predicate: { kind: "explicit", reading: "lend", support: "a1s6" },
            arguments: [
              { role: "lender", target: "a1s0" },
              { role: "item lent", target: { kind: "entity", key: "atlas", mentions: ["a1s10"] } }
            ]
          } }
        ]
      } },
      { act: "assertion", expression: {
        kind: "forall", key: "visitors", domain: "visitorDomain", restriction: null, support: "a2s0",
        content: { kind: "possible", support: "a2s4", content: {
          kind: "statement",
          predicate: { kind: "explicit", reading: "read", support: "a2s6" },
          arguments: [
            { role: "reader", target: { kind: "bound_variable", quantifier: "visitors" } },
            { role: "object read", target: { kind: "entity", key: "atlas", mentions: ["a2s8"] } }
          ]
        } }
      } }
    ],
    domains: [{ key: "visitorDomain", context: null, support: "a2s2", members: [], exclusions: [], closure: { kind: "open" } }]
  }
};

/** Host-owned keys and one support field; nested expressions remain the semantic scope owner. */
export const SOURCE_SEMANTIC_SYSTEM_PROMPT = [
  "Interpret every supplied source unit locally and return strict JSON matching the selection semantic expression schema.",
  `Use {"contract":"${SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT}","outcome":{"status":"interpreted"},"content":CONTENT}; legal non-interpreted outcomes omit content.`,
  "Your responsibility is source meaning: predicates, participant roles, co-reference, speech acts, semantic scope, modality, negation, conditionals, quantified populations, temporal qualifications and residual ambiguity. The host owns canonical IDs, unreferenced handles, mention interning, catalog anchors, slots/bindings, reciprocal owners and binder names.",
  "Declare each independent proposition as a root with act assertion, question, directive or unresolved. Never map a missing act to assertion. Nest embedded content directly as the argument target or operator operand. Nesting is your semantic scope decision: promise(lend) differs from a standalone loan. Do not add a second standalone declaration for nested content.",
  "A statement has a source-supported predicate and one arguments list. Omit expression keys unless you need co-reference, an occurrence reference, same-parent reuse, or a quantifier binding. Colliding aliases are errors; matching surface spelling is not identity.",
  'Predicate and operator support is the one field support. Use "a1s2" for one catalog segment, {first,last} for contiguous text, or an array of those for discontinuous selections. Do not emit at or evidence. Do not enumerate every scalar or token of a contiguous span. Duplicate identical support is merged; missing support is invalid; extra unknown fields are invalid. Argument target "a1s0" defines one local grouped referent from that mention and selects that same evidence for the role. Reuse across different mentions requires {kind:"entity",key,mentions}. Repeat a new mention when you mean additional support. Do not guess a pronoun antecedent. Use {kind:"unresolved"} when the participant is missing.',
  'A target {kind:"occurrence",key} refers to a named statement or operator you declared in this response and does not govern its truth scope. A surface noun is never an occurrence key. Same-parent reuse uses {kind:"content_reference",key}. Bound variables use {kind:"bound_variable",quantifier:UNIVERSAL_KEY}. Catalog segment IDs occur only as source selections, never as graph handles.',
  "Supported operators are not, possible, reported, conditional, forall and opaque. Conditional has distinct nested antecedent/consequent. Reported content stays inside its report. Source-supported open predicates with nested content may express ability, plan, intention, permission or attribution without a redundant operator.",
  "Preserve modal scope even in a short affirmative sentence: can, could, may, might, able to and allowed to do not assert that the embedded event occurred. Represent possibility with possible supported by the modal expression, or preserve a more specific ability/permission meaning as a source-supported predicate with nested event content. Never drop the governing modal and emit its event as a standalone assertion. Keep negation and modal nesting in their source-supported order; do not infer actuality from capability or permission. If the intended modal meaning or scope cannot be represented faithfully, retain a narrowly located gap instead of silently flattening it.",
  "forall requires a key, domain key, optional nested restriction or null, and nested content. Nested universal binders remain unsupported: record a located gap instead of flattening them. Optional domains and measurements exist in the schema; omit both unless the source supports that meaning. Do not emit empty domain or measurement tables, invent a census, or treat a number as a population.",
  "Keep source roles and attributed speakers distinct. Questions, directives, promises, wishes, hypotheticals and quoted content must not become completed facts. After supported content, record narrowly located gaps; omit gaps when none remain. No gap or valid JSON certifies completeness. If revision metadata is supplied, return a complete replacement under these same rules.",
  "Neutral example: assertion 1 is Mira promised to lend the atlas. Segments: a1s0=Mira, a1s1=space, a1s2=promised, a1s3=space, a1s4=to, a1s5=space, a1s6=lend, a1s7=space, a1s8=the, a1s9=space, a1s10=atlas, a1s11=period. Assertion 2 is Every visitor might read it. Segments: a2s0=Every, a2s1=space, a2s2=visitor, a2s3=space, a2s4=might, a2s5=space, a2s6=read, a2s7=space, a2s8=it, a2s9=period. The promise does not assert an actual loan; possible reading is not an observed event. Use the current request's catalog for your response.",
  `Example response:\n${JSON.stringify(example)}`
].join("\n");
