/**
 * Independent join oracle compares bindings and necessary leaves, not counts.
 * Families here: shared-variable AND, Orion (inspect-first, wrong object, split
 * Vega), already-inspected, mixed semantic correspondence, semantic correspondence and source interpretation leaf withdrawal, question/directive,
 * alpha-renaming, irrelevant additions, role order, all-root seeding, budgets.
 */
import { describe, expect, it } from "vitest";
import {
  SOURCE_SEMANTIC_K_VERSION, SOURCE_SEMANTIC_NORMALIZER_VERSION, sourceSemanticInterpretationIdentity,
  type SourceSemanticEndpointCorrespondence, type SourceSemanticConsumedLeaf,
  type SourceSemanticCorrespondence, type SourceSemanticInterpretation,
  type SourceSemanticQuery, type SourceSemanticQueryFrame, type SourceSemanticQueryVariable,
  UNKNOWN_UTTERANCE_ATTRIBUTION
} from "@do-soul/alaya-protocol";
import { digestOriginalQuery } from "../../../recall/conditional-field/query/compile-query-identity.js";
import { SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID } from "../../../recall/conditional-field/query/source-semantic-query-producer-registry.js";
import { SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID } from "../../../recall/conditional-field/query/source-semantic-correspondence-producer-registry.js";
import { admitSourceSemanticQuery } from "../../../recall/conditional-field/query/source-semantic-query-admission.js";
import { admitSourceSemanticCorrespondence } from "../../../recall/conditional-field/query/source-semantic-correspondence-admission.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { reasonSourceSemanticInterpretation } from "../../../recall/runtime/source-semantic-reasoning.js";
import {
  decodeEngineBindings, oracleBindingsMatchEngine, oracleNecessaryLeavesHeld, oracleProofsMatchEngine,
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
    contract: "source-semantic-query-v4",
    original_query_digest: digestOriginalQuery(original),
    approved_fixed_context: null, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID,
    producer_version: "1",
    contract_version: "source-semantic-query-v4",
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
    role_requirements: [role("object", "parcel", "parcel"), role("recipient", "recipient", "recipient")]
  }, {
    id: "qPromise", variable: "fPromise", predicate_reading: "promise",
    role_requirements: [role("promisor", "recipient", "recipient")]
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

function mixedInterpretation(): SourceSemanticInterpretation {
  return {
    contract: "source-interpretation-v4",
    k_version: SOURCE_SEMANTIC_K_VERSION,
    normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
    source: { source_id: "src", source_version: "1", content_digest: digestOriginalQuery(AND_QUERY),
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION },
    producer_id: "source-interpretation-producer", producer_version: "1", contract_version: "source-interpretation-v4",
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

function orionInterpretation(extra: {
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
    contract: "source-interpretation-v4",
    k_version: SOURCE_SEMANTIC_K_VERSION,
    normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
    source: { source_id: "orion", source_version: "1", content_digest: digestOriginalQuery(JOIN_QUERY),
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION },
    producer_id: "source-interpretation-producer", producer_version: "1", contract_version: "source-interpretation-v4",
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

function stanceInterpretation(act: "assertion" | "question" | "directive"): SourceSemanticInterpretation {
  const asserted = act === "assertion";
  return {
    contract: "source-interpretation-v4",
    k_version: SOURCE_SEMANTIC_K_VERSION,
    normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
    source: { source_id: "stance", source_version: act, content_digest: digestOriginalQuery(SEND_QUERY),
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION },
    producer_id: "source-interpretation-producer", producer_version: "1", contract_version: "source-interpretation-v4",
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

function endpointCorrespondence(
  query: SourceSemanticEndpointCorrespondence["query_endpoint"],
  source: SourceSemanticEndpointCorrespondence["source_endpoint"],
  excerpt: string,
  mentionId: string
): SourceSemanticEndpointCorrespondence {
  return {
    relation: "contextual_equivalence",
    query_endpoint: query, source_endpoint: source,
    query_support: { kind: "query_text", excerpt },
    source_semantic_support: [{ kind: "lexical", mentions: [mentionId] }]
  };
}

function correspondenceOf(
  interpretation: SourceSemanticInterpretation, semantics: SourceSemanticQuery, original: string,
  correspondences: SourceSemanticEndpointCorrespondence[]
): SourceSemanticCorrespondence {
  const admitted = admitSourceSemanticQuery(semantics, original);
  if (admitted.kind !== "admitted") throw new Error("query must admit");
  return {
    contract: "source-semantic-correspondence-v3",
    source_interpretation_id: sourceSemanticInterpretationIdentity(interpretation, fieldContractSha256),
    query_semantics_id: admitted.query_id,
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID,
    producer_version: "1",
    contract_version: "source-semantic-correspondence-v3",
    correspondences
  };
}

const SEND_AND = [
  endpointCorrespondence({ kind: "predicate", alternative: 0, frame: "qSend" }, { kind: "frame", frame: "fSend" }, "sent", "mSent"),
  endpointCorrespondence({ kind: "slot", alternative: 0, frame: "qSend", slot: "object" }, { kind: "slot", frame: "fSend", slot: "object" }, "parcel", "mParcelSend"),
  endpointCorrespondence({ kind: "predicate", alternative: 0, frame: "qInspect" }, { kind: "frame", frame: "fInspect" }, "inspected", "mInspected"),
  endpointCorrespondence({ kind: "slot", alternative: 0, frame: "qInspect", slot: "object" }, { kind: "slot", frame: "fInspect", slot: "object" }, "parcel", "mParcelInspect")
];

function joinCorrespondences(inspectMention = "mP2"): SourceSemanticEndpointCorrespondence[] {
  return [
    endpointCorrespondence({ kind: "predicate", alternative: 0, frame: "qSend" }, { kind: "frame", frame: "fSend" }, "sent", "mSent"),
    endpointCorrespondence({ kind: "slot", alternative: 0, frame: "qSend", slot: "object" }, { kind: "slot", frame: "fSend", slot: "object" }, "parcel", "mP1"),
    endpointCorrespondence({ kind: "slot", alternative: 0, frame: "qSend", slot: "recipient" }, { kind: "slot", frame: "fSend", slot: "recipient" }, "recipient", "mVega1"),
    endpointCorrespondence({ kind: "predicate", alternative: 0, frame: "qPromise" }, { kind: "frame", frame: "fPromise" }, "promised", "mPromised"),
    endpointCorrespondence({ kind: "slot", alternative: 0, frame: "qPromise", slot: "promisor" }, { kind: "slot", frame: "fPromise", slot: "promisor" }, "recipient", "mVega2"),
    endpointCorrespondence({ kind: "predicate", alternative: 0, frame: "qInspect" }, { kind: "frame", frame: "fInspect" }, "inspect", "mInspect"),
    endpointCorrespondence({ kind: "slot", alternative: 0, frame: "qInspect", slot: "object" }, { kind: "slot", frame: "fInspect", slot: "object" }, "parcel", inspectMention)
  ];
}

function reason(
  interpretation: SourceSemanticInterpretation, semantics: SourceSemanticQuery, correspondence: SourceSemanticCorrespondence | undefined,
  original: string
) {
  return reasonSourceSemanticInterpretation({
    source_interpretation: interpretation, query_semantics: semantics, semantic_correspondence: correspondence, original_query: original, workspaceId: "ws-semantic",
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
  interpretation: SourceSemanticInterpretation, semantics: SourceSemanticQuery, correspondence: SourceSemanticCorrespondence,
  result: ReturnType<typeof reason>, variables: readonly string[]
) {
  const oracle = oracleSourceSemanticJoin(interpretation, semantics, correspondence);
  const decoded = decodeEngineBindings(result);
  expect(oracleBindingsMatchEngine(oracle, decoded, variables)).toBe(true);
  expect(oracleNecessaryLeavesHeld(oracle, result.consumed_leaves)).toBe(true);
  expect(oracleProofsMatchEngine(oracle, result)).toBe(true);
  return oracle;
}

describe("source semantic query compilation", () => {
  it("retains an unresolved alternative when another branch has an accepting proof", () => {
    const interpretation = orionInterpretation({ inspectTarget: "rQ" });
    const base = sendInspectQuery();
    const both = base.alternatives[0]!;
    const semantics = { ...base, alternatives: [
      { frames: [both.frames[0]!], context_obligations: [both.context_obligations[0]!] }, both
    ] } satisfies SourceSemanticQuery;
    const map = correspondenceOf(interpretation, semantics, AND_QUERY, [
      endpointCorrespondence({ kind: "predicate", alternative: 0, frame: "qSend" },
        { kind: "frame", frame: "fSend" }, "sent", "mSent"),
      endpointCorrespondence({ kind: "slot", alternative: 0, frame: "qSend", slot: "object" },
        { kind: "slot", frame: "fSend", slot: "object" }, "parcel", "mP1"),
      endpointCorrespondence({ kind: "predicate", alternative: 1, frame: "qSend" },
        { kind: "frame", frame: "fSend" }, "sent", "mSent"),
      endpointCorrespondence({ kind: "slot", alternative: 1, frame: "qSend", slot: "object" },
        { kind: "slot", frame: "fSend", slot: "object" }, "parcel", "mP1"),
      endpointCorrespondence({ kind: "predicate", alternative: 1, frame: "qInspect" },
        { kind: "frame", frame: "fInspect" }, "inspected", "mInspect"),
      endpointCorrespondence({ kind: "slot", alternative: 1, frame: "qInspect", slot: "object" },
        { kind: "slot", frame: "fInspect", slot: "object" }, "parcel", "mQ")
    ]);
    const result = reason(interpretation, semantics, map, AND_QUERY);
    expect(result.binding_results?.some(row => row.alternative === 0)).toBe(true);
    expect(result.binding_results?.some(row => row.alternative === 1)).toBe(false);
    expect(result.attention?.kind).toBe("computed");
    if (result.attention?.kind !== "computed") return;
    expect(result.attention.entries.some(row => row.alternative === 1 &&
      ["unknown", "unobserved", "resource_incomplete"].includes(row.state))).toBe(true);
    expect(result.attention.entries.some(row => row.alternative === 0 && row.frame === null)).toBe(false);
  });

  it("joins a shared-variable AND on the same parcel", () => {
    const interpretation = mixedInterpretation();
    const semantics = sendInspectQuery();
    const correspondence = correspondenceOf(interpretation, semantics, AND_QUERY, SEND_AND);
    const result = reason(interpretation, semantics, correspondence, AND_QUERY);
    expect(result.outcome.status).toBe("interpreted");
    expect(result.world_claim).toBe("unknown");
    expect(hasLeaf(result.consumed_leaves, "source_interpretation_presence", "fSend")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "source_interpretation_presence", "fInspect")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "source_interpretation_assertion_permission", "fSend")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "source_interpretation_assertion_permission", "fInspect")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "source_interpretation_binding", "fSend", "object")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "source_interpretation_binding", "fInspect", "object")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "semantic_correspondence_predicate", "fSend")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "semantic_correspondence_predicate", "fInspect")).toBe(true);
    const oracle = assertOracle(interpretation, semantics, correspondence, result, ["parcel", "fSend", "fInspect"]);
    expect(oracle.assignments).toHaveLength(1);
    expect(oracle.assignments[0]!.bindings).toMatchObject({
      parcel: "rParcel", fSend: "fSend", fInspect: "fInspect"
    });
  });

  it("proves the Orion join from source interpretation and semantic correspondence+assertion+content leaves and rejects inspect-object and same-name Vega", () => {
    const interpretation = orionInterpretation();
    const semantics = joinQuery();
    const correspondence = correspondenceOf(interpretation, semantics, JOIN_QUERY, joinCorrespondences());
    const result = reason(interpretation, semantics, correspondence, JOIN_QUERY);
    expect(result.outcome.status).toBe("interpreted");
    expect(hasLeaf(result.consumed_leaves, "source_interpretation_presence", "fSend")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "source_interpretation_presence", "fPromise")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "source_interpretation_presence", "fInspect")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "source_interpretation_assertion_permission", "fSend")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "source_interpretation_assertion_permission", "fPromise")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "source_interpretation_assertion_permission", "fInspect")).toBe(false);
    expect(hasLeaf(result.consumed_leaves, "source_interpretation_content", "fInspect")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "source_interpretation_binding", "fSend", "object")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "source_interpretation_binding", "fSend", "recipient")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "source_interpretation_binding", "fPromise", "promisor")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "source_interpretation_binding", "fInspect", "object")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "semantic_correspondence_predicate", "fSend")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "semantic_correspondence_predicate", "fPromise")).toBe(true);
    expect(hasLeaf(result.consumed_leaves, "semantic_correspondence_predicate", "fInspect")).toBe(true);
    const joinVars = ["parcel", "recipient", "fSend", "fPromise", "fInspect"] as const;
    const oracle = assertOracle(interpretation, semantics, correspondence, result, joinVars);
    expect(oracle.assignments).toHaveLength(1);
    expect(oracle.assignments[0]!.bindings).toMatchObject({
      parcel: "rP", recipient: "rVega", fSend: "fSend", fPromise: "fPromise", fInspect: "fInspect"
    });
    const childFirst = {
      ...semantics,
      alternatives: [{
        ...semantics.alternatives[0]!,
        frames: [...semantics.alternatives[0]!.frames].reverse()
      }]
    };
    const childFirstCorrespondence = correspondenceOf(interpretation, childFirst, JOIN_QUERY, joinCorrespondences());
    const childFirstResult = reason(interpretation, childFirst, childFirstCorrespondence, JOIN_QUERY);
    expect(hasLeaf(childFirstResult.consumed_leaves, "source_interpretation_content", "fInspect")).toBe(true);
    assertOracle(interpretation, childFirst, childFirstCorrespondence, childFirstResult, joinVars);
    const wrongObject = orionInterpretation({ inspectTarget: "rQ" });
    const wrongCorrespondence = correspondenceOf(wrongObject, semantics, JOIN_QUERY, joinCorrespondences("mQ"));
    const wrongResult = reason(wrongObject, semantics, wrongCorrespondence, JOIN_QUERY);
    expect(wrongResult.consumed_leaves).toEqual([]);
    assertOracle(wrongObject, semantics, wrongCorrespondence, wrongResult, joinVars);
    const split = orionInterpretation({ splitVega: true });
    const splitCorrespondence = correspondenceOf(split, semantics, JOIN_QUERY, joinCorrespondences());
    const splitResult = reason(split, semantics, splitCorrespondence, JOIN_QUERY);
    expect(splitResult.consumed_leaves).toEqual([]);
    assertOracle(split, semantics, splitCorrespondence, splitResult, joinVars);
  });

  it("does not treat promise-content inspect as an already-inspected event", () => {
    const interpretation = orionInterpretation();
    const semantics = inspectedQuery();
    const correspondence = correspondenceOf(interpretation, semantics, INSPECTED_QUERY, [
      endpointCorrespondence({ kind: "predicate", alternative: 0, frame: "qInspect" }, { kind: "frame", frame: "fInspect" }, "inspect", "mInspect"),
      endpointCorrespondence({ kind: "slot", alternative: 0, frame: "qInspect", slot: "object" }, { kind: "slot", frame: "fInspect", slot: "object" }, "parcel", "mP2")
    ]);
    const result = reason(interpretation, semantics, correspondence, INSPECTED_QUERY);
    expect(result.outcome.status).toBe("interpreted");
    expect(result.world_claim).toBe("unknown");
    expect(result.consumed_leaves).toEqual([]);
    expect(assertOracle(interpretation, semantics, correspondence, result, ["parcel", "fInspect"]).assignments).toEqual([]);
  });

  it("cannot AND complementary correspondence documents and can AND one correspondence that maps both", () => {
    const interpretation = mixedInterpretation();
    const semantics = sendInspectQuery();
    const sendOnly = correspondenceOf(interpretation, semantics, AND_QUERY, SEND_AND.slice(0, 2));
    const inspectOnly = correspondenceOf(interpretation, semantics, AND_QUERY, SEND_AND.slice(2));
    const both = correspondenceOf(interpretation, semantics, AND_QUERY, SEND_AND);
    const andVars = ["parcel", "fSend", "fInspect"] as const;
    const sendOnlyResult = reason(interpretation, semantics, sendOnly, AND_QUERY);
    const inspectOnlyResult = reason(interpretation, semantics, inspectOnly, AND_QUERY);
    const bothResult = reason(interpretation, semantics, both, AND_QUERY);
    expect(sendOnlyResult.consumed_leaves).toEqual([]);
    expect(inspectOnlyResult.consumed_leaves).toEqual([]);
    assertOracle(interpretation, semantics, sendOnly, sendOnlyResult, andVars);
    assertOracle(interpretation, semantics, inspectOnly, inspectOnlyResult, andVars);
    expect(hasLeaf(bothResult.consumed_leaves, "semantic_correspondence_predicate", "fSend")).toBe(true);
    assertOracle(interpretation, semantics, both, bothResult, andVars);
    expect(sendOnly.source_interpretation_id).toBe(inspectOnly.source_interpretation_id);
    expect(sendOnly.query_semantics_id).toBe(inspectOnly.query_semantics_id);
    expect(sendOnly.correspondences).not.toEqual(inspectOnly.correspondences);
  });

  it("does not treat question or directive entry as a completed send", () => {
    const semantics = sendQuery();
    const asserted = stanceInterpretation("assertion");
    const question = stanceInterpretation("question");
    const directive = stanceInterpretation("directive");
    const map = (interpretation: SourceSemanticInterpretation, mentionId: string) => correspondenceOf(interpretation, semantics, SEND_QUERY, [
      endpointCorrespondence({ kind: "predicate", alternative: 0, frame: "qSend" }, { kind: "frame", frame: "fSend" }, "sent", "mSent"),
      endpointCorrespondence({ kind: "slot", alternative: 0, frame: "qSend", slot: "object" }, { kind: "slot", frame: "fSend", slot: "object" }, "parcel", mentionId)
    ]);
    const sendVars = ["parcel", "fSend"] as const;
    const assertedResult = reason(asserted, semantics, map(asserted, "mParcel"), SEND_QUERY);
    const questionResult = reason(question, semantics, map(question, "mParcel"), SEND_QUERY);
    const directiveResult = reason(directive, semantics, map(directive, "mParcel"), SEND_QUERY);
    expect(hasLeaf(assertedResult.consumed_leaves, "source_interpretation_assertion_permission", "fSend")).toBe(true);
    assertOracle(asserted, semantics, map(asserted, "mParcel"), assertedResult, sendVars);
    expect(questionResult.consumed_leaves).toEqual([]);
    expect(directiveResult.consumed_leaves).toEqual([]);
    assertOracle(question, semantics, map(question, "mParcel"), questionResult, sendVars);
    assertOracle(directive, semantics, map(directive, "mParcel"), directiveResult, sendVars);
    const asked = queryOf(SEND_QUERY, [{
      id: "qSend", variable: "fSend", predicate_reading: "send", source_act: "question",
      role_requirements: [role("object", "parcel", "parcel")]
    }], [
      { id: "parcel", sort: "entity" }, { id: "fSend", sort: "proposition" }
    ], []);
    const askedMap = (interpretation: SourceSemanticInterpretation) => correspondenceOf(interpretation, asked, SEND_QUERY, [
      endpointCorrespondence({ kind: "predicate", alternative: 0, frame: "qSend" }, { kind: "frame", frame: "fSend" }, "sent", "mSent"),
      endpointCorrespondence({ kind: "slot", alternative: 0, frame: "qSend", slot: "object" }, { kind: "slot", frame: "fSend", slot: "object" }, "parcel", "mParcel")
    ]);
    const askedAgainstAsserted = reason(asserted, asked, askedMap(asserted), SEND_QUERY);
    const askedAgainstQuestion = reason(question, asked, askedMap(question), SEND_QUERY);
    expect(askedAgainstAsserted.consumed_leaves).toEqual([]);
    assertOracle(asserted, asked, askedMap(asserted), askedAgainstAsserted, sendVars);
    expect(hasLeaf(askedAgainstQuestion.consumed_leaves, "source_interpretation_presence", "fSend")).toBe(true);
    assertOracle(question, asked, askedMap(question), askedAgainstQuestion, sendVars);
  });

  it("drops a proof when a necessary correspondence leaf is withdrawn and keeps an unrelated send proof", () => {
    const interpretation = mixedInterpretation();
    const andQuery = sendInspectQuery();
    const onlySend = sendQuery();
    const full = correspondenceOf(interpretation, andQuery, AND_QUERY, SEND_AND);
    const withdrawn = correspondenceOf(interpretation, andQuery, AND_QUERY, SEND_AND.slice(0, 2));
    const andVars = ["parcel", "fSend", "fInspect"] as const;
    const fullResult = reason(interpretation, andQuery, full, AND_QUERY);
    const withdrawnResult = reason(interpretation, andQuery, withdrawn, AND_QUERY);
    expect(fullResult.consumed_leaves.length).toBeGreaterThan(0);
    assertOracle(interpretation, andQuery, full, fullResult, andVars);
    expect(withdrawnResult.consumed_leaves).toEqual([]);
    assertOracle(interpretation, andQuery, withdrawn, withdrawnResult, andVars);
    const sendCorrespondence = correspondenceOf(interpretation, onlySend, SEND_QUERY, [
      endpointCorrespondence({ kind: "predicate", alternative: 0, frame: "qSend" }, { kind: "frame", frame: "fSend" }, "sent", "mSent"),
      endpointCorrespondence({ kind: "slot", alternative: 0, frame: "qSend", slot: "object" }, { kind: "slot", frame: "fSend", slot: "object" }, "parcel", "mParcelSend")
    ]);
    const sendResult = reason(interpretation, onlySend, sendCorrespondence, SEND_QUERY);
    expect(hasLeaf(sendResult.consumed_leaves, "semantic_correspondence_predicate", "fSend")).toBe(true);
    assertOracle(interpretation, onlySend, sendCorrespondence, sendResult, ["parcel", "fSend"]);
  });

  it("returns preparation_required when query semantics or semantic correspondence is missing", () => {
    const interpretation = mixedInterpretation();
    const semantics = sendInspectQuery();
    expect(reasonSourceSemanticInterpretation({
      source_interpretation: interpretation, original_query: AND_QUERY, workspaceId: "ws-semantic",
      scope: "project", authorizedScopes: ["project"], asOf: CLOCK
    }).outcome).toEqual({ status: "preparation_required", missing: "query_semantics_and_correspondence" });
    expect(reasonSourceSemanticInterpretation({
      source_interpretation: interpretation, query_semantics: semantics, original_query: AND_QUERY, workspaceId: "ws-semantic",
      scope: "project", authorizedScopes: ["project"], asOf: CLOCK
    }).outcome).toEqual({ status: "preparation_required", missing: "semantic_correspondence" });
    expect(reason(interpretation, semantics, undefined, AND_QUERY).outcome).toEqual({ status: "preparation_required", missing: "semantic_correspondence" });
  });

  it("drops a proof when a necessary source interpretation binding is withdrawn, rebinds correspondence onto a new source-interpretation identity, and keeps an unrelated send", () => {
    const original = mixedInterpretation();
    const andQuery = sendInspectQuery();
    const onlySend = sendQuery();
    const withdrawnInterpretation: SourceSemanticInterpretation = {
      ...original,
      frames: original.frames.map((row) => row.id === "fInspect" ? { ...row, bindings: [] } : row)
    };
    expect(sourceSemanticInterpretationIdentity(withdrawnInterpretation, fieldContractSha256))
      .not.toBe(sourceSemanticInterpretationIdentity(original, fieldContractSha256));
    const staleCorrespondence = correspondenceOf(original, andQuery, AND_QUERY, SEND_AND);
    expect(reason(withdrawnInterpretation, andQuery, staleCorrespondence, AND_QUERY).outcome).toEqual({
      status: "invalid", reason: "malformed_correspondence"
    });
    const reboundAnd = correspondenceOf(withdrawnInterpretation, andQuery, AND_QUERY, SEND_AND);
    const reboundResult = reason(withdrawnInterpretation, andQuery, reboundAnd, AND_QUERY);
    expect(reboundResult.consumed_leaves).toEqual([]);
    assertOracle(withdrawnInterpretation, andQuery, reboundAnd, reboundResult, ["parcel", "fSend", "fInspect"]);
    const sendCorrespondence = correspondenceOf(withdrawnInterpretation, onlySend, SEND_QUERY, [
      endpointCorrespondence({ kind: "predicate", alternative: 0, frame: "qSend" }, { kind: "frame", frame: "fSend" }, "sent", "mSent"),
      endpointCorrespondence({ kind: "slot", alternative: 0, frame: "qSend", slot: "object" }, { kind: "slot", frame: "fSend", slot: "object" }, "parcel", "mParcelSend")
    ]);
    const sendResult = reason(withdrawnInterpretation, onlySend, sendCorrespondence, SEND_QUERY);
    expect(hasLeaf(sendResult.consumed_leaves, "semantic_correspondence_predicate", "fSend")).toBe(true);
    assertOracle(withdrawnInterpretation, onlySend, sendCorrespondence, sendResult, ["parcel", "fSend"]);
    expect(sendCorrespondence.source_interpretation_id).toBe(reboundAnd.source_interpretation_id);
  });

  it("keeps an independent send alternative after inspect correspondence leaves are withdrawn", () => {
    const interpretation = mixedInterpretation();
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
    const bothCorrespondence = correspondenceOf(interpretation, either, AND_QUERY, [
      ...SEND_AND.slice(0, 2),
      endpointCorrespondence({ kind: "predicate", alternative: 1, frame: "qInspect" }, { kind: "frame", frame: "fInspect" }, "inspected", "mInspected"),
      endpointCorrespondence({ kind: "slot", alternative: 1, frame: "qInspect", slot: "object" }, { kind: "slot", frame: "fInspect", slot: "object" }, "parcel", "mParcelInspect")
    ]);
    const both = reason(interpretation, either, bothCorrespondence, AND_QUERY);
    expect(assertOracle(interpretation, either, bothCorrespondence, both, ["parcel", "fSend", "fInspect"]).assignments).toHaveLength(2);
    const sendOnlyCorrespondence = correspondenceOf(interpretation, either, AND_QUERY, SEND_AND.slice(0, 2));
    const remaining = reason(interpretation, either, sendOnlyCorrespondence, AND_QUERY);
    const remainingOracle = assertOracle(interpretation, either, sendOnlyCorrespondence, remaining, ["parcel", "fSend", "fInspect"]);
    expect(remainingOracle.assignments).toHaveLength(1);
    expect(remainingOracle.assignments[0]!.bindings).toMatchObject({ parcel: "rParcel", fSend: "fSend" });
    expect(hasLeaf(remaining.consumed_leaves, "semantic_correspondence_predicate", "fInspect")).toBe(false);
  });

  it("seeds every entry root rather than a single sending seed", () => {
    const interpretation = mixedInterpretation();
    const inspect = inspectedQuery();
    const inspectCorrespondence = correspondenceOf(interpretation, inspect, INSPECTED_QUERY, [
      endpointCorrespondence({ kind: "predicate", alternative: 0, frame: "qInspect" }, { kind: "frame", frame: "fInspect" }, "inspected", "mInspected"),
      endpointCorrespondence({ kind: "slot", alternative: 0, frame: "qInspect", slot: "object" }, { kind: "slot", frame: "fInspect", slot: "object" }, "parcel", "mParcelInspect")
    ]);
    const inspectResult = reason(interpretation, inspect, inspectCorrespondence, INSPECTED_QUERY);
    expect(hasLeaf(inspectResult.consumed_leaves, "source_interpretation_presence", "fInspect")).toBe(true);
    assertOracle(interpretation, inspect, inspectCorrespondence, inspectResult, ["parcel", "fInspect"]);
    const reversed: SourceSemanticInterpretation = { ...interpretation, entry_roots: ["fInspect", "fSend"] };
    const reversedCorrespondence = correspondenceOf(reversed, inspect, INSPECTED_QUERY, inspectCorrespondence.correspondences as SourceSemanticEndpointCorrespondence[]);
    assertOracle(reversed, inspect, reversedCorrespondence, reason(reversed, inspect, reversedCorrespondence, INSPECTED_QUERY), ["parcel", "fInspect"]);
    const send = sendQuery();
    const sendCorrespondence = correspondenceOf(interpretation, send, SEND_QUERY, [
      endpointCorrespondence({ kind: "predicate", alternative: 0, frame: "qSend" }, { kind: "frame", frame: "fSend" }, "sent", "mSent"),
      endpointCorrespondence({ kind: "slot", alternative: 0, frame: "qSend", slot: "object" }, { kind: "slot", frame: "fSend", slot: "object" }, "parcel", "mParcelSend")
    ]);
    assertOracle(interpretation, send, sendCorrespondence, reason(interpretation, send, sendCorrespondence, SEND_QUERY), ["parcel", "fSend"]);
  });

  it("agrees under alpha-renamed query variables, ignored extra source interpretation frames, and swapped role order", () => {
    const interpretation = mixedInterpretation();
    const semantics = sendInspectQuery();
    const rename = (id: string) => id === "parcel" ? "item" : id === "fSend" ? "sendEvent" : id === "fInspect" ? "inspectEvent" : id;
    const renamed: SourceSemanticQuery = {
      ...semantics,
      variables: semantics.variables.map((row) => ({ ...row, id: rename(row.id) })),
      return_variables: semantics.return_variables.map(rename),
      alternatives: semantics.alternatives.map((alternative) => ({
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
    const renamedCorrespondence = correspondenceOf(interpretation, renamed, AND_QUERY, SEND_AND);
    const renamedResult = reason(interpretation, renamed, renamedCorrespondence, AND_QUERY);
    const renamedOracle = assertOracle(interpretation, renamed, renamedCorrespondence, renamedResult, ["item", "sendEvent", "inspectEvent"]);
    expect(renamedOracle.assignments[0]!.bindings).toMatchObject({
      item: "rParcel", sendEvent: "fSend", inspectEvent: "fInspect"
    });
    const extra: SourceSemanticInterpretation = {
      ...interpretation,
      mentions: [...interpretation.mentions, mention("mPacked", "packed", 3, [29, 35])],
      referents: [...interpretation.referents, { id: "rOther", referent_kind: "grouped", mentions: ["mPacked"] }],
      frames: [...interpretation.frames, frame({
        id: "fPack", reading: "pack", mention: "mPacked", assertion: 3,
        slots: [{ id: "object", target: "rOther", mention: "mPacked" }]
      })],
      entry_roots: ["fSend", "fInspect", "fPack"],
      asserted_at_scope: ["fSend", "fInspect", "fPack"]
    };
    const extraCorrespondence = correspondenceOf(extra, semantics, AND_QUERY, SEND_AND);
    const extraResult = reason(extra, semantics, extraCorrespondence, AND_QUERY);
    expect(hasLeaf(extraResult.consumed_leaves, "source_interpretation_presence", "fPack")).toBe(false);
    assertOracle(extra, semantics, extraCorrespondence, extraResult, ["parcel", "fSend", "fInspect"]);
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
    const orion = orionInterpretation();
    const swappedCorrespondence = correspondenceOf(orion, swapped, JOIN_QUERY, joinCorrespondences());
    assertOracle(orion, swapped, swappedCorrespondence, reason(orion, swapped, swappedCorrespondence, JOIN_QUERY), [
      "parcel", "recipient", "fSend", "fPromise", "fInspect"
    ]);
  });

  it("exhausts a shared budget without treating the interrupt as global absence", () => {
    const interpretation = mixedInterpretation();
    const semantics = sendInspectQuery();
    const correspondence = correspondenceOf(interpretation, semantics, AND_QUERY, SEND_AND);
    const admitted = admitSourceSemanticCorrespondence({
      semantic_correspondence: correspondence, source_interpretation: interpretation, query_semantics: semantics, original_query: AND_QUERY
    });
    expect(admitted.kind).toBe("admitted");
    if (admitted.kind !== "admitted") return;
    const result = reasonSourceSemanticInterpretation({
      source_interpretation: interpretation, query_semantics: semantics, semantic_correspondence: correspondence, original_query: AND_QUERY, workspaceId: "ws-semantic",
      scope: "project", authorizedScopes: ["project"], asOf: CLOCK,
      request: {
        contract: "source-interpretation-reasoning-v5",
        accepts_unreviewed_conditional_results: true,
        source_interpretation_id: admitted.interpretation_id, query_semantics_id: admitted.query_id, semantic_correspondence_id: admitted.semantic_correspondence_id,
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

  it("refuses a legacy packet as an open source interpretation", () => {
    const interpretation = mixedInterpretation(), semantics = sendInspectQuery(), correspondence = correspondenceOf(interpretation, semantics, AND_QUERY, SEND_AND);
    expect(reasonSourceSemanticInterpretation({ source_interpretation: { ...interpretation, contract: "source-interpretation-v2" }, query_semantics: semantics, semantic_correspondence: correspondence,
      original_query: AND_QUERY, workspaceId: "ws-semantic", scope: "project", authorizedScopes: ["project"], asOf: CLOCK
    }).outcome).toEqual({ status: "invalid", reason: "malformed_interpretation" });
  });
});
