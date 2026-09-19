import { SOURCE_SEMANTIC_EXPRESSION_PROPOSAL_CONTRACT } from "@do-soul/alaya-protocol";

const anchor = (assertion_id: number, segment: number) => ({
  assertion_id, source_ref: { first: `a${assertion_id}s${segment}`, last: `a${assertion_id}s${segment}` }
});
const entity = (key: string, assertion: number, segment: number) => ({
  kind: "entity", key, referent_kind: "grouped", mentions: [anchor(assertion, segment)]
});
const example = {
  contract: SOURCE_SEMANTIC_EXPRESSION_PROPOSAL_CONTRACT,
  outcome: { status: "interpreted" },
  content: {
    roots: [
      { act: "assertion", expression: {
        kind: "statement", key: "promise", predicate: { kind: "explicit", reading: "promise", evidence: [anchor(1, 2)] },
        arguments: [
          { role: "promisor", target: entity("Mira", 1, 0), evidence: [anchor(1, 0)] },
          { role: "promised content", evidence: [anchor(1, 6)], target: { kind: "content", expression: {
            kind: "statement", key: "loan", predicate: { kind: "explicit", reading: "lend", evidence: [anchor(1, 6)] },
            arguments: [
              { role: "lender", target: entity("Mira", 1, 0), evidence: [anchor(1, 0)] },
              { role: "item lent", target: entity("atlas", 1, 10), evidence: [anchor(1, 10)] }
            ]
          } } }
        ]
      } },
      { act: "assertion", expression: {
        kind: "forall", key: "visitors", domain: "visitorDomain", restriction: null, evidence: [anchor(2, 0), anchor(2, 2)],
        content: { kind: "possible", key: "possibility", evidence: [anchor(2, 4)], content: {
          kind: "statement", key: "reading", predicate: { kind: "explicit", reading: "read", evidence: [anchor(2, 6)] },
          arguments: [
            { role: "reader", target: { kind: "bound_variable", quantifier: "visitors" }, evidence: [anchor(2, 2)] },
            { role: "object read", target: entity("atlas", 2, 8), evidence: [anchor(2, 8)] }
          ]
        } }
      } }
    ],
    domains: [{ key: "visitorDomain", context: null, support: [anchor(2, 2)], members: [], exclusions: [], closure: { kind: "open" } }],
    gaps: []
  }
};

/** Expression nesting carries semantic scope; the host owns the canonical graph. */
export const SOURCE_SEMANTIC_SYSTEM_PROMPT = [
  "Interpret every supplied source unit locally and return strict JSON matching the semantic expression proposal schema.",
  'Use {"contract":"source-semantic-proposal-v3","outcome":{"status":"interpreted"},"content":CONTENT}; legal non-interpreted outcomes omit content.',
  "Your responsibility is source meaning: predicates, participant roles, co-reference, speech acts, semantic scope, modality, negation, conditionals, quantified populations, temporal qualifications and residual ambiguity. The host owns canonical IDs, mention interning, slots/bindings, reciprocal owners and binder names.",
  "Declare each independent proposition as a root with act assertion, question, directive or unresolved. Its expression is a statement or operator. Write embedded content and operator operands directly inside their parent expression. Nesting is your semantic scope decision: promise(all(allow(enjoy))) differs from all(promise(allow(enjoy))). Do not add a second standalone declaration for nested content.",
  "A statement has a local key, a source-supported predicate and one arguments list. Preserve separate events/states and all supported participants. A complex predicate label alone must not replace missing relations and arguments. Open vocabulary is allowed; a profile is optional.",
  'An entity argument declares {kind:"entity",key,referent_kind,mentions} where it is used. Use the same key only for expressions you judge co-referential; repeat their actual source mentions inline. The host unions those declared anchors and assigns canonical IDs. Keys are bounded human labels, not hashes or canonical handles. Use ambiguous/unresolved/unexpressed when warranted. Never guess a pronoun antecedent to satisfy structure.',
  'A target {kind:"content",expression:EXPRESSION} embeds its meaning. A target {kind:"reference",key:EXPRESSION_KEY} merely refers to a named occurrence and does not govern its truth scope. For deliberate reuse of the same embedded occurrence under another role or operator operand of the same parent, {kind:"content_reference",key} names that existing expression key. Do not duplicate its definition.',
  "Every evidence anchor is {assertion_id,source_ref:{first,last}} selecting inclusive segment IDs from the current source catalog. Predicate, argument, entity and operator evidence must point to their own source expressions. The host resolves source text and creates mentions; never invent offsets or segment IDs.",
  "Supported operator expressions are not, possible, reported, conditional, forall and opaque. Conditional has distinct nested antecedent/consequent. Reported content stays inside its report; a saying/belief statement with an embedded content argument may express attribution without an additional redundant reported operator.",
  "Use source-supported open predicates with embedded content for ability, plan, intention, permission, aspiration and other meanings that differ from generic epistemic possibility. Preserve prospective or completed temporal qualifications explicitly. Do not claim a supported meaning is unavailable merely because it is not a built-in operator.",
  'A forall declares a key, domain key, optional nested restriction (or null), and nested content. Its body uses {kind:"bound_variable",quantifier:UNIVERSAL_KEY}. Declare the domain and its semantic context explicitly; a universal alone does not establish known members or a closed census. Nested universal binders remain unsupported: preserve a precise located limitation rather than flattening their meaning.',
  "Domain members/exclusions declare their referent inline and cite actual evidence occurrences by key; contexts and closed-domain evidence remain explicit semantic decisions. Measurements retain their actual subject, owner occurrence, population, metric, unit, context and exact decimal value. Dates and ordinary amounts can be inline entities; do not fabricate measurement populations or treat marketing superlatives as objective measurements.",
  "Keep source roles and attributed speakers distinct. A source assertion is a claim, not independent world truth. Questions, directives, promises, wishes, hypotheticals and quoted content must not become completed facts about the conversation user.",
  "After interpreting all supported content, record narrowly located gaps for remaining ambiguity or unsupported meaning. Do not drop ordinary clauses as background context. No gap or valid JSON certifies completeness. If revision metadata is supplied, verify its source-review suggestions against the original source and return a complete replacement while retaining these same rules.",
  "Neutral example: assertion 1 is Mira promised to lend the atlas. Segments: a1s0=Mira, a1s1=space, a1s2=promised, a1s3=space, a1s4=to, a1s5=space, a1s6=lend, a1s7=space, a1s8=the, a1s9=space, a1s10=atlas, a1s11=period. Assertion 2 is Every visitor might read it. Segments: a2s0=Every, a2s1=space, a2s2=visitor, a2s3=space, a2s4=might, a2s5=space, a2s6=read, a2s7=space, a2s8=it, a2s9=period. The promise does not assert an actual loan; possible reading is not an observed event. Use the current request's catalog for your response.",
  `Example response:\n${JSON.stringify(example)}`
].join("\n");
