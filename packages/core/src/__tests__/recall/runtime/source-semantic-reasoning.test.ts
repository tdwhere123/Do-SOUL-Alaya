/**
 * Independent join oracle compares bindings and necessary leaves, not counts.
 * Families here: shared-variable AND, Orion (inspect-first, wrong object, split
 * Vega), already-inspected, mixed A, A/H leaf withdrawal, question/directive,
 * alpha-renaming, irrelevant additions, role order, all-root seeding, budgets.
 */
import { describe, expect, it } from "vitest";
import {
  SOURCE_SEMANTIC_K_VERSION, SOURCE_SEMANTIC_NORMALIZER_VERSION, sourceSemanticInterpretationIdentity,
  type SourceSemanticAlignment, type SourceSemanticConsumedLeaf,
  type SourceSemanticCorrespondence, type SourceSemanticInterpretation,
  type SourceSemanticQuery, type SourceSemanticQueryFrame, type SourceSemanticQueryVariable
} from "@do-soul/alaya-protocol";
import { digestOriginalQuery } from "../../../recall/conditional-field/query/compile-query-identity.js";
import { SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID } from "../../../recall/conditional-field/query/source-semantic-query-producer-registry.js";
import { SOURCE_SEMANTIC_ALIGNMENT_CORE_PRODUCER_ID } from "../../../recall/conditional-field/query/source-semantic-alignment-producer-registry.js";
import { admitSourceSemanticQuery } from "../../../recall/conditional-field/query/source-semantic-query-admission.js";
import { admitSourceSemanticAlignment } from "../../../recall/conditional-field/query/source-semantic-alignment-admission.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { reasonSourceSemanticInterpretation } from "../../../recall/runtime/source-semantic-reasoning.js";
import { reasonSourceInterpretation } from "../../../recall/runtime/source-interpretation-reasoning.js";
import {
  decodeEngineBindings, oracleBindingsMatchEngine, oracleNecessaryLeavesHeld,
  oracleSourceSemanticJoin
} from "./source-semantic-relational-oracle.js";

const CLOCK = "2026-09-18T00:00:00.000Z";
const AND_QUERY = "which parcel was sent and inspected?";
const JOIN_QUERY = "which already-sent parcel has its recipient promised to inspect that same parcel?";
const INSPECTED_QUERY = "which parcel has already been inspected by Vega?";
const SEND_QUERY = "which parcel has already been sent?";

const role = (id: string, variable: string, excerpt: string) => ({
  id, role_reading: id, target_variable: variable, support: { kind: "query_text" as const, excerpt }
});

function queryOf(
  original: string,
  frames: SourceSemanticQueryFrame[],
  variables: SourceSemanticQueryVariable[],
  obligations: SourceSemanticQuery["alternatives"][number]["context_obligations"]
): SourceSemanticQuery {
  return {
    contract: "source-semantic-query-v1",
    original_query_digest: digestOriginalQuery(original),
    producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID,
    producer_version: "1",
    contract_version: "source-semantic-query-v1",
    variables, alternatives: [{ frames, context_obligations: obligations }],
    return_variables: ["parcel"], gaps: []
  };
}

function sendInspectQuery(original = AND_QUERY) {
  return queryOf(original, [{
    id: "qSend", variable: "fSend", predicate_reading: "send",
    role_requirements: [role("object", "parcel", "parcel")]
  }, {
    id: "qInspect", variable: "fInspect", predicate_reading: "inspect",
    role_requirements: [role("object", "parcel", "parcel")]
  }], [
    { id: "parcel", sort: "entity" },
    { id: "fSend", sort: "proposition" },
    { id: "fInspect", sort: "proposition" }
  ], [
    { frame: "qSend", kind: "asserted_at_source" },
    { frame: "qInspect", kind: "asserted_at_source" }
  ]);
}

function joinQuery() {
  return queryOf(JOIN_QUERY, [{
    id: "qSend", variable: "fSend", predicate_reading: "send",
    role_requirements: [role("object", "parcel", "parcel"), role("recipient", "recipient", "Vega")]
  }, {
    id: "qPromise", variable: "fPromise", predicate_reading: "promise",
    role_requirements: [role("promisor", "recipient", "Vega")]
  }, {
    id: "qInspect", variable: "fInspect", predicate_reading: "inspect",
    role_requirements: [role("object", "parcel", "parcel")]
  }], [
    { id: "parcel", sort: "entity" },
    { id: "recipient", sort: "entity" },
    { id: "fSend", sort: "proposition" },
    { id: "fPromise", sort: "proposition" },
    { id: "fInspect", sort: "proposition" }
  ], [
    { frame: "qSend", kind: "asserted_at_source" },
    { frame: "qPromise", kind: "asserted_at_source" },
    {
      frame: "qInspect", kind: "explicit_embedded_structure",
      incidence: { kind: "embedding", other_frame: "qPromise", role: "content" }
    }
  ]);
}

