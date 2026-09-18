import { describe, expect, it } from "vitest";
import {
  SourceSemanticQuerySchema,
  queryAlternativeConnected,
  sourceSemanticQueryIdentity,
  type SourceSemanticContextObligation,
  type SourceSemanticQuery,
  type SourceSemanticQueryAlternative,
  type SourceSemanticQueryFrame,
  type SourceSemanticQueryVariable
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../../../shared/field-hash.js";
import { digestOriginalQuery } from "../../../../recall/conditional-field/query/compile-query-identity.js";
import { admitSourceSemanticQuery } from "../../../../recall/conditional-field/query/source-semantic-query-admission.js";
import {
  SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID,
  SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID,
  SourceSemanticQueryProducerRegistry,
  sourceSemanticQueryProducerRecord
} from "../../../../recall/conditional-field/query/source-semantic-query-producer-registry.js";

const SAME_PARCEL = "which parcel was packed and inspected?";
const COMPLETED_SEND = "which parcel has already been sent by Bob to Alice?";
const PROMISED_SEND = "what did Bob promise to send to Alice?";
const ASKED_SEND = "what sending was asked about?";
const UNRESOLVED_SEND = "which sending is not required to be a completed event?";

const role = (id: string, variable: string, excerpt: string) => ({
  id,
  role_reading: id,
  target_variable: variable,
  support: { kind: "query_text" as const, excerpt }
});

function draft(
  originalQuery: string,
  frames: SourceSemanticQueryFrame[],
  obligations: SourceSemanticContextObligation[],
  variables: SourceSemanticQueryVariable[],
  extra: {
    readonly producer_id?: string;
    readonly producer_version?: string;
    readonly return_variables?: readonly string[];
    readonly gaps?: SourceSemanticQuery["gaps"];
    readonly alternatives?: SourceSemanticQueryAlternative[];
  } = {}
) {
  return {
    contract: "source-semantic-query-v1" as const,
    original_query_digest: digestOriginalQuery(originalQuery),
    producer_id: extra.producer_id ?? SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID,
    producer_version: extra.producer_version ?? "1",
    contract_version: "source-semantic-query-v1",
    variables,
    alternatives: extra.alternatives ?? [{ frames, context_obligations: obligations }],
    return_variables: extra.return_variables ?? ["parcel"],
    gaps: extra.gaps ?? []
  };
}

function sameParcelQuery() {
  return draft(SAME_PARCEL, [{
    id: "qPack",
    variable: "fPack",
    predicate_reading: "pack",
    role_requirements: [role("object", "parcel", "parcel")]
  }, {
    id: "qInspect",
    variable: "fInspect",
    predicate_reading: "inspect",
    role_requirements: [role("object", "parcel", "parcel")]
  }], [
    { frame: "qPack", kind: "asserted_at_source" },
    { frame: "qInspect", kind: "asserted_at_source" }
  ], [
    { id: "parcel", sort: "entity" },
    { id: "fPack", sort: "proposition" },
    { id: "fInspect", sort: "proposition" }
  ]);
}

function completedSendQuery() {
  return draft(COMPLETED_SEND, [{
    id: "qSend",
    variable: "fSend",
    predicate_reading: "send",
    role_requirements: [
      role("agent", "sender", "Bob"),
      role("object", "parcel", "parcel"),
      role("recipient", "recipient", "Alice")
    ]
  }], [{ frame: "qSend", kind: "asserted_at_source" }], [
    { id: "sender", sort: "entity" },
    { id: "parcel", sort: "entity" },
    { id: "recipient", sort: "entity" },
    { id: "fSend", sort: "proposition" }
  ]);
}

function promisedSendQuery() {
  return draft(PROMISED_SEND, [{
    id: "qPromise",
    variable: "fPromise",
    predicate_reading: "promise",
    role_requirements: [role("promisor", "promisor", "Bob")]
  }, {
    id: "qSend",
    variable: "fSend",
    predicate_reading: "send",
    role_requirements: [
      role("object", "parcel", "parcel"),
      role("recipient", "recipient", "Alice")
    ]
  }], [
    { frame: "qPromise", kind: "asserted_at_source" },
    {
      frame: "qSend",
      kind: "explicit_embedded_structure",
      incidence: { kind: "embedding", other_frame: "qPromise", role: "content" }
    }
  ], [
    { id: "promisor", sort: "entity" },
    { id: "parcel", sort: "entity" },
    { id: "recipient", sort: "entity" },
    { id: "fPromise", sort: "proposition" },
    { id: "fSend", sort: "proposition" }
  ]);
}

describe("source semantic query admission", () => {
  it("admits same-parcel variable reuse without minting entity ids from names", () => {
    const proposed = sameParcelQuery();
    const admission = admitSourceSemanticQuery(proposed, SAME_PARCEL);
    expect(admission.kind).toBe("admitted");
    if (admission.kind !== "admitted") return;
    expect(admission.original_query_digest).toBe(digestOriginalQuery(SAME_PARCEL));
    expect(admission.query_id).toBe(sourceSemanticQueryIdentity(admission.query, fieldContractSha256));
    expect(admission.producer.producer_id).toBe(SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID);
    const objectTargets = admission.query.alternatives[0]!.frames.flatMap((frame) =>
      frame.role_requirements.filter((row) => row.id === "object").map((row) => row.target_variable)
    );
    expect(objectTargets).toEqual(["parcel", "parcel"]);
    expect(JSON.stringify(admission.query)).not.toMatch(/entity_id|answer_id|h_id/u);
    expect(admission.query.alternatives[0]!.frames[0]!.role_requirements[0]!.support).toEqual({
      kind: "query_text",
      excerpt: "parcel"
    });
  });

  it("keeps promised embedding and completed assertion as distinct context obligations", () => {
    const completed = admitSourceSemanticQuery(completedSendQuery(), COMPLETED_SEND);
    const promised = admitSourceSemanticQuery(promisedSendQuery(), PROMISED_SEND);
    expect(completed.kind).toBe("admitted");
    expect(promised.kind).toBe("admitted");
    if (completed.kind !== "admitted" || promised.kind !== "admitted") return;
    expect(completed.query.alternatives[0]!.context_obligations).toEqual([
      { frame: "qSend", kind: "asserted_at_source" }
    ]);
    expect(promised.query.alternatives[0]!.context_obligations).toEqual([
      { frame: "qPromise", kind: "asserted_at_source" },
      {
        frame: "qSend",
        kind: "explicit_embedded_structure",
        incidence: { kind: "embedding", other_frame: "qPromise", role: "content" }
      }
    ]);
    expect(completed.query_id).not.toBe(promised.query_id);
  });

  it("treats question source_act as a leaf and unresolved obligation as no completed-event demand", () => {
    const asked = draft(ASKED_SEND, [{
      id: "qSend",
      variable: "fSend",
      predicate_reading: "send",
      source_act: "question",
      role_requirements: [role("object", "parcel", "parcel")]
    }], [], [
      { id: "parcel", sort: "entity" },
      { id: "fSend", sort: "proposition" }
    ]);
    const unresolved = draft(UNRESOLVED_SEND, [{
      id: "qSend",
      variable: "fSend",
      predicate_reading: "send",
      role_requirements: [role("object", "parcel", "parcel")]
    }], [{ frame: "qSend", kind: "unresolved" }], [
      { id: "parcel", sort: "entity" },
      { id: "fSend", sort: "proposition" }
    ]);
    const askedAdmission = admitSourceSemanticQuery(asked, ASKED_SEND);
    const unresolvedAdmission = admitSourceSemanticQuery(unresolved, UNRESOLVED_SEND);
    expect(askedAdmission.kind).toBe("admitted");
    expect(unresolvedAdmission.kind).toBe("admitted");
    if (askedAdmission.kind !== "admitted" || unresolvedAdmission.kind !== "admitted") return;
    expect(askedAdmission.query.alternatives[0]!.frames[0]!.source_act).toBe("question");
    expect(askedAdmission.query.alternatives[0]!.context_obligations).toEqual([]);
    expect(unresolvedAdmission.query.alternatives[0]!.frames[0]!.source_act).toBeUndefined();
    expect(unresolvedAdmission.query.alternatives[0]!.context_obligations).toEqual([
      { frame: "qSend", kind: "unresolved" }
    ]);
    expect(askedAdmission.query_id).not.toBe(unresolvedAdmission.query_id);
  });

  it("rejects producer substitution and a self-declared core producer", () => {
    const proposed = sameParcelQuery();
    const unknown = admitSourceSemanticQuery(
      { ...proposed, producer_id: "forged.unknown.v1" },
      SAME_PARCEL
    );
    expect(unknown.kind).toBe("unsupported");
    const empty = new SourceSemanticQueryProducerRegistry([]);
    const claimedCore = admitSourceSemanticQuery(proposed, SAME_PARCEL, empty);
    expect(claimedCore.kind).toBe("unsupported");
    const registry = new SourceSemanticQueryProducerRegistry([
      sourceSemanticQueryProducerRecord(SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID),
      sourceSemanticQueryProducerRecord("attached.query.v1")
    ]);
    const core = admitSourceSemanticQuery(proposed, SAME_PARCEL, registry);
    const attached = admitSourceSemanticQuery(
      { ...proposed, producer_id: "attached.query.v1" },
      SAME_PARCEL,
      registry
    );
    expect(core.kind).toBe("admitted");
    expect(attached.kind).toBe("admitted");
    if (core.kind !== "admitted" || attached.kind !== "admitted") return;
    expect(attached.query_id).not.toBe(core.query_id);
    expect(attached.producer.producer_id).toBe("attached.query.v1");
    const soul = admitSourceSemanticQuery(
      { ...proposed, producer_id: SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID },
      SAME_PARCEL
    );
    expect(soul.kind).toBe("admitted");
  });

  it("rejects a producer registered without semantic_query capability", () => {
    const registry = new SourceSemanticQueryProducerRegistry([
      sourceSemanticQueryProducerRecord(SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, {
        capabilities: []
      })
    ]);
    expect(admitSourceSemanticQuery(sameParcelQuery(), SAME_PARCEL, registry).kind).toBe("unsupported");
  });

  it("rejects forged program, seed, verdict, milligrade, and answer or source ids", () => {
    const proposed = sameParcelQuery();
    const forgeries = [
      { ...proposed, program: { kind: "epsilon" } },
      { ...proposed, seed_nodes: ["qPack"] },
      { ...proposed, milligrades: 1000 },
      { ...proposed, conditions: [{ kind: "authorization", verdict: "true" }] },
      { ...proposed, entity_id: "memory-a" },
      { ...proposed, answer_id: "answer-1" },
      { ...proposed, h_id: digestOriginalQuery(SAME_PARCEL) }
    ];
    for (const forged of forgeries) {
      expect(SourceSemanticQuerySchema.safeParse(forged).success).toBe(false);
      const admission = admitSourceSemanticQuery(forged, SAME_PARCEL);
      expect(admission.kind).toBe("invalid");
      expect(admission).not.toHaveProperty("query");
      expect(admission).not.toHaveProperty("program");
    }
  });

  it("rejects a disconnected query as invalid, not epsilon success", () => {
    const disconnected = draft(SAME_PARCEL, [{
      id: "qPack",
      variable: "fPack",
      predicate_reading: "pack",
      role_requirements: [role("object", "parcel", "parcel")]
    }, {
      id: "qInspect",
      variable: "fInspect",
      predicate_reading: "inspect",
      role_requirements: [role("object", "other", "other")]
    }], [], [
      { id: "parcel", sort: "entity" },
      { id: "other", sort: "entity" },
      { id: "fPack", sort: "proposition" },
      { id: "fInspect", sort: "proposition" }
    ]);
    expect(queryAlternativeConnected(disconnected.alternatives[0]!)).toBe(false);
    expect(SourceSemanticQuerySchema.safeParse(disconnected).success).toBe(false);
    const admission = admitSourceSemanticQuery(disconnected, SAME_PARCEL);
    expect(admission.kind).toBe("invalid");
    expect(admission).not.toHaveProperty("query");
    expect(admission).not.toHaveProperty("program");
  });

  it("keeps unsupported phenomena as located gaps on an admitted connected query", () => {
    const proposed = {
      ...sameParcelQuery(),
      gaps: [{ kind: "universal_quantification" as const, affected_ids: [], support: [] }]
    };
    const admission = admitSourceSemanticQuery(proposed, SAME_PARCEL);
    expect(admission.kind).toBe("admitted");
    if (admission.kind !== "admitted") return;
    expect(admission.query.gaps).toEqual([
      { kind: "universal_quantification", affected_ids: [], support: [] }
    ]);
    expect(admission).not.toHaveProperty("program");
  });

  it("rejects original-query byte substitution and does not treat ordinary text as semantic Q", () => {
    const proposed = sameParcelQuery();
    expect(admitSourceSemanticQuery(proposed, "a different original query").kind).toBe("invalid");
    expect(admitSourceSemanticQuery(SAME_PARCEL, SAME_PARCEL).kind).toBe("invalid");
    expect(admitSourceSemanticQuery(undefined, SAME_PARCEL).kind).toBe("absent");
  });
});
