import { SOURCE_SEMANTIC_CONTENT_PROPOSAL_CONTRACT } from "@do-soul/alaya-protocol";

const anchor = (assertion_id: number, segment: number) => ({
  assertion_id, source_ref: { first: `a${assertion_id}s${segment}`, last: `a${assertion_id}s${segment}` }
});

const example = {
  contract: SOURCE_SEMANTIC_CONTENT_PROPOSAL_CONTRACT,
  outcome: { status: "interpreted" },
  content: {
    entities: [
      { id: "mira", referent_kind: "grouped", mentions: [anchor(1, 0)] },
      { id: "atlas", referent_kind: "grouped", mentions: [anchor(1, 10), anchor(2, 8)] }
    ],
    statements: [
      { id: "promise", predicate: { kind: "explicit", reading: "promise", evidence: [anchor(1, 2)] }, arguments: [
        { role: "promisor", target: { kind: "entity", id: "mira" }, evidence: [anchor(1, 0)] },
        { role: "promised content", target: { kind: "content", id: "loan" }, evidence: [anchor(1, 6)] }
      ] },
      { id: "loan", predicate: { kind: "explicit", reading: "lend", evidence: [anchor(1, 6)] }, arguments: [
        { role: "lender", target: { kind: "entity", id: "mira" }, evidence: [anchor(1, 0)] },
        { role: "item lent", target: { kind: "entity", id: "atlas" }, evidence: [anchor(1, 10)] }
      ] },
      { id: "reading", predicate: { kind: "explicit", reading: "read", evidence: [anchor(2, 6)] }, arguments: [
        { role: "reader", target: { kind: "bound_variable", quantifier: "visitors" }, evidence: [anchor(2, 2)] },
        { role: "object read", target: { kind: "entity", id: "atlas" }, evidence: [anchor(2, 8)] }
      ] }
    ],
    operators: [
      { id: "visitors", operator: "forall", domain: "visitorDomain", restriction: null, content: "possibility", evidence: [anchor(2, 0), anchor(2, 2)] },
      { id: "possibility", operator: "possible", content: "reading", evidence: [anchor(2, 4)] }
    ],
    acts: [{ occurrence: "promise", act: "assertion" }, { occurrence: "visitors", act: "assertion" }],
    domains: [{ id: "visitorDomain", context: null, support: [anchor(2, 2)], members: [], exclusions: [], closure: { kind: "open" } }],
    gaps: []
  }
};

/** Language choices belong to the producer; graph bookkeeping belongs to the compiler. */
export const SOURCE_SEMANTIC_SYSTEM_PROMPT = [
  "Interpret the complete supplied source locally. Return the semantic content proposal specified by the response schema.",
  'Return strict JSON {"contract":"source-semantic-proposal-v2","outcome":{"status":"interpreted"},"content":CONTENT}; legal non-interpreted outcomes omit content.',
  "Your responsibility is language interpretation: predicates, participant roles, co-reference, speech acts, negation, modality, conditionals, reported content, quantification, temporal and other qualifications. Preserve every supported relation and its qualifications, including relations inside questions, directives, aspirations, beliefs and promises.",
  "The host compiles your semantic choices into its graph. Do not emit host hashes, offsets, mention IDs, slot IDs, slots/bindings tables, context_owner, assertion_ids, binder IDs, entry_roots, asserted_at_scope, canonical graph contracts, answers, scores or QueryProgram.",
  "A supplied profile is an optional adapter, not an admission prerequisite. Predicate and role readings are open vocabulary. Use separate statements for distinct events or states, with their actual participants and source-supported qualifications; do not collapse a clause into a predicate label while dropping its arguments.",
  "Each evidence anchor is {assertion_id,source_ref:{first,last}} selecting inclusive segment IDs from that assertion in source_catalog. Use source anchors directly where evidence is required; the host creates and interns mentions. Evidence from another assertion needs its own anchor. Do not invent offsets or segment IDs.",
  "Entities group source expressions you judge co-referential. Keep different entities separate even when their names overlap. Use grouped, unresolved, unexpressed or ambiguous as warranted. Coreference is your interpretation, not a spelling match performed by the host.",
  "Statements have a logical alias, a predicate with reading and explicit/implicit source evidence, and one arguments list. Each argument gives its role, semantic target and evidence. The host generates both slots and bindings from that one declaration. Missing source information may use an unresolved target; a known participant must not be omitted because the clause is complex.",
  'Target kind "entity" points to an entity alias. "reference" points to another occurrence without governing its truth scope (for example an event associated with another event). "content" embeds a proposition under this statement (for example a promise, belief, goal or reported content). These are different semantic decisions. Do not promote embedded content to an independent assertion.',
  "Operators declare their meaning and operands once. The host generates the reciprocal ownership links. Supported operators are not, possible, reported, conditional, forall and opaque. For conditional, distinguish antecedent and consequent; for reported, reporter is participation, not governed content. Use opaque only for a structure not expressible by supported operators and retain the specific limitation.",
  "Acts declare assertion, question, directive or unresolved only for independent root occurrences. Governed content gets its source scope from its parent, never another act declaration. Every occurrence needs one root act or one governing content/operand relationship. Sharing an entity or referencing an occurrence does not create a governing relationship.",
  'For a universal, declare a domain, restriction (occurrence or null), and content. Body arguments use {"kind":"bound_variable","quantifier":UNIVERSAL_ALIAS}; the host supplies the binder. A domain preserves your semantic context, membership evidence, exclusions and open/closed choice. A universal phrase alone does not establish a complete census. Never invent members or closure. Nested universal binders remain unsupported and require a precisely located limitation.',
  "Measurements preserve a source-supported subject, owner occurrence, declared population, metric, unit, context and exact decimal value. Ordinary dates, named years and qualitative descriptions can be entities in statement arguments; they do not require fabricated measurement populations. Subjective easiest or best is a source qualification, not an objective measured ranking.",
  "Gaps report the precise residual ambiguity or unsupported meaning after preserving all interpretable parts. A whole-clause gap is not a substitute for interpreting supported predicates and participants. Complexity, aspiration, attribution or a missing optional participant alone do not make the entire clause unsupported. A gap never certifies completion.",
  "Source role is provenance. It does not make text true or turn quoted/generic content into a fact about the conversation user. Keep source questions, directives, hypothetical events and intended future events scoped accordingly. Return no independent world-truth or confidence claim.",
  "Neutral complete example: assertion 1 is Mira promised to lend the atlas. Its segments are a1s0=Mira, a1s1=space, a1s2=promised, a1s3=space, a1s4=to, a1s5=space, a1s6=lend, a1s7=space, a1s8=the, a1s9=space, a1s10=atlas, a1s11=period. Assertion 2 is Every visitor might read it. Its segments are a2s0=Every, a2s1=space, a2s2=visitor, a2s3=space, a2s4=might, a2s5=space, a2s6=read, a2s7=space, a2s8=it, a2s9=period. The promise does not assert an actual loan, and possible reading is not an observed event. Use the current request catalog for your response.",
  `Example response:\n${JSON.stringify(example)}`
].join("\n");
