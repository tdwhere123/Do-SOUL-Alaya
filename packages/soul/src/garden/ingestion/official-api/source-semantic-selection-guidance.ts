import { SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT } from "@do-soul/alaya-protocol";

const example = {
  contract: SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT,
  outcome: { status: "interpreted" },
  content: {
    roots: [
      { act: "assertion", expression: {
        kind: "statement", predicate: { kind: "explicit", reading: "valid", support: { assertion_id: 1, text: "valid" } },
        arguments: [
          { role: "subject", target: { kind: "entity", key: "permit", mentions: [{ assertion_id: 1, text: "permit" }] } },
          { role: "exclusive applicability day", support: { assertion_id: 1, text: "Tuesday only" }, target: { assertion_id: 1, text: "Tuesday" } }
        ]
      } },
      { act: "assertion", expression: {
        kind: "not", support: { assertion_id: 2, text: "does not" }, content: {
          kind: "statement", predicate: { kind: "explicit", reading: "know whether", support: { assertion_id: 2, text: "know whether" } },
          arguments: [
            { role: "knower", target: { assertion_id: 2, text: "The clerk" } },
            { role: "proposition whose truth is unknown", support: { assertion_id: 2, text: "whether" }, target: {
              kind: "statement", predicate: { kind: "explicit", reading: "valid", support: { assertion_id: 2, text: "valid" } },
              arguments: [
                { role: "subject", target: { kind: "entity", key: "permit", mentions: [{ assertion_id: 2, text: "permit" }] } },
                { role: "applicability day", target: { assertion_id: 2, text: "Thursday" } }
              ]
            } }
          ]
        }
      } }
    ]
  }
};

/** Host-owned keys and one support field; nested expressions remain the semantic scope owner. */
export const SOURCE_SEMANTIC_SYSTEM_PROMPT = [
  "Interpret every supplied source unit locally and return strict JSON matching the selection semantic expression schema.",
  `Use {"contract":"${SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT}","outcome":{"status":"interpreted"},"content":CONTENT}; legal non-interpreted outcomes omit content.`,
  "Preserve what each source unit says: relations, complete participants and values, their qualifications, speech acts and scope. Include identifying codes and full dates in their selected text; a local key contributes no evidence. Give a material qualification its meaning on the affected event or participant, with its own selected support. Source text in support alone does not encode the qualification; if its meaning or attachment cannot be represented, retain a located gap affecting that occurrence. The host owns IDs, mention interning, catalog anchors, slots/bindings, reciprocal owners and binder names.",
  "Declare each independent proposition as a root with act assertion, question, directive or unresolved. Never map a missing act to assertion. Nest embedded content directly as the argument target or operator operand. Nesting is your semantic scope decision: promise(lend) differs from a standalone loan. Do not add a second standalone declaration for nested content.",
  "A statement has a source-supported predicate and one arguments list. Omit expression keys unless you need co-reference, an occurrence reference, same-parent reuse, or a quantifier binding. Colliding aliases are errors; matching surface spelling is not identity.",
  'Select exact original text as {assertion_id,text}, adding a zero-based occurrence only when multiple catalog-eligible exact matches exist in that assertion. Eligible matches start and end at complete ASCII-word or Unicode-scalar boundaries; overlapping matches count in start order. Missing, ambiguous, out-of-range or word-internal selections are rejected. Select a full contiguous phrase in one object; use a list for discontinuous support. This one selection form applies to predicates, arguments, operators, mentions, gaps, domains, measurements and no-proposition context_support. Never invent offsets or segment IDs. An argument target selection defines its local entity and supplies role evidence; use {kind:"entity",key,mentions} only for explicit co-reference. Equal spelling is not identity. Use {kind:"unresolved"} plus supported evidence and a gap when the participant is unresolved. Do not emit at/evidence fields.',
  'A target {kind:"occurrence",key} refers to a named statement or operator you declared in this response and does not govern its truth scope. A surface noun is never an occurrence key. Same-parent reuse uses {kind:"content_reference",key}. Bound variables use {kind:"bound_variable",quantifier:UNIVERSAL_KEY}.',
  "Operators are not, possible, reported, conditional, forall and opaque. Conditional separates antecedent/consequent. Open statement predicates can express source-supported ability, plan, intention, permission or attribution with nested content. Use a statement for a reporting event with its own date or other roles: its arguments retain reporter, event time and nested reported content. reported preserves attribution scope but has no event-time argument; do not lose an event's roles to use this shorter form. The report's time and the content's time stay on their respective events. Neither representation asserts the embedded content independently.",
  "Preserve modality and negation in their source-supported order: saying that an event did not happen differs from not saying it happened. When a source gives the proposition but leaves its truth unknown, keep its known predicate, participants and qualifications as nested content under the uncertainty statement; unresolved content means the proposition itself is missing. Possibility, capability and permission do not assert that an event happened: use possible or a more specific source-supported predicate with nested event content. Keep an unrepresentable distinction as a located gap; never flatten it into an actual event.",
  "forall requires a key, domain key, optional nested restriction or null, and nested content. Nested universal binders remain unsupported: record a located gap instead of flattening them. Optional domains and measurements exist in the schema; omit both unless the source supports that meaning. Do not emit empty domain or measurement tables, invent a census, or treat a number as a population.",
  "Keep source roles and attributed speakers distinct: a transport role does not identify the speaker of quoted content. Questions, directives, promises, wishes, hypotheticals and quoted content must not become completed facts. After supported content, record narrowly located gaps; omit gaps when none remain. No gap or valid JSON certifies completeness. If revision metadata is supplied, return a complete replacement under these same rules.",
  "Neutral example: assertion 1 is The permit is valid on Tuesday only. Assertion 2 is The clerk does not know whether the permit is valid on Thursday. Tuesday's restriction belongs to the first validity statement; unknown truth still has explicit Thursday content. Use your supplied assertion IDs and exact text.",
  `Example response:\n${JSON.stringify(example)}`
].join("\n");
