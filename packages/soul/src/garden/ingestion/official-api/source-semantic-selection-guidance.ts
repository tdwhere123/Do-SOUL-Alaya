import { SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT } from "@do-soul/alaya-protocol";

const example = {
  contract: SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT,
  outcome: { status: "interpreted" },
  content: {
    roots: [
      { act: "assertion", expression: {
        kind: "statement",
        predicate: { kind: "explicit", reading: "promise", support: { assertion_id: 1, text: "promised" } },
        arguments: [
          { role: "promisor", target: { assertion_id: 1, text: "Mira" } },
          { role: "promised content", support: { assertion_id: 1, text: "lend" }, target: {
            kind: "statement",
            predicate: { kind: "explicit", reading: "lend", support: { assertion_id: 1, text: "lend" } },
            arguments: [
              { role: "lender", target: { assertion_id: 1, text: "Mira" } },
              { role: "item lent", target: { kind: "entity", key: "atlas", mentions: [{ assertion_id: 1, text: "atlas" }] } }
            ]
          } }
        ]
      } },
      { act: "assertion", expression: {
        kind: "forall", key: "visitors", domain: "visitorDomain", restriction: null, support: { assertion_id: 2, text: "Every" },
        content: { kind: "possible", support: { assertion_id: 2, text: "might" }, content: {
          kind: "statement",
          predicate: { kind: "explicit", reading: "read", support: { assertion_id: 2, text: "read" } },
          arguments: [
            { role: "reader", target: { kind: "bound_variable", quantifier: "visitors" } },
            { role: "object read", target: { kind: "entity", key: "atlas", mentions: [{ assertion_id: 2, text: "it", occurrence: 1 }] } }
          ]
        } }
      } }
    ],
    domains: [{ key: "visitorDomain", context: null, support: { assertion_id: 2, text: "visitor" }, members: [], exclusions: [], closure: { kind: "open" } }]
  }
};

/** Host-owned keys and one support field; nested expressions remain the semantic scope owner. */
export const SOURCE_SEMANTIC_SYSTEM_PROMPT = [
  "Interpret every supplied source unit locally and return strict JSON matching the selection semantic expression schema.",
  `Use {"contract":"${SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT}","outcome":{"status":"interpreted"},"content":CONTENT}; legal non-interpreted outcomes omit content.`,
  "Preserve what each source unit says: relations, complete participants and values, their qualifications, speech acts and scope. Include identifying codes and full dates in their selected text; a local key contributes no evidence. Attach each qualification to the event or participant it qualifies. If the attachment is ambiguous, retain a located gap. The host owns IDs, mention interning, catalog anchors, slots/bindings, reciprocal owners and binder names.",
  "Declare each independent proposition as a root with act assertion, question, directive or unresolved. Never map a missing act to assertion. Nest embedded content directly as the argument target or operator operand. Nesting is your semantic scope decision: promise(lend) differs from a standalone loan. Do not add a second standalone declaration for nested content.",
  "A statement has a source-supported predicate and one arguments list. Omit expression keys unless you need co-reference, an occurrence reference, same-parent reuse, or a quantifier binding. Colliding aliases are errors; matching surface spelling is not identity.",
  'Select exact original text as {assertion_id,text}, adding a zero-based occurrence only when the same text repeats inside that assertion. Missing, ambiguous, out-of-range or word-internal selections are rejected. Select a full contiguous phrase in one object; use a list for discontinuous support. This one selection form applies to predicates, arguments, operators, mentions, gaps, domains, measurements and no-proposition context_support. Never invent offsets or segment IDs. An argument target selection defines its local entity and supplies role evidence; use {kind:"entity",key,mentions} only for explicit co-reference. Equal spelling is not identity. Use {kind:"unresolved"} plus supported evidence and a gap when the participant is unresolved. Do not emit at/evidence fields.',
  'A target {kind:"occurrence",key} refers to a named statement or operator you declared in this response and does not govern its truth scope. A surface noun is never an occurrence key. Same-parent reuse uses {kind:"content_reference",key}. Bound variables use {kind:"bound_variable",quantifier:UNIVERSAL_KEY}.',
  "Operators are not, possible, reported, conditional, forall and opaque. Conditional separates antecedent/consequent. Open statement predicates can express source-supported ability, plan, intention, permission or attribution with nested content. Use a statement for a reporting event with its own date or other roles: its arguments retain reporter, event time and nested reported content. reported preserves attribution scope but has no event-time argument; do not lose an event's roles to use this shorter form. The report's time and the content's time stay on their respective events. Neither representation asserts the embedded content independently.",
  "Preserve modality and negation in their source-supported order. Possibility, capability and permission do not assert that an event happened: use possible or a more specific source-supported predicate with nested event content. Keep an unrepresentable distinction as a located gap; never flatten it into an actual event.",
  "forall requires a key, domain key, optional nested restriction or null, and nested content. Nested universal binders remain unsupported: record a located gap instead of flattening them. Optional domains and measurements exist in the schema; omit both unless the source supports that meaning. Do not emit empty domain or measurement tables, invent a census, or treat a number as a population.",
  "Keep source roles and attributed speakers distinct. Questions, directives, promises, wishes, hypotheticals and quoted content must not become completed facts. After supported content, record narrowly located gaps; omit gaps when none remain. No gap or valid JSON certifies completeness. If revision metadata is supplied, return a complete replacement under these same rules.",
  "Neutral example: assertion 1 is Mira promised to lend the atlas. Assertion 2 is Every visitor might read it. The promise does not assert an actual loan; possible reading is not an observed event. Use your supplied assertion IDs and exact text.",
  `Example response:\n${JSON.stringify(example)}`
].join("\n");