function inspectedQuery() {
  return queryOf(INSPECTED_QUERY, [{
    id: "qInspect", variable: "fInspect", predicate_reading: "inspect",
    role_requirements: [role("object", "parcel", "parcel")]
  }], [
    { id: "parcel", sort: "entity" },
    { id: "fInspect", sort: "proposition" }
  ], [{ frame: "qInspect", kind: "asserted_at_source" }]);
}

function sendQuery() {
  return queryOf(SEND_QUERY, [{
    id: "qSend", variable: "fSend", predicate_reading: "send",
    role_requirements: [role("object", "parcel", "parcel")]
  }], [
    { id: "parcel", sort: "entity" },
    { id: "fSend", sort: "proposition" }
  ], [{ frame: "qSend", kind: "asserted_at_source" }]);
}

function mention(id: string, text: string, assertionId: number, span: readonly [number, number]) {
  return {
    id, assertion_id: assertionId, source_ref: { first: `a${assertionId}s0`, last: `a${assertionId}s0` },
    text, utf8_span: span
  };
}

function frame(input: {
  id: string; reading: string; mention: string; assertion: number;
  act?: "assertion" | "question" | "directive";
  parent?: string;
  slots: readonly { id: string; target: string; mention: string }[];
}) {
  return {
    id: input.id, assertion_ids: [input.assertion],
    context_owner: input.parent === undefined
      ? { kind: "source_act" as const, source_act: input.act ?? "assertion" as const }
      : { kind: "embedding" as const, parent_frame: input.parent, content_argument: input.id },
    additional_support: [],
    predicate_support: { kind: "explicit" as const, reading: input.reading, mentions: [input.mention] },
    slots: input.slots.map((slot) => ({
      id: slot.id, role_reading: slot.id, support: [{ kind: "lexical" as const, mentions: [slot.mention] }]
    })),
    bindings: input.slots.map((slot) => ({
      slot_id: slot.id, target: { kind: "node" as const, id: slot.target }, support: []
    }))
  };
}

function mixedH(): SourceSemanticInterpretation {
  return {
    contract: "source-interpretation-v3",
    k_version: SOURCE_SEMANTIC_K_VERSION,
    normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
    source: { source_id: "src", source_version: "1", content_digest: digestOriginalQuery(AND_QUERY) },
    producer_id: "h-producer", producer_version: "1", contract_version: "source-interpretation-v3",
    mentions: [
      mention("mSent", "sent", 1, [0, 4]), mention("mParcelSend", "parcel", 1, [5, 11]),
      mention("mInspected", "inspected", 2, [12, 21]), mention("mParcelInspect", "parcel", 2, [22, 28])
    ],
    referents: [{ id: "rParcel", referent_kind: "grouped", mentions: ["mParcelSend", "mParcelInspect"] }],
    frames: [
      frame({
        id: "fSend", reading: "send", mention: "mSent", assertion: 1,
        slots: [{ id: "object", target: "rParcel", mention: "mParcelSend" }]
      }),
      frame({
        id: "fInspect", reading: "inspect", mention: "mInspected", assertion: 2,
        slots: [{ id: "object", target: "rParcel", mention: "mParcelInspect" }]
      })
    ],
    operators: [], gaps: [], entry_roots: ["fSend", "fInspect"], asserted_at_scope: ["fSend", "fInspect"]
  };
}

