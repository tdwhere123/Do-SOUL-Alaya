import { SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT } from "@do-soul/alaya-protocol";
import { SOURCE_SEMANTIC_PRESERVATION_GUIDANCE, SOURCE_SEMANTIC_OPERATOR_GUIDANCE,
  SOURCE_SEMANTIC_SCOPE_GUIDANCE, SOURCE_SEMANTIC_DOMAIN_GUIDANCE,
  SOURCE_SEMANTIC_ATTRIBUTION_GUIDANCE } from "./source-semantic-shared-guidance.js";

const SOURCE_SEMANTIC_SELECTION_EXAMPLE = {
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
  SOURCE_SEMANTIC_PRESERVATION_GUIDANCE,
  "Declare each independent proposition as a root with act assertion, question, directive or unresolved. Never map a missing act to assertion. Nest embedded content directly as the argument target or operator operand. Nesting is your semantic scope decision: promise(lend) differs from a standalone loan. Do not add a second standalone declaration for nested content.",
  "A statement has a source-supported predicate and one arguments list. Omit expression keys unless you need co-reference, an occurrence reference, same-parent reuse, or a quantifier binding. Colliding aliases are errors; matching surface spelling is not identity.",
  'Select exact original text as {assertion_id,text}, adding a zero-based occurrence only when multiple catalog-eligible exact matches exist in that assertion. Eligible matches start and end at complete ASCII-word or Unicode-scalar boundaries; overlapping matches count in start order. Missing, ambiguous, out-of-range or word-internal selections are rejected. Select a full contiguous phrase in one object; use a list for discontinuous support. This one selection form applies to predicates, arguments, operators, mentions, gaps, domains, measurements and no-proposition context_support. Never invent offsets or segment IDs. An argument target selection defines its local entity and supplies role evidence; use {kind:"entity",key,mentions} only for explicit co-reference. Equal spelling is not identity. Use {kind:"unresolved"} plus supported evidence and a gap when the participant is unresolved. Do not emit at/evidence fields.',
  'A target {kind:"occurrence",key} refers to a named statement or operator you declared in this response and does not govern its truth scope. A surface noun is never an occurrence key. Same-parent reuse uses {kind:"content_reference",key}. Bound variables use {kind:"bound_variable",quantifier:UNIVERSAL_KEY}.',
  SOURCE_SEMANTIC_OPERATOR_GUIDANCE,
  SOURCE_SEMANTIC_SCOPE_GUIDANCE,
  SOURCE_SEMANTIC_DOMAIN_GUIDANCE,
  SOURCE_SEMANTIC_ATTRIBUTION_GUIDANCE,
  "Neutral example: assertion 1 is The permit is valid on Tuesday only. Assertion 2 is The clerk does not know whether the permit is valid on Thursday. Tuesday's restriction belongs to the first validity statement; unknown truth still has explicit Thursday content. Use your supplied assertion IDs and exact text.",
  `Example response:\n${JSON.stringify(SOURCE_SEMANTIC_SELECTION_EXAMPLE)}`
].join("\n");
