import { describe, expect, it } from "vitest";
import {
  SOURCE_SEMANTIC_K_VERSION, SOURCE_SEMANTIC_NORMALIZER_VERSION,
  SourceSemanticCorrespondenceSchema, sourceSemanticCorrespondenceIdentity, sourceSemanticContextIdentity,
  sourceSemanticInterpretationIdentity,
  UNKNOWN_UTTERANCE_ATTRIBUTION,
  type SourceSemanticEndpointCorrespondence, type SourceSemanticInterpretation, type SourceSemanticQuery,
  type SourceSemanticQueryFrame, type SourceSemanticQueryVariable
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../../../shared/field-hash.js";
import { digestOriginalQuery } from "../../../../recall/conditional-field/query/compile-query-identity.js";
import { admitSourceSemanticQuery } from "../../../../recall/conditional-field/query/source-semantic-query-admission.js";
import { SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID } from "../../../../recall/conditional-field/query/source-semantic-query-producer-registry.js";
import {
  admitSourceSemanticCorrespondence, SOURCE_SEMANTIC_LOWERING_VERSION
} from "../../../../recall/conditional-field/query/source-semantic-correspondence-admission.js";
import {
  SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_ID,
  SourceSemanticCorrespondenceProducerRegistry, sourceSemanticCorrespondenceProducerRecord
} from "../../../../recall/conditional-field/query/source-semantic-correspondence-producer-registry.js";

const ORIGINAL = "which parcel was sent and inspected?";
const FOREIGN = `sha256:${"b".repeat(64)}`;

const role = (id: string, variable: string, excerpt: string) => ({
  id, role_reading: id, target_variable: variable, support: { kind: "query_text" as const, excerpt }
});

function queryDraft(
  frames: SourceSemanticQueryFrame[],
  variables: SourceSemanticQueryVariable[],
  extra: { readonly producer_id?: string; readonly producer_version?: string } = {}
): SourceSemanticQuery {
  return {
    contract: "source-semantic-query-v4",
    original_query_digest: digestOriginalQuery(ORIGINAL),
    approved_fixed_context: null, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    producer_id: extra.producer_id ?? SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID,
    producer_version: extra.producer_version ?? "1",
    contract_version: "source-semantic-query-v4",
    variables,
    alternatives: [{
      frames,
      context_obligations: frames.map((frame) => ({ frame: frame.id, kind: "asserted_at_source" as const }))
    }],
    return_variables: ["parcel"],
    gaps: []
  };
}

function sendAndInspectQuery() {
  return queryDraft([{
    id: "qSend", variable: "fSend", predicate_reading: "send",
    role_requirements: [role("object", "parcel", "parcel")]
  }, {
    id: "qInspect", variable: "fInspect", predicate_reading: "inspect",
    role_requirements: [role("object", "parcel", "parcel")]
  }], [
    { id: "parcel", sort: "entity" },
    { id: "fSend", sort: "proposition" },
    { id: "fInspect", sort: "proposition" }
  ]);
}

function mention(id: string, text: string, assertionId: number, span: readonly [number, number]) {
  return {
    id, assertion_id: assertionId, source_ref: { first: `a${assertionId}s0`, last: `a${assertionId}s0` },
    text, utf8_span: span
  };
}

function assertedFrame(
  id: string,
  reading: string,
  mentionId: string,
  assertionId: number,
  slots: readonly { id: string; target: string; mention: string }[]
) {
  return {
    id, assertion_ids: [assertionId],
    context_owner: { kind: "source_act" as const, source_act: "assertion" as const },
    additional_support: [],
    predicate_support: { kind: "explicit" as const, reading, mentions: [mentionId] },
    slots: slots.map((slot) => ({
      id: slot.id, role_reading: slot.id, support: [{ kind: "lexical" as const, mentions: [slot.mention] }]
    })),
    bindings: slots.map((slot) => ({
      slot_id: slot.id, target: { kind: "node" as const, id: slot.target }, support: []
    }))
  };
}

function mixedInterpretation(sourceId = "src", sourceVersion = "1"): SourceSemanticInterpretation {
  return {
    contract: "source-interpretation-v4",
    k_version: SOURCE_SEMANTIC_K_VERSION,
    normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
    source: { source_id: sourceId, source_version: sourceVersion, content_digest: digestOriginalQuery(ORIGINAL),
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION },
    producer_id: "source-interpretation-producer", producer_version: "1", contract_version: "source-interpretation-v4",
    mentions: [
      mention("mSent", "sent", 1, [0, 4]),
      mention("mParcelSend", "parcel", 1, [5, 11]),
      mention("mInspected", "inspected", 2, [12, 21]),
      mention("mParcelInspect", "parcel", 2, [22, 28])
    ],
    referents: [{ id: "rParcel", referent_kind: "grouped", mentions: ["mParcelSend", "mParcelInspect"] }],
    frames: [
      assertedFrame("fSend", "send", "mSent", 1, [
        { id: "object", target: "rParcel", mention: "mParcelSend" },
        { id: "slot1", target: "rParcel", mention: "mParcelSend" }
      ]),
      assertedFrame("fInspect", "inspect", "mInspected", 2, [
        { id: "object", target: "rParcel", mention: "mParcelInspect" },
        { id: "slot1", target: "rParcel", mention: "mParcelInspect" }
      ])
    ],
    operators: [], gaps: [], entry_roots: ["fSend", "fInspect"], asserted_at_scope: ["fSend", "fInspect"]
  };
}

function correspondence(
  query: SourceSemanticQueryEndpointDraft, source: SourceSemanticSourceEndpointDraft, excerpt: string, mentionId: string
): SourceSemanticEndpointCorrespondence {
  return {
    relation: "contextual_equivalence",
    query_endpoint: query,
    source_endpoint: source,
    query_support: { kind: "query_text", excerpt },
    source_semantic_support: [{ kind: "lexical", mentions: [mentionId] }]
  };
}

type SourceSemanticQueryEndpointDraft = SourceSemanticEndpointCorrespondence["query_endpoint"];
type SourceSemanticSourceEndpointDraft = SourceSemanticEndpointCorrespondence["source_endpoint"];

const SEND_PRED = correspondence(
  { kind: "predicate", alternative: 0, frame: "qSend" },
  { kind: "frame", frame: "fSend" }, "sent", "mSent"
);
const SEND_OBJECT = correspondence(
  { kind: "slot", alternative: 0, frame: "qSend", slot: "object" },
  { kind: "slot", frame: "fSend", slot: "object" }, "parcel", "mParcelSend"
);
const INSPECT_PRED = correspondence(
  { kind: "predicate", alternative: 0, frame: "qInspect" },
  { kind: "frame", frame: "fInspect" }, "inspected", "mInspected"
);
const INSPECT_OBJECT = correspondence(
  { kind: "slot", alternative: 0, frame: "qInspect", slot: "object" },
  { kind: "slot", frame: "fInspect", slot: "object" }, "parcel", "mParcelInspect"
);

function correspondenceBody(
  interpretationId: string, queryId: string, correspondences: SourceSemanticEndpointCorrespondence[],
  extra: { readonly producer_id?: string; readonly producer_version?: string } = {}
) {
  return {
    contract: "source-semantic-correspondence-v3" as const,
    source_interpretation_id: interpretationId, query_semantics_id: queryId,
    producer_id: extra.producer_id ?? SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID,
    producer_version: extra.producer_version ?? "1",
    contract_version: "source-semantic-correspondence-v3",
    correspondences
  };
}

function admitPair(
  correspondences: SourceSemanticEndpointCorrespondence[],
  extra: {
    readonly interpretation?: SourceSemanticInterpretation;
    readonly semantics?: SourceSemanticQuery;
    readonly original_query?: string;
    readonly semantic_correspondence?: Record<string, unknown>;
  } = {}
) {
  const interpretation = extra.interpretation ?? mixedInterpretation();
  const semantics = extra.semantics ?? sendAndInspectQuery();
  const queryAdmission = admitSourceSemanticQuery(semantics, extra.original_query ?? ORIGINAL);
  if (queryAdmission.kind !== "admitted") {
    return {
      queryAdmission,
      interpretation,
      semantics,
      interpretationId: sourceSemanticInterpretationIdentity(interpretation, fieldContractSha256),
      admission: admitSourceSemanticCorrespondence({
        semantic_correspondence: extra.semantic_correspondence ?? correspondenceBody(
          sourceSemanticInterpretationIdentity(interpretation, fieldContractSha256), FOREIGN, correspondences
        ),
        source_interpretation: interpretation, query_semantics: semantics, original_query: extra.original_query ?? ORIGINAL
      })
    };
  }
  const interpretationId = sourceSemanticInterpretationIdentity(interpretation, fieldContractSha256);
  const semantic_correspondence = extra.semantic_correspondence ?? correspondenceBody(interpretationId, queryAdmission.query_id, correspondences);
  return {
    queryAdmission, interpretation, semantics, interpretationId,
    admission: admitSourceSemanticCorrespondence({
      semantic_correspondence, source_interpretation: interpretation, query_semantics: semantics, original_query: extra.original_query ?? ORIGINAL
    })
  };
}

describe("source semantic correspondence admission", () => {
  it("admits mixed semantic correspondence as two incomplete conditional computations values, and one complete semantic correspondence as one conditional computation", () => {
    const sendOnly = admitPair([SEND_PRED, SEND_OBJECT]);
    const inspectOnly = admitPair([INSPECT_PRED, INSPECT_OBJECT]);
    const both = admitPair([SEND_PRED, SEND_OBJECT, INSPECT_PRED, INSPECT_OBJECT]);
    expect(sendOnly.admission.kind).toBe("admitted");
    expect(inspectOnly.admission.kind).toBe("admitted");
    expect(both.admission.kind).toBe("admitted");
    if (sendOnly.admission.kind !== "admitted" || inspectOnly.admission.kind !== "admitted" ||
        both.admission.kind !== "admitted") return;
    expect(sendOnly.admission.context_id).not.toBe(inspectOnly.admission.context_id);
    expect(sendOnly.admission.context_id).not.toBe(both.admission.context_id);
    expect(inspectOnly.admission.context_id).not.toBe(both.admission.context_id);
    expect(sendOnly.admission.semantic_correspondence_id).not.toBe(inspectOnly.admission.semantic_correspondence_id);
    const sendOccurrences = sendOnly.admission.leaves.map((leaf) => leaf.occurrence);
    const inspectOccurrences = inspectOnly.admission.leaves.map((leaf) => leaf.occurrence);
    expect(sendOccurrences).toEqual(["fSend", "fSend"]);
    expect(inspectOccurrences).toEqual(["fInspect", "fInspect"]);
    expect(sendOnly.admission.leaves.some((leaf) => leaf.occurrence === "fInspect")).toBe(false);
    expect(inspectOnly.admission.leaves.some((leaf) => leaf.occurrence === "fSend")).toBe(false);
    expect(both.admission.leaves.map((leaf) => leaf.occurrence)).toEqual([
      "fSend", "fSend", "fInspect", "fInspect"
    ]);
    expect(both.admission.leaves.map((leaf) => leaf.correspondence_index)).toEqual([0, 1, 2, 3]);
    expect(both.admission.leaves.every((leaf) => leaf.leaf_kind === "semantic_correspondence_predicate" || leaf.leaf_kind === "semantic_correspondence_slot"))
      .toBe(true);
    expect(JSON.stringify(both.admission.leaves)).not.toMatch(/source_interpretation_presence|source_interpretation_binding|source_interpretation_assertion_permission/u);
    expect(both.admission.context).toEqual({
      contract: "source-semantic-context-v3",
      source_interpretation_id: both.admission.interpretation_id,
      query_semantics_id: both.admission.query_id,
      semantic_correspondence_id: both.admission.semantic_correspondence_id,
      k_version: SOURCE_SEMANTIC_K_VERSION,
      lowering_version: SOURCE_SEMANTIC_LOWERING_VERSION
    });
    expect(both.admission.context_id)
      .toBe(sourceSemanticContextIdentity(both.admission.context, fieldContractSha256));
    expect(both.admission.semantic_correspondence_id)
      .toBe(sourceSemanticCorrespondenceIdentity(both.admission.semantic_correspondence, fieldContractSha256));
    expect(JSON.stringify(both.admission.semantic_correspondence)).not.toContain(both.admission.context_id);
  });

  it("does not unify the same slot label on two frames", () => {
    const sendSlot1 = correspondence(
      { kind: "slot", alternative: 0, frame: "qSend", slot: "object" },
      { kind: "slot", frame: "fSend", slot: "slot1" }, "parcel", "mParcelSend"
    );
    const admission = admitPair([sendSlot1]).admission;
    expect(admission.kind).toBe("admitted");
    if (admission.kind !== "admitted") return;
    expect(admission.leaves).toEqual([{
      leaf_kind: "semantic_correspondence_slot", correspondence_index: 0, occurrence: "fSend", slot_id: "slot1"
    }]);
    expect(admission.leaves.some((leaf) => leaf.occurrence === "fInspect" && leaf.slot_id === "slot1")).toBe(false);
    const inspectSlot1 = correspondence(
      { kind: "slot", alternative: 0, frame: "qInspect", slot: "object" },
      { kind: "slot", frame: "fInspect", slot: "slot1" }, "parcel", "mParcelInspect"
    );
    const other = admitPair([inspectSlot1]).admission;
    expect(other.kind).toBe("admitted");
    if (other.kind !== "admitted") return;
    expect(other.context_id).not.toBe(admission.context_id);
    expect(other.leaves).toEqual([{
      leaf_kind: "semantic_correspondence_slot", correspondence_index: 0, occurrence: "fInspect", slot_id: "slot1"
    }]);
  });

  it("rejects foreign source interpretation id, query-semantics id, source, and version", () => {
    const interpretation = mixedInterpretation();
    const semantics = sendAndInspectQuery();
    const queryAdmission = admitSourceSemanticQuery(semantics, ORIGINAL);
    expect(queryAdmission.kind).toBe("admitted");
    if (queryAdmission.kind !== "admitted") return;
    const interpretationId = sourceSemanticInterpretationIdentity(interpretation, fieldContractSha256);
    const base = correspondenceBody(interpretationId, queryAdmission.query_id, [SEND_PRED]);
    expect(admitSourceSemanticCorrespondence({
      semantic_correspondence: { ...base, source_interpretation_id: FOREIGN }, source_interpretation: interpretation, query_semantics: semantics, original_query: ORIGINAL
    }).kind).toBe("invalid");
    expect(admitSourceSemanticCorrespondence({
      semantic_correspondence: { ...base, query_semantics_id: FOREIGN }, source_interpretation: interpretation, query_semantics: semantics, original_query: ORIGINAL
    }).kind).toBe("invalid");
    const foreignSource = mixedInterpretation("other-src", "1");
    expect(admitSourceSemanticCorrespondence({
      semantic_correspondence: base, source_interpretation: foreignSource, query_semantics: semantics, original_query: ORIGINAL
    }).kind).toBe("invalid");
    const foreignVersion = mixedInterpretation("src", "2");
    expect(admitSourceSemanticCorrespondence({
      semantic_correspondence: base, source_interpretation: foreignVersion, query_semantics: semantics, original_query: ORIGINAL
    }).kind).toBe("invalid");
    expect(sourceSemanticInterpretationIdentity(foreignSource, fieldContractSha256)).not.toBe(interpretationId);
    expect(sourceSemanticInterpretationIdentity(foreignVersion, fieldContractSha256)).not.toBe(interpretationId);
  });

  it("omitting a correspondence leaves that correspondence leaf absent with no silent fill", () => {
    const sendOnly = admitPair([SEND_PRED, SEND_OBJECT]).admission;
    const both = admitPair([SEND_PRED, SEND_OBJECT, INSPECT_PRED, INSPECT_OBJECT]).admission;
    expect(sendOnly.kind).toBe("admitted");
    expect(both.kind).toBe("admitted");
    if (sendOnly.kind !== "admitted" || both.kind !== "admitted") return;
    expect(sendOnly.leaves).toHaveLength(2);
    expect(both.leaves).toHaveLength(4);
    expect(sendOnly.leaves.map((leaf) => leaf.correspondence_index)).toEqual([0, 1]);
    expect(sendOnly.leaves.some((leaf) => leaf.occurrence === "fInspect")).toBe(false);
    expect(both.leaves.some((leaf) => leaf.leaf_kind === "semantic_correspondence_predicate" && leaf.occurrence === "fInspect")).toBe(true);
  });

  it("rejects send⇒transfer and extra relation kinds by schema or admission", () => {
    const interpretation = mixedInterpretation();
    const semantics = sendAndInspectQuery();
    const queryAdmission = admitSourceSemanticQuery(semantics, ORIGINAL);
    expect(queryAdmission.kind).toBe("admitted");
    if (queryAdmission.kind !== "admitted") return;
    const interpretationId = sourceSemanticInterpretationIdentity(interpretation, fieldContractSha256);
    const entailment = {
      ...SEND_PRED,
      relation: "entailment"
    };
    const arrow = {
      ...correspondenceBody(interpretationId, queryAdmission.query_id, [SEND_PRED]),
      correspondences: [{ ...SEND_PRED, relation: "send⇒transfer" }]
    };
    expect(SourceSemanticCorrespondenceSchema.safeParse(
      correspondenceBody(interpretationId, queryAdmission.query_id, [entailment as unknown as SourceSemanticEndpointCorrespondence])
    ).success).toBe(false);
    expect(SourceSemanticCorrespondenceSchema.safeParse(arrow).success).toBe(false);
    expect(admitSourceSemanticCorrespondence({
      semantic_correspondence: correspondenceBody(interpretationId, queryAdmission.query_id, [
        { ...SEND_PRED, relation: "entailment" } as unknown as SourceSemanticEndpointCorrespondence
      ]),
      source_interpretation: interpretation, query_semantics: semantics, original_query: ORIGINAL
    }).kind).toBe("invalid");
    expect(admitSourceSemanticCorrespondence({
      semantic_correspondence: { ...correspondenceBody(interpretationId, queryAdmission.query_id, [SEND_PRED]), direction: "forward" },
      source_interpretation: interpretation, query_semantics: semantics, original_query: ORIGINAL
    }).kind).toBe("invalid");
  });

  it("rejects query semantics rewritten by semantic correspondence, answer ids, program, seed, rank, milligrades, and return bindings", () => {
    const interpretation = mixedInterpretation();
    const semantics = sendAndInspectQuery();
    const queryAdmission = admitSourceSemanticQuery(semantics, ORIGINAL);
    expect(queryAdmission.kind).toBe("admitted");
    if (queryAdmission.kind !== "admitted") return;
    const interpretationId = sourceSemanticInterpretationIdentity(interpretation, fieldContractSha256);
    const base = correspondenceBody(interpretationId, queryAdmission.query_id, [SEND_PRED]);
    const forgeries = [
      { ...base, answer_id: "ans" },
      { ...base, answer_ids: ["ans"] },
      { ...base, program: { kind: "epsilon" } },
      { ...base, seed_nodes: ["fSend"] },
      { ...base, seed: "fSend" },
      { ...base, rank: 1 },
      { ...base, milligrades: 1000 },
      { ...base, return_variables: ["parcel"] },
      { ...base, return_variable_bindings: { parcel: "rParcel" } },
      { ...base, alternatives: semantics.alternatives },
      { ...base, original_query_digest: digestOriginalQuery(ORIGINAL) }
    ];
    for (const forged of forgeries) {
      expect(SourceSemanticCorrespondenceSchema.safeParse(forged).success).toBe(false);
      expect(admitSourceSemanticCorrespondence({
        semantic_correspondence: forged, source_interpretation: interpretation, query_semantics: semantics, original_query: ORIGINAL
      }).kind).toBe("invalid");
    }
    expect(admitSourceSemanticCorrespondence({
      semantic_correspondence: { ...base, query_semantics_id: sourceSemanticInterpretationIdentity(interpretation, fieldContractSha256) },
      source_interpretation: interpretation, query_semantics: semantics, original_query: ORIGINAL
    }).kind).toBe("invalid");
    expect(admitSourceSemanticCorrespondence({
      semantic_correspondence: base, source_interpretation: interpretation, query_semantics: semantics, original_query: "a different original query"
    }).kind).toBe("invalid");
  });

  it("rejects unknown endpoints, kind mismatch, and support that is not on this source interpretation", () => {
    const missingFrame = admitPair([
      correspondence(
        { kind: "predicate", alternative: 0, frame: "qMissing" },
        { kind: "frame", frame: "fSend" }, "sent", "mSent"
      )
    ]).admission;
    expect(missingFrame.kind).toBe("invalid");
    const kindMismatch = admitPair([
      correspondence(
        { kind: "predicate", alternative: 0, frame: "qSend" },
        { kind: "slot", frame: "fSend", slot: "object" }, "sent", "mSent"
      )
    ]).admission;
    expect(kindMismatch.kind).toBe("invalid");
    const foreignMention = admitPair([
      { ...SEND_PRED, source_semantic_support: [{ kind: "lexical", mentions: ["mForeign"] }] }
    ]).admission;
    expect(foreignMention.kind).toBe("invalid");
    const foreignContext = admitPair([
      { ...SEND_PRED, applicable_context: "fMissing" }
    ]).admission;
    expect(foreignContext.kind).toBe("invalid");
  });

  it("rejects an unregistered or capability-less semantic-correspondence producer and does not treat missing semantic correspondence as query semantics", () => {
    const interpretation = mixedInterpretation();
    const semantics = sendAndInspectQuery();
    const queryAdmission = admitSourceSemanticQuery(semantics, ORIGINAL);
    expect(queryAdmission.kind).toBe("admitted");
    if (queryAdmission.kind !== "admitted") return;
    const interpretationId = sourceSemanticInterpretationIdentity(interpretation, fieldContractSha256);
    const forged = correspondenceBody(interpretationId, queryAdmission.query_id, [SEND_PRED], {
      producer_id: "forged.semantic_correspondence.v1"
    });
    expect(admitSourceSemanticCorrespondence({ semantic_correspondence: forged, source_interpretation: interpretation, query_semantics: semantics, original_query: ORIGINAL }).kind)
      .toBe("unsupported");
    const empty = new SourceSemanticCorrespondenceProducerRegistry([]);
    expect(admitSourceSemanticCorrespondence({
      semantic_correspondence: correspondenceBody(interpretationId, queryAdmission.query_id, [SEND_PRED]),
      source_interpretation: interpretation, query_semantics: semantics, original_query: ORIGINAL, registry: empty
    }).kind).toBe("unsupported");
    const registry = new SourceSemanticCorrespondenceProducerRegistry([
      sourceSemanticCorrespondenceProducerRecord(SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, { capabilities: [] })
    ]);
    expect(admitSourceSemanticCorrespondence({
      semantic_correspondence: correspondenceBody(interpretationId, queryAdmission.query_id, [SEND_PRED]),
      source_interpretation: interpretation, query_semantics: semantics, original_query: ORIGINAL, registry
    }).kind).toBe("unsupported");
    expect(admitSourceSemanticCorrespondence({
      semantic_correspondence: correspondenceBody(interpretationId, queryAdmission.query_id, [SEND_PRED], {
        producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_ID
      }),
      source_interpretation: interpretation, query_semantics: semantics, original_query: ORIGINAL
    }).kind).toBe("admitted");
    expect(admitSourceSemanticCorrespondence({
      semantic_correspondence: undefined, source_interpretation: interpretation, query_semantics: semantics, original_query: ORIGINAL
    }).kind).toBe("absent");
  });
});