function orionH(extra: {
  inspectTarget?: string;
  splitVega?: boolean;
} = {}): SourceSemanticInterpretation {
  const inspectTarget = extra.inspectTarget ?? "rP";
  const vegaSend = extra.splitVega === true ? "rVega1" : "rVega";
  const vegaPromise = extra.splitVega === true ? "rVega2" : "rVega";
  const referents = extra.splitVega === true
    ? [
      { id: "rOrion", referent_kind: "grouped" as const, mentions: ["mOrion"] },
      { id: "rVega1", referent_kind: "grouped" as const, mentions: ["mVega1"] },
      { id: "rVega2", referent_kind: "grouped" as const, mentions: ["mVega2"] },
      { id: "rP", referent_kind: "grouped" as const, mentions: ["mP1", "mP2"] },
      { id: "rQ", referent_kind: "grouped" as const, mentions: ["mQ"] }
    ]
    : [
      { id: "rOrion", referent_kind: "grouped" as const, mentions: ["mOrion"] },
      { id: "rVega", referent_kind: "grouped" as const, mentions: ["mVega1", "mVega2"] },
      { id: "rP", referent_kind: "grouped" as const, mentions: ["mP1", "mP2"] },
      { id: "rQ", referent_kind: "grouped" as const, mentions: ["mQ"] }
    ];
  return {
    contract: "source-interpretation-v3",
    k_version: SOURCE_SEMANTIC_K_VERSION,
    normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
    source: { source_id: "orion", source_version: "1", content_digest: digestOriginalQuery(JOIN_QUERY) },
    producer_id: "h-producer", producer_version: "1", contract_version: "source-interpretation-v3",
    mentions: [
      mention("mOrion", "Orion", 1, [0, 5]), mention("mSent", "sent", 1, [6, 10]),
      mention("mP1", "P", 1, [18, 19]), mention("mVega1", "Vega", 1, [23, 27]),
      mention("mVega2", "Vega", 2, [0, 4]), mention("mPromised", "promised", 2, [5, 13]),
      mention("mInspect", "inspect", 2, [17, 24]), mention("mP2", "P", 2, [25, 26]),
      mention("mQ", "Q", 2, [27, 28])
    ],
    referents,
    frames: [
      frame({
        id: "fSend", reading: "send", mention: "mSent", assertion: 1,
        slots: [
          { id: "agent", target: "rOrion", mention: "mOrion" },
          { id: "object", target: "rP", mention: "mP1" },
          { id: "recipient", target: vegaSend, mention: "mVega1" }
        ]
      }),
      frame({
        id: "fPromise", reading: "promise", mention: "mPromised", assertion: 2,
        slots: [{ id: "promisor", target: vegaPromise, mention: "mVega2" }]
      }),
      frame({
        id: "fInspect", reading: "inspect", mention: "mInspect", assertion: 2, parent: "fPromise",
        slots: [
          { id: "inspector", target: vegaPromise, mention: "mVega2" },
          { id: "object", target: inspectTarget, mention: inspectTarget === "rQ" ? "mQ" : "mP2" }
        ]
      })
    ],
    operators: [], gaps: [], entry_roots: ["fSend", "fPromise"], asserted_at_scope: ["fSend", "fPromise"]
  };
}

function stanceH(act: "assertion" | "question" | "directive"): SourceSemanticInterpretation {
  const asserted = act === "assertion";
  return {
    contract: "source-interpretation-v3",
    k_version: SOURCE_SEMANTIC_K_VERSION,
    normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
    source: { source_id: "stance", source_version: act, content_digest: digestOriginalQuery(SEND_QUERY) },
    producer_id: "h-producer", producer_version: "1", contract_version: "source-interpretation-v3",
    mentions: [mention("mSent", "sent", 1, [0, 4]), mention("mParcel", "parcel", 1, [5, 11])],
    referents: [{ id: "rParcel", referent_kind: "grouped", mentions: ["mParcel"] }],
    frames: [frame({
      id: "fSend", reading: "send", mention: "mSent", assertion: 1, act,
      slots: [{ id: "object", target: "rParcel", mention: "mParcel" }]
    })],
    operators: [], gaps: [], entry_roots: ["fSend"],
    asserted_at_scope: asserted ? ["fSend"] : []
  };
}

function correspondence(
  query: SourceSemanticCorrespondence["query_endpoint"],
  source: SourceSemanticCorrespondence["source_endpoint"],
  excerpt: string,
  mentionId: string
): SourceSemanticCorrespondence {
  return {
    relation: "contextual_equivalence",
    query_endpoint: query, source_endpoint: source,
    query_support: { kind: "query_text", excerpt },
    source_semantic_support: [{ kind: "lexical", mentions: [mentionId] }]
  };
}

function alignmentOf(
  h: SourceSemanticInterpretation, q: SourceSemanticQuery, original: string,
  correspondences: SourceSemanticCorrespondence[]
): SourceSemanticAlignment {
  const admitted = admitSourceSemanticQuery(q, original);
  if (admitted.kind !== "admitted") throw new Error("query must admit");
  return {
    contract: "source-semantic-alignment-v1",
    h_id: sourceSemanticInterpretationIdentity(h, fieldContractSha256),
    q_id: admitted.query_id,
    producer_id: SOURCE_SEMANTIC_ALIGNMENT_CORE_PRODUCER_ID,
    producer_version: "1",
    contract_version: "source-semantic-alignment-v1",
    correspondences
  };
}

const SEND_AND = [
  correspondence({ kind: "predicate", alternative: 0, frame: "qSend" }, { kind: "frame", frame: "fSend" }, "sent", "mSent"),
  correspondence({ kind: "slot", alternative: 0, frame: "qSend", slot: "object" }, { kind: "slot", frame: "fSend", slot: "object" }, "parcel", "mParcelSend"),
  correspondence({ kind: "predicate", alternative: 0, frame: "qInspect" }, { kind: "frame", frame: "fInspect" }, "inspected", "mInspected"),
  correspondence({ kind: "slot", alternative: 0, frame: "qInspect", slot: "object" }, { kind: "slot", frame: "fInspect", slot: "object" }, "parcel", "mParcelInspect")
];

function joinCorrespondences(inspectMention = "mP2"): SourceSemanticCorrespondence[] {
  return [
    correspondence({ kind: "predicate", alternative: 0, frame: "qSend" }, { kind: "frame", frame: "fSend" }, "sent", "mSent"),
    correspondence({ kind: "slot", alternative: 0, frame: "qSend", slot: "object" }, { kind: "slot", frame: "fSend", slot: "object" }, "parcel", "mP1"),
    correspondence({ kind: "slot", alternative: 0, frame: "qSend", slot: "recipient" }, { kind: "slot", frame: "fSend", slot: "recipient" }, "Vega", "mVega1"),
    correspondence({ kind: "predicate", alternative: 0, frame: "qPromise" }, { kind: "frame", frame: "fPromise" }, "promised", "mPromised"),
    correspondence({ kind: "slot", alternative: 0, frame: "qPromise", slot: "promisor" }, { kind: "slot", frame: "fPromise", slot: "promisor" }, "Vega", "mVega2"),
    correspondence({ kind: "predicate", alternative: 0, frame: "qInspect" }, { kind: "frame", frame: "fInspect" }, "inspect", "mInspect"),
    correspondence({ kind: "slot", alternative: 0, frame: "qInspect", slot: "object" }, { kind: "slot", frame: "fInspect", slot: "object" }, "parcel", inspectMention)
  ];
}

function reason(
  h: SourceSemanticInterpretation, q: SourceSemanticQuery, a: SourceSemanticAlignment | undefined,
  original: string
) {
  return reasonSourceSemanticInterpretation({
    h, q, a, original_query: original, workspaceId: "ws-semantic",
    scope: "project", authorizedScopes: ["project"], asOf: CLOCK
  });
}

function hasLeaf(
  leaves: readonly SourceSemanticConsumedLeaf[],
  kind: SourceSemanticConsumedLeaf["leaf_kind"],
  occurrence: string,
  slot?: string
) {
  return leaves.some((leaf) =>
    leaf.leaf_kind === kind && leaf.occurrence === occurrence && (slot === undefined || leaf.slot_id === slot));
}

function assertOracle(
  h: SourceSemanticInterpretation, q: SourceSemanticQuery, a: SourceSemanticAlignment,
  result: ReturnType<typeof reason>, variables: readonly string[]
) {
  const oracle = oracleSourceSemanticJoin(h, q, a);
  const decoded = decodeEngineBindings(h, q, a, result.consumed_leaves);
  expect(oracleBindingsMatchEngine(oracle, decoded, variables)).toBe(true);
  expect(oracleNecessaryLeavesHeld(oracle, result.consumed_leaves)).toBe(true);
  return oracle;
}

describe("source semantic query compilation", () => {
  it("joins a shared-variable AND on the same parcel", () => {
    const h = mixedH();
    const q = sendInspectQuery();
    const a = alignmentOf(h, q, AND_QUERY, SEND_AND);
    const result = reason(h, q, a, AND_QUERY);
    expect(result.outcome.status).toBe("interpreted");
    expect(result.world_claim).toBe("unknown");
    expect(hasLeaf(result.consumed_leaves, "h_presence", "fSend")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "h_presence", "fInspect")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "h_assertion_permission", "fSend")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "h_assertion_permission", "fInspect")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "h_binding", "fSend", "object")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "h_binding", "fInspect", "object")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "a_predicate", "fSend")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "a_predicate", "fInspect")).toBe(true);
    const oracle = assertOracle(h, q, a, result, ["parcel", "fSend", "fInspect"]);
    expect(oracle.assignments).toHaveLength(1);
    expect(oracle.assignments[0]!.bindings).toMatchObject({
      parcel: "rParcel", fSend: "fSend", fInspect: "fInspect"
    });
  });

  it("proves the Orion join from H+A+assertion+content leaves and rejects inspect-object and same-name Vega", () => {
    const h = orionH();
    const q = joinQuery();
    const a = alignmentOf(h, q, JOIN_QUERY, joinCorrespondences());
    const result = reason(h, q, a, JOIN_QUERY);
    expect(result.outcome.status).toBe("interpreted");
    expect(hasLeaf(result.consumed_leaves, "h_presence", "fSend")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "h_presence", "fPromise")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "h_presence", "fInspect")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "h_assertion_permission", "fSend")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "h_assertion_permission", "fPromise")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "h_assertion_permission", "fInspect")).toBe(false);
    expect(hasLeaf(result.consumed_leaves, "h_content", "fInspect")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "h_binding", "fSend", "object")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "h_binding", "fSend", "recipient")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "h_binding", "fPromise", "promisor")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "h_binding", "fInspect", "object")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "a_predicate", "fSend")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "a_predicate", "fPromise")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "a_predicate", "fInspect")).toBe(true);
    const joinVars = ["parcel", "recipient", "fSend", "fPromise", "fInspect"] as const;
    const oracle = assertOracle(h, q, a, result, joinVars);
    expect(oracle.assignments).toHaveLength(1);
    expect(oracle.assignments[0]!.bindings).toMatchObject({
      parcel: "rP", recipient: "rVega", fSend: "fSend", fPromise: "fPromise", fInspect: "fInspect"
    });
    const childFirst = {
      ...q,
      alternatives: [{
        ...q.alternatives[0]!,
        frames: [...q.alternatives[0]!.frames].reverse()
      }]
    };
    const childFirstA = alignmentOf(h, childFirst, JOIN_QUERY, joinCorrespondences());
    const childFirstResult = reason(h, childFirst, childFirstA, JOIN_QUERY);
    expect(hasLeaf(childFirstResult.consumed_leaves, "h_content", "fInspect")).toBe(true);
    assertOracle(h, childFirst, childFirstA, childFirstResult, joinVars);
    const wrongObject = orionH({ inspectTarget: "rQ" });
    const wrongA = alignmentOf(wrongObject, q, JOIN_QUERY, joinCorrespondences("mQ"));
    const wrongResult = reason(wrongObject, q, wrongA, JOIN_QUERY);
    expect(wrongResult.consumed_leaves).toEqual([]);
    assertOracle(wrongObject, q, wrongA, wrongResult, joinVars);
    const split = orionH({ splitVega: true });
    const splitA = alignmentOf(split, q, JOIN_QUERY, joinCorrespondences());
    const splitResult = reason(split, q, splitA, JOIN_QUERY);
    expect(splitResult.consumed_leaves).toEqual([]);
    assertOracle(split, q, splitA, splitResult, joinVars);
  });

  it("does not treat promise-content inspect as an already-inspected event", () => {
    const h = orionH();
    const q = inspectedQuery();
    const a = alignmentOf(h, q, INSPECTED_QUERY, [
      correspondence({ kind: "predicate", alternative: 0, frame: "qInspect" }, { kind: "frame", frame: "fInspect" }, "inspect", "mInspect"),
      correspondence({ kind: "slot", alternative: 0, frame: "qInspect", slot: "object" }, { kind: "slot", frame: "fInspect", slot: "object" }, "parcel", "mP2")
    ]);
    const result = reason(h, q, a, INSPECTED_QUERY);
    expect(result.outcome.status).toBe("interpreted");
    expect(result.world_claim).toBe("unknown");
    expect(result.consumed_leaves).toEqual([]);
    expect(assertOracle(h, q, a, result, ["parcel", "fInspect"]).assignments).toEqual([]);
  });

  it("cannot AND complementary A documents and can AND one A that maps both", () => {
    const h = mixedH();
    const q = sendInspectQuery();
    const sendOnly = alignmentOf(h, q, AND_QUERY, SEND_AND.slice(0, 2));
    const inspectOnly = alignmentOf(h, q, AND_QUERY, SEND_AND.slice(2));
    const both = alignmentOf(h, q, AND_QUERY, SEND_AND);
    const andVars = ["parcel", "fSend", "fInspect"] as const;
    const sendOnlyResult = reason(h, q, sendOnly, AND_QUERY);
    const inspectOnlyResult = reason(h, q, inspectOnly, AND_QUERY);
    const bothResult = reason(h, q, both, AND_QUERY);
    expect(sendOnlyResult.consumed_leaves).toEqual([]);
    expect(inspectOnlyResult.consumed_leaves).toEqual([]);
    assertOracle(h, q, sendOnly, sendOnlyResult, andVars);
    assertOracle(h, q, inspectOnly, inspectOnlyResult, andVars);
    expect(hasLeaf(bothResult.consumed_leaves, "a_predicate", "fSend")).toBe(true);
    assertOracle(h, q, both, bothResult, andVars);
    expect(sendOnly.h_id).toBe(inspectOnly.h_id);
    expect(sendOnly.q_id).toBe(inspectOnly.q_id);
    expect(sendOnly.correspondences).not.toEqual(inspectOnly.correspondences);
  });

  it("does not treat question or directive entry as a completed send", () => {
    const q = sendQuery();
    const asserted = stanceH("assertion");
    const question = stanceH("question");
    const directive = stanceH("directive");
    const map = (h: SourceSemanticInterpretation, mentionId: string) => alignmentOf(h, q, SEND_QUERY, [
      correspondence({ kind: "predicate", alternative: 0, frame: "qSend" }, { kind: "frame", frame: "fSend" }, "sent", "mSent"),
      correspondence({ kind: "slot", alternative: 0, frame: "qSend", slot: "object" }, { kind: "slot", frame: "fSend", slot: "object" }, "parcel", mentionId)
    ]);
    const sendVars = ["parcel", "fSend"] as const;
    const assertedResult = reason(asserted, q, map(asserted, "mParcel"), SEND_QUERY);
    const questionResult = reason(question, q, map(question, "mParcel"), SEND_QUERY);
    const directiveResult = reason(directive, q, map(directive, "mParcel"), SEND_QUERY);
    expect(hasLeaf(assertedResult.consumed_leaves, "h_assertion_permission", "fSend")).toBe(true);
    assertOracle(asserted, q, map(asserted, "mParcel"), assertedResult, sendVars);
    expect(questionResult.consumed_leaves).toEqual([]);
    expect(directiveResult.consumed_leaves).toEqual([]);
    assertOracle(question, q, map(question, "mParcel"), questionResult, sendVars);
    assertOracle(directive, q, map(directive, "mParcel"), directiveResult, sendVars);
    const asked = queryOf(SEND_QUERY, [{
      id: "qSend", variable: "fSend", predicate_reading: "send", source_act: "question",
      role_requirements: [role("object", "parcel", "parcel")]
    }], [
      { id: "parcel", sort: "entity" }, { id: "fSend", sort: "proposition" }
    ], []);
    const askedMap = (h: SourceSemanticInterpretation) => alignmentOf(h, asked, SEND_QUERY, [
      correspondence({ kind: "predicate", alternative: 0, frame: "qSend" }, { kind: "frame", frame: "fSend" }, "sent", "mSent"),
      correspondence({ kind: "slot", alternative: 0, frame: "qSend", slot: "object" }, { kind: "slot", frame: "fSend", slot: "object" }, "parcel", "mParcel")
    ]);
    const askedAgainstAsserted = reason(asserted, asked, askedMap(asserted), SEND_QUERY);
    const askedAgainstQuestion = reason(question, asked, askedMap(question), SEND_QUERY);
    expect(askedAgainstAsserted.consumed_leaves).toEqual([]);
    assertOracle(asserted, asked, askedMap(asserted), askedAgainstAsserted, sendVars);
    expect(hasLeaf(askedAgainstQuestion.consumed_leaves, "h_presence", "fSend")).toBe(true);
    assertOracle(question, asked, askedMap(question), askedAgainstQuestion, sendVars);
  });

  it("drops a proof when a necessary A leaf is withdrawn and keeps an unrelated send proof", () => {
    const h = mixedH();
    const andQuery = sendInspectQuery();
    const onlySend = sendQuery();
    const full = alignmentOf(h, andQuery, AND_QUERY, SEND_AND);
    const withdrawn = alignmentOf(h, andQuery, AND_QUERY, SEND_AND.slice(0, 2));
    const andVars = ["parcel", "fSend", "fInspect"] as const;
    const fullResult = reason(h, andQuery, full, AND_QUERY);
    const withdrawnResult = reason(h, andQuery, withdrawn, AND_QUERY);
    expect(fullResult.consumed_leaves.length).toBeGreaterThan(0);
    assertOracle(h, andQuery, full, fullResult, andVars);
    expect(withdrawnResult.consumed_leaves).toEqual([]);
    assertOracle(h, andQuery, withdrawn, withdrawnResult, andVars);
    const sendA = alignmentOf(h, onlySend, SEND_QUERY, [
      correspondence({ kind: "predicate", alternative: 0, frame: "qSend" }, { kind: "frame", frame: "fSend" }, "sent", "mSent"),
      correspondence({ kind: "slot", alternative: 0, frame: "qSend", slot: "object" }, { kind: "slot", frame: "fSend", slot: "object" }, "parcel", "mParcelSend")
    ]);
    const sendResult = reason(h, onlySend, sendA, SEND_QUERY);
    expect(hasLeaf(sendResult.consumed_leaves, "a_predicate", "fSend")).toBe(true);
    assertOracle(h, onlySend, sendA, sendResult, ["parcel", "fSend"]);
  });

  it("returns preparation_required when Q or A is missing", () => {
    const h = mixedH();
    const q = sendInspectQuery();
    expect(reasonSourceSemanticInterpretation({
      h, original_query: AND_QUERY, workspaceId: "ws-semantic",
      scope: "project", authorizedScopes: ["project"], asOf: CLOCK
    }).outcome).toEqual({ status: "preparation_required", missing: "q_and_a" });
    expect(reasonSourceSemanticInterpretation({
      h, q, original_query: AND_QUERY, workspaceId: "ws-semantic",
      scope: "project", authorizedScopes: ["project"], asOf: CLOCK
    }).outcome).toEqual({ status: "preparation_required", missing: "a" });
    expect(reason(h, q, undefined, AND_QUERY).outcome).toEqual({ status: "preparation_required", missing: "a" });
  });

  it("drops a proof when a necessary H binding is withdrawn, rebinds A onto a new H identity, and keeps an unrelated send", () => {
    const original = mixedH();
    const andQuery = sendInspectQuery();
    const onlySend = sendQuery();
    const withdrawnH: SourceSemanticInterpretation = {
      ...original,
      frames: original.frames.map((row) => row.id === "fInspect" ? { ...row, bindings: [] } : row)
    };
    expect(sourceSemanticInterpretationIdentity(withdrawnH, fieldContractSha256))
      .not.toBe(sourceSemanticInterpretationIdentity(original, fieldContractSha256));
    const staleA = alignmentOf(original, andQuery, AND_QUERY, SEND_AND);
    expect(reason(withdrawnH, andQuery, staleA, AND_QUERY).outcome).toEqual({
      status: "invalid", reason: "malformed_alignment"
    });
    const reboundAnd = alignmentOf(withdrawnH, andQuery, AND_QUERY, SEND_AND);
    const reboundResult = reason(withdrawnH, andQuery, reboundAnd, AND_QUERY);
    expect(reboundResult.consumed_leaves).toEqual([]);
    assertOracle(withdrawnH, andQuery, reboundAnd, reboundResult, ["parcel", "fSend", "fInspect"]);
    const sendA = alignmentOf(withdrawnH, onlySend, SEND_QUERY, [
      correspondence({ kind: "predicate", alternative: 0, frame: "qSend" }, { kind: "frame", frame: "fSend" }, "sent", "mSent"),
      correspondence({ kind: "slot", alternative: 0, frame: "qSend", slot: "object" }, { kind: "slot", frame: "fSend", slot: "object" }, "parcel", "mParcelSend")
    ]);
    const sendResult = reason(withdrawnH, onlySend, sendA, SEND_QUERY);
    expect(hasLeaf(sendResult.consumed_leaves, "a_predicate", "fSend")).toBe(true);
    assertOracle(withdrawnH, onlySend, sendA, sendResult, ["parcel", "fSend"]);
    expect(sendA.h_id).toBe(reboundAnd.h_id);
  });

  it("keeps an independent send alternative after inspect A leaves are withdrawn", () => {
    const h = mixedH();
    const send = sendQuery();
    const inspect = inspectedQuery();
    const either: SourceSemanticQuery = {
      ...send,
      original_query_digest: digestOriginalQuery(AND_QUERY),
      variables: [
        { id: "parcel", sort: "entity" },
        { id: "fSend", sort: "proposition" },
        { id: "fInspect", sort: "proposition" }
      ],
      alternatives: [send.alternatives[0]!, inspect.alternatives[0]!]
    };
    const bothA = alignmentOf(h, either, AND_QUERY, [
      ...SEND_AND.slice(0, 2),
      correspondence({ kind: "predicate", alternative: 1, frame: "qInspect" }, { kind: "frame", frame: "fInspect" }, "inspected", "mInspected"),
      correspondence({ kind: "slot", alternative: 1, frame: "qInspect", slot: "object" }, { kind: "slot", frame: "fInspect", slot: "object" }, "parcel", "mParcelInspect")
    ]);
    const both = reason(h, either, bothA, AND_QUERY);
    expect(assertOracle(h, either, bothA, both, ["parcel", "fSend", "fInspect"]).assignments).toHaveLength(2);
    const sendOnlyA = alignmentOf(h, either, AND_QUERY, SEND_AND.slice(0, 2));
    const remaining = reason(h, either, sendOnlyA, AND_QUERY);
    const remainingOracle = assertOracle(h, either, sendOnlyA, remaining, ["parcel", "fSend", "fInspect"]);
    expect(remainingOracle.assignments).toHaveLength(1);
    expect(remainingOracle.assignments[0]!.bindings).toMatchObject({ parcel: "rParcel", fSend: "fSend" });
    expect(hasLeaf(remaining.consumed_leaves, "a_predicate", "fInspect")).toBe(false);
  });

  it("seeds every entry root rather than a single sending seed", () => {
    const h = mixedH();
    const inspect = inspectedQuery();
    const inspectA = alignmentOf(h, inspect, INSPECTED_QUERY, [
      correspondence({ kind: "predicate", alternative: 0, frame: "qInspect" }, { kind: "frame", frame: "fInspect" }, "inspected", "mInspected"),
      correspondence({ kind: "slot", alternative: 0, frame: "qInspect", slot: "object" }, { kind: "slot", frame: "fInspect", slot: "object" }, "parcel", "mParcelInspect")
    ]);
    const inspectResult = reason(h, inspect, inspectA, INSPECTED_QUERY);
    expect(hasLeaf(inspectResult.consumed_leaves, "h_presence", "fInspect")).toBe(true);
    assertOracle(h, inspect, inspectA, inspectResult, ["parcel", "fInspect"]);
    const reversed: SourceSemanticInterpretation = { ...h, entry_roots: ["fInspect", "fSend"] };
    const reversedA = alignmentOf(reversed, inspect, INSPECTED_QUERY, inspectA.correspondences as SourceSemanticCorrespondence[]);
    assertOracle(reversed, inspect, reversedA, reason(reversed, inspect, reversedA, INSPECTED_QUERY), ["parcel", "fInspect"]);
    const send = sendQuery();
    const sendA = alignmentOf(h, send, SEND_QUERY, [
      correspondence({ kind: "predicate", alternative: 0, frame: "qSend" }, { kind: "frame", frame: "fSend" }, "sent", "mSent"),
      correspondence({ kind: "slot", alternative: 0, frame: "qSend", slot: "object" }, { kind: "slot", frame: "fSend", slot: "object" }, "parcel", "mParcelSend")
    ]);
    assertOracle(h, send, sendA, reason(h, send, sendA, SEND_QUERY), ["parcel", "fSend"]);
  });

  it("agrees under alpha-renamed query variables, ignored extra H frames, and swapped role order", () => {
    const h = mixedH();
    const q = sendInspectQuery();
    const rename = (id: string) => id === "parcel" ? "item" : id === "fSend" ? "sendEvent" : id === "fInspect" ? "inspectEvent" : id;
    const renamed: SourceSemanticQuery = {
      ...q,
      variables: q.variables.map((row) => ({ ...row, id: rename(row.id) })),
      return_variables: q.return_variables.map(rename),
      alternatives: q.alternatives.map((alternative) => ({
        ...alternative,
        frames: alternative.frames.map((frame) => ({
          ...frame,
          variable: rename(frame.variable),
          role_requirements: frame.role_requirements.map((role) => ({
            ...role, target_variable: rename(role.target_variable)
          }))
        }))
      }))
    };
    const renamedA = alignmentOf(h, renamed, AND_QUERY, SEND_AND);
    const renamedResult = reason(h, renamed, renamedA, AND_QUERY);
    const renamedOracle = assertOracle(h, renamed, renamedA, renamedResult, ["item", "sendEvent", "inspectEvent"]);
    expect(renamedOracle.assignments[0]!.bindings).toMatchObject({
      item: "rParcel", sendEvent: "fSend", inspectEvent: "fInspect"
    });
    const extra: SourceSemanticInterpretation = {
      ...h,
      mentions: [...h.mentions, mention("mPacked", "packed", 3, [29, 35])],
      referents: [...h.referents, { id: "rOther", referent_kind: "grouped", mentions: ["mPacked"] }],
      frames: [...h.frames, frame({
        id: "fPack", reading: "pack", mention: "mPacked", assertion: 3,
        slots: [{ id: "object", target: "rOther", mention: "mPacked" }]
      })],
      entry_roots: ["fSend", "fInspect", "fPack"],
      asserted_at_scope: ["fSend", "fInspect", "fPack"]
    };
    const extraA = alignmentOf(extra, q, AND_QUERY, SEND_AND);
    const extraResult = reason(extra, q, extraA, AND_QUERY);
    expect(hasLeaf(extraResult.consumed_leaves, "h_presence", "fPack")).toBe(false);
    assertOracle(extra, q, extraA, extraResult, ["parcel", "fSend", "fInspect"]);
    const join = joinQuery();
    const swapped: SourceSemanticQuery = {
      ...join,
      alternatives: [{
        ...join.alternatives[0]!,
        frames: join.alternatives[0]!.frames.map((frame) => frame.id !== "qSend" ? frame : {
          ...frame, role_requirements: [...frame.role_requirements].reverse()
        })
      }]
    };
    const orion = orionH();
    const swappedA = alignmentOf(orion, swapped, JOIN_QUERY, joinCorrespondences());
    assertOracle(orion, swapped, swappedA, reason(orion, swapped, swappedA, JOIN_QUERY), [
      "parcel", "recipient", "fSend", "fPromise", "fInspect"
    ]);
  });

  it("exhausts a shared budget without treating the interrupt as global absence", () => {
    const h = mixedH();
    const q = sendInspectQuery();
    const a = alignmentOf(h, q, AND_QUERY, SEND_AND);
    const admitted = admitSourceSemanticAlignment({
      alignment: a, h, q, original_query: AND_QUERY
    });
    expect(admitted.kind).toBe("admitted");
    if (admitted.kind !== "admitted") return;
    const result = reasonSourceSemanticInterpretation({
      h, q, a, original_query: AND_QUERY, workspaceId: "ws-semantic",
      scope: "project", authorizedScopes: ["project"], asOf: CLOCK,
      request: {
        contract: "source-interpretation-reasoning-v2",
        accepts_unreviewed_conditional_results: true,
        h_id: admitted.interpretation_id, q_id: admitted.query_id, a_id: admitted.alignment_id,
        original_query: AND_QUERY,
        budget: {
          schema_version: 1, work_units: 2, memory_bytes: 32,
          page_budget: 1, finalization_reserve: 0, min_envelope: 1
        },
        output_byte_limit: 4096
      }
    });
    expect(result.outcome.status).toBe("resource_exhausted");
    expect(result.world_claim).toBe("unknown");
    expect(result.consumed_leaves).toEqual([]);
    expect(result.semantic_status).toBe("unreviewed");
  });

  it("does not retarget live v2 packet reasoning", () => {
    expect(reasonSourceInterpretation).not.toBe(reasonSourceSemanticInterpretation);
  });
});
