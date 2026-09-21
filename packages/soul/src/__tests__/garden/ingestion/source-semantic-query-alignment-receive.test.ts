import { describe, expect, it } from "vitest";
import {
  SOURCE_SEMANTIC_ALIGNMENT_CONTRACT, SOURCE_SEMANTIC_QUERY_CONTRACT,
  SourceSemanticAlignmentSchema, SourceSemanticQuerySchema, sourceSemanticInterpretationIdentity
} from "@do-soul/alaya-protocol";
import { buildOfficialApiSourceCorpus, indexOfficialApiSourceAssertions } from "../../../garden/triage/grounding/source-locator.js";
import {
  buildSourceSemanticRequest as buildCurrentSourceSemanticRequest, semanticSha256,
  parseSourceSemanticRequest, sourceSemanticAlignmentResponseJsonSchema,
  sourceSemanticQueryResponseJsonSchema, SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT
} from "../../../garden/ingestion/official-api/source-semantic-request.js";
import {
  proposeAlignmentSemantics, proposeQuerySemantics, receiveSourceSemantics
} from "../../../garden/ingestion/official-api/source-semantic-receive.js";
import { sourceSemanticQueryExamples } from "../../../garden/ingestion/official-api/source-semantic-query-examples.js";

const TEXT = "The archivist accessioned folio F into bay B.";
const EXISTENTIAL = "which folio was accessioned into bay B?";
const UNIVERSAL = "every registered user uses tools";
const COMPARISON = "is Alice faster than Bob in ms in the lab";
const SHARED = "which parcel was packed and inspected?";
const PROMISE = "which parcel did Bob promise to send to Alice?";
const NEGATIVE = "which folio was not accessioned into bay B?";
const FOREIGN = `sha256:${"b".repeat(64)}`;

function sourceInput(text = TEXT) {
  const sourceCorpus = buildOfficialApiSourceCorpus(text, [{ role: "user", content: text }]);
  const assertion = indexOfficialApiSourceAssertions(sourceCorpus).find((row) => row.text.includes(text))!;
  return {
    sourceCorpus, assertionIds: [assertion.assertion_id],
    source_id: "src", source_version: "1", producer_id: "authored-producer", producer_version: "p1"
  };
}

function graphRequest(input: ReturnType<typeof sourceInput>) {
  const current = buildCurrentSourceSemanticRequest(input);
  return parseSourceSemanticRequest({
    ...current,
    source_request: {
      ...current.source_request, generation_schema_contract: undefined, proposal_contract: "source-semantic-proposal-v1"
    }
  });
}

function segment(request: ReturnType<typeof graphRequest>, text: string) {
  return request.source_catalog.assertions[0]!.segments.find((row) => row.text === text)!;
}

function accessionDraft(request: ReturnType<typeof graphRequest>) {
  const assertionId = request.source_request.source_assertions[0]!.assertion_id;
  const mention = (id: string, token: string) => {
    const row = segment(request, token);
    return { id, assertion_id: assertionId, source_ref: { first: row.id, last: row.id } };
  };
  return {
    contract: "source-interpretation-v4" as const,
    mentions: [
      mention("mArchivist", "archivist"), mention("mAccessioned", "accessioned"),
      mention("mFolio", "folio"), mention("mF", "F"), mention("mBay", "bay"), mention("mB", "B")
    ],
    referents: [
      { id: "rArchivist", referent_kind: "grouped" as const, mentions: ["mArchivist"] },
      { id: "rFolio", referent_kind: "grouped" as const, mentions: ["mF"] },
      { id: "rBay", referent_kind: "grouped" as const, mentions: ["mB"] }
    ],
    frames: [{
      id: "fAccession", assertion_ids: [assertionId],
      context_owner: { kind: "source_act" as const, source_act: "assertion" as const },
      additional_support: [],
      predicate_support: { kind: "explicit" as const, reading: "accession", mentions: ["mAccessioned"] },
      slots: [
        { id: "agent", role_reading: "agent", support: [{ kind: "lexical" as const, mentions: ["mArchivist"] }] },
        { id: "object", role_reading: "folio", support: [{ kind: "lexical" as const, mentions: ["mFolio"] }] },
        { id: "bay", role_reading: "bay", support: [{ kind: "lexical" as const, mentions: ["mBay"] }] }
      ],
      bindings: [
        { slot_id: "agent", target: { kind: "node" as const, id: "rArchivist" }, support: [] },
        { slot_id: "object", target: { kind: "node" as const, id: "rFolio" }, support: [] },
        { slot_id: "bay", target: { kind: "node" as const, id: "rBay" }, support: [] }
      ]
    }],
    operators: [],
    gaps: []
  };
}

function interpretation(producerVersion = "p1") {
  const input = { ...sourceInput(), producer_version: producerVersion };
  const request = graphRequest(input);
  const received = receiveSourceSemantics(JSON.stringify({
    contract: "source-semantic-proposal-v1",
    outcome: { status: "interpreted" },
    draft: accessionDraft(request)
  }), request, input);
  if (received.interpretation === undefined) throw new Error("interpreted source required");
  return received.interpretation;
}

const role = (id: string, variable: string, excerpt: string) => ({
  id, role_reading: id, target_variable: variable, support: { kind: "query_text" as const, excerpt }
});

function existentialBody() {
  return {
    variables: [
      { id: "folio", sort: "entity" as const }, { id: "bay", sort: "entity" as const },
      { id: "fAccession", sort: "proposition" as const }
    ],
    alternatives: [{
      frames: [{
        id: "qAccession", variable: "fAccession", predicate_reading: "accession",
        role_requirements: [
          role("object", "folio", "folio"),
          role("bay", "bay", "bay B")
        ]
      }],
      context_obligations: [{ frame: "qAccession", kind: "asserted_at_source" as const }]
    }],
    return_variables: ["folio"],
    gaps: [] as const
  };
}

function queryEnvelope(original: string, body: object, outcome: object = { status: "interpreted", gaps: [] }) {
  return proposeQuerySemantics({
    original_query: original, producer_id: "query-producer", producer_version: "1",
    query_syntax: SOURCE_SEMANTIC_QUERY_CONTRACT
  }, {
    rawJson: JSON.stringify({
      contract: "source-semantic-query-response-v2", outcome, query: body
    })
  });
}

function alignmentEnvelope(
  query: ReturnType<typeof SourceSemanticQuerySchema.parse>,
  descriptors: { h_id: string; interpretation: ReturnType<typeof interpretation> }[],
  body: object,
  outcome: object = { status: "interpreted", gaps: [] }
) {
  return proposeAlignmentSemantics({ original_query: EXISTENTIAL,
    admitted_q: query, h_descriptors: descriptors, producer_id: "align-producer", producer_version: "1",
    alignment_syntax: SOURCE_SEMANTIC_ALIGNMENT_CONTRACT
  }, {
    rawJson: JSON.stringify({
      contract: "source-semantic-alignment-response-v2", outcome, alignment: body
    })
  });
}

function canonicalQuery(original: string, body: object) {
  return SourceSemanticQuerySchema.parse({
    contract: "source-semantic-query-v2",
    original_query_digest: `sha256:${semanticSha256(original)}`,
    producer_id: "query-producer", producer_version: "1", contract_version: "source-semantic-query-v2",
    ...body
  });
}

function diagnosticsOf(received: { outcome: { status: string; diagnostics?: readonly unknown[] } }) {
  return JSON.stringify(received.outcome);
}

describe("query receive preserves producer meaning", () => {
  it("keeps a simple existential query without synthesizing evaluation", () => {
    const body = existentialBody();
    const received = queryEnvelope(EXISTENTIAL, body);
    expect(received.outcome.status).toBe("interpreted");
    expect(received.query).toEqual(canonicalQuery(EXISTENTIAL, body));
    expect(received.query?.evaluation).toBeUndefined();
    expect(received.query?.domains).toBeUndefined();
  });

  it("retains universal domain, binder, and evaluation rather than converting to existential", () => {
    const body = {
      variables: [
        { id: "actor", sort: "entity" as const }, { id: "tools", sort: "entity" as const },
        { id: "use", sort: "proposition" as const }
      ],
      alternatives: [{
        frames: [{
          id: "qUse", variable: "use", predicate_reading: "use",
          role_requirements: [role("agent", "actor", "user"), role("theme", "tools", "tools")]
        }],
        context_obligations: [{ frame: "qUse", kind: "entailed_at_source" as const }]
      }],
      return_variables: [],
      gaps: [],
      domains: [{ id: "people", support: { kind: "query_text" as const, excerpt: "registered user" } }],
      evaluation: { kind: "forall" as const, domain: "people", binder: "actor", local_variables: ["actor", "tools", "use"] }
    };
    const received = queryEnvelope(UNIVERSAL, body);
    expect(received.outcome.status).toBe("interpreted");
    expect(received.query).toEqual(canonicalQuery(UNIVERSAL, body));
    expect(received.query?.evaluation).toEqual(body.evaluation);
    expect(received.query?.domains).toEqual(body.domains);
  });

  it("retains comparison operation, operands, strictness, units, and scope", () => {
    const body = {
      variables: [
        { id: "alice", sort: "entity" as const, reference: { kind: "query_text" as const, excerpt: "Alice" } },
        { id: "bob", sort: "entity" as const, reference: { kind: "query_text" as const, excerpt: "Bob" } }
      ],
      alternatives: [{ frames: [], context_obligations: [] }],
      return_variables: ["alice", "bob"],
      gaps: [],
      domains: [{ id: "people", support: { kind: "query_text" as const, excerpt: "Alice" } }],
      evaluation: {
        kind: "comparison" as const, domain: "people", operation: "gt" as const,
        left: "alice", right: "bob", strict: true, metric: "speed", unit: "ms", context: "lab", scope: "asserted" as const
      }
    };
    const received = queryEnvelope(COMPARISON, body);
    expect(received.outcome.status).toBe("interpreted");
    expect(received.query).toEqual(canonicalQuery(COMPARISON, body));
    expect(received.query?.evaluation).toMatchObject({
      kind: "comparison", operation: "gt", left: "alice", right: "bob", strict: true, unit: "ms", scope: "asserted"
    });
  });

  it("preserves shared variables, reported embedding, and explicit negation", () => {
    const shared = queryEnvelope(SHARED, {
      variables: [
        { id: "parcel", sort: "entity" }, { id: "fPack", sort: "proposition" }, { id: "fInspect", sort: "proposition" }
      ],
      alternatives: [{
        frames: [
          { id: "qPack", variable: "fPack", predicate_reading: "pack", role_requirements: [role("object", "parcel", "parcel")] },
          { id: "qInspect", variable: "fInspect", predicate_reading: "inspect", role_requirements: [role("object", "parcel", "parcel")] }
        ],
        context_obligations: [
          { frame: "qPack", kind: "asserted_at_source" }, { frame: "qInspect", kind: "asserted_at_source" }
        ]
      }],
      return_variables: ["parcel"], gaps: []
    });
    expect(shared.query?.alternatives[0]?.frames.map((row) => row.role_requirements[0]?.target_variable))
      .toEqual(["parcel", "parcel"]);

    const promised = queryEnvelope(PROMISE, {
      variables: [
        { id: "promisor", sort: "entity" }, { id: "parcel", sort: "entity" }, { id: "recipient", sort: "entity" },
        { id: "fPromise", sort: "proposition" }, { id: "fSend", sort: "proposition" }
      ],
      alternatives: [{
        frames: [
          { id: "qPromise", variable: "fPromise", predicate_reading: "promise",
            role_requirements: [role("promisor", "promisor", "Bob")] },
          { id: "qSend", variable: "fSend", predicate_reading: "send", role_requirements: [
            role("object", "parcel", "parcel"), role("recipient", "recipient", "Alice")
          ] }
        ],
        context_obligations: [
          { frame: "qPromise", kind: "asserted_at_source" },
          { frame: "qSend", kind: "explicit_embedded_structure",
            incidence: { kind: "embedding", other_frame: "qPromise", role: "content" } }
        ]
      }],
      return_variables: ["parcel"], gaps: []
    });
    expect(promised.query?.alternatives[0]?.context_obligations[1]).toMatchObject({
      kind: "explicit_embedded_structure", incidence: { kind: "embedding", other_frame: "qPromise" }
    });

    const negative = queryEnvelope(NEGATIVE, {
      variables: [
        { id: "folio", sort: "entity" }, { id: "bay", sort: "entity" },
        { id: "negative", sort: "context" }, { id: "fAccession", sort: "proposition" }
      ],
      alternatives: [{
        frames: [
          { id: "qNot", variable: "negative", predicate_reading: "not", operator: "not", role_requirements: [] },
          { id: "qAccession", variable: "fAccession", predicate_reading: "accession", role_requirements: [
            role("object", "folio", "folio"), role("bay", "bay", "bay B")
          ] }
        ],
        context_obligations: [
          { frame: "qNot", kind: "asserted_at_source" },
          { frame: "qAccession", kind: "explicit_embedded_structure",
            incidence: { kind: "operator_operand", other_frame: "qNot", role: "content" } }
        ]
      }],
      return_variables: ["folio"], gaps: []
    });
    expect(negative.query?.alternatives[0]?.frames[0]?.operator).toBe("not");
  });

  it("rejects disconnected structure and incomplete evaluation instead of repairing them", () => {
    const disconnected = queryEnvelope(SHARED, {
      variables: [
        { id: "parcel", sort: "entity" }, { id: "other", sort: "entity" },
        { id: "fPack", sort: "proposition" }, { id: "fInspect", sort: "proposition" }
      ],
      alternatives: [{
        frames: [
          { id: "qPack", variable: "fPack", predicate_reading: "pack", role_requirements: [role("object", "parcel", "parcel")] },
          { id: "qInspect", variable: "fInspect", predicate_reading: "inspect", role_requirements: [role("object", "other", "other")] }
        ],
        context_obligations: []
      }],
      return_variables: ["parcel"], gaps: []
    });
    expect(disconnected.outcome.status).toBe("invalid");
    expect(disconnected.query).toBeUndefined();

    const incomplete = queryEnvelope(UNIVERSAL, {
      ...existentialBody(),
      evaluation: { kind: "forall", domain: "people" }
    });
    expect(incomplete.outcome.status).toBe("invalid");
    expect(incomplete.query).toBeUndefined();
  });

  it("rejects unknown body fields with a precise path and does not take host identities from the body", () => {
    const unknown = queryEnvelope(EXISTENTIAL, { ...existentialBody(), invented: true });
    expect(unknown.outcome.status).toBe("invalid");
    expect(diagnosticsOf(unknown)).toMatch(/invented/u);

    const hijacked = queryEnvelope(EXISTENTIAL, {
      ...existentialBody(), producer_id: "forged.producer", original_query_digest: FOREIGN
    });
    expect(hijacked.outcome.status).toBe("invalid");
    expect(diagnosticsOf(hijacked)).toMatch(/producer_id|original_query_digest/u);

    const received = queryEnvelope(EXISTENTIAL, existentialBody());
    expect(received.query?.producer_id).toBe("query-producer");
    expect(received.query?.original_query_digest).toBe(`sha256:${semanticSha256(EXISTENTIAL)}`);
  });

  it("echoes omitted outcome gaps from the query body and still rejects disagreement", () => {
    const gaps = [{ kind: "unresolved_referent", affected_ids: ["folio"], support: [{ kind: "query_text", excerpt: "folio" }] }];
    const echoed = queryEnvelope(EXISTENTIAL, { ...existentialBody(), gaps }, { status: "interpreted" });
    expect(echoed.outcome).toEqual({ status: "interpreted", gaps });
    expect(echoed.query?.gaps).toEqual(gaps);

    const mismatch = queryEnvelope(EXISTENTIAL, { ...existentialBody(), gaps: [] }, {
      status: "interpreted", gaps
    });
    expect(mismatch.outcome).toMatchObject({
      status: "invalid", diagnostics: [{ code: "outcome_gap_mismatch", path: ["outcome", "gaps"] }]
    });
  });
});

describe("alignment receive preserves producer meaning", () => {
  const query = canonicalQuery(EXISTENTIAL, existentialBody());

  it("retains domain correspondences and membership assumptions from the producer body", () => {
    const h = interpretation();
    const hId = sourceSemanticInterpretationIdentity(h, semanticSha256);
    const body = {
      correspondences: [{
        relation: "contextual_equivalence",
        query_endpoint: { kind: "predicate", alternative: 0, frame: "qAccession" },
        source_endpoint: { kind: "frame", frame: "fAccession" },
        query_support: { kind: "query_text", excerpt: "accessioned" },
        source_semantic_support: [{ kind: "lexical", mentions: ["mAccessioned"] }]
      }],
      domains: [{
        query_domain: "people", source_domain: "users",
        query_support: { kind: "query_text", excerpt: "folio" },
        source_semantic_support: [{ kind: "lexical", mentions: ["mFolio"] }]
      }],
      membership_assumptions: [{
        query_variable: "folio", source_domain: "users", restrictions: [], status: "member",
        query_support: { kind: "query_text", excerpt: "folio" }, description: "Assume the folio is in users."
      }]
    };
    const received = alignmentEnvelope(query, [{ h_id: hId, interpretation: h }], body);
    expect(received.outcome.status).toBe("interpreted");
    expect(received.alignment).toEqual(SourceSemanticAlignmentSchema.parse({
      contract: "source-semantic-alignment-v2",
      h_id: hId, q_id: received.alignment!.q_id,
      producer_id: "align-producer", producer_version: "1", contract_version: "source-semantic-alignment-v2",
      ...body
    }));
    expect(received.alignment?.domains).toEqual(body.domains);
    expect(received.alignment?.membership_assumptions).toEqual(body.membership_assumptions);
  });

  it("does not invent membership when the producer omitted it", () => {
    const h = interpretation();
    const received = alignmentEnvelope(query, [{
      h_id: sourceSemanticInterpretationIdentity(h, semanticSha256), interpretation: h
    }], { correspondences: [] });
    expect(received.outcome.status).toBe("interpreted");
    expect(received.alignment?.membership_assumptions).toBeUndefined();
    expect(received.alignment?.domains).toBeUndefined();
  });

  it("binds request-local handles and rejects producer hashes as unknown fields", () => {
    const first = interpretation("p1");
    const second = interpretation("p2");
    const descriptors = [
      { h_id: sourceSemanticInterpretationIdentity(first, semanticSha256), interpretation: first },
      { h_id: sourceSemanticInterpretationIdentity(second, semanticSha256), interpretation: second }
    ];
    const missing = alignmentEnvelope(query, descriptors, { correspondences: [] });
    expect(missing.outcome.status).toBe("invalid");
    expect(diagnosticsOf(missing)).toMatch(/request-local handle/u);

    const secondHandle = alignmentEnvelope(query, descriptors, { correspondences: [], h: "h2" });
    expect(secondHandle.alignment?.h_id).toBe(descriptors[1]!.h_id);

    const unbound = alignmentEnvelope(query, descriptors, { correspondences: [], h: "h9" });
    expect(unbound.outcome.status).toBe("invalid");
    expect(diagnosticsOf(unbound)).toMatch(/does not name a supplied descriptor/u);

    const hashed = alignmentEnvelope(query, descriptors.slice(0, 1), {
      correspondences: [], h_id: FOREIGN
    });
    expect(hashed.outcome.status).toBe("invalid");
    expect(diagnosticsOf(hashed)).toMatch(/h_id/u);

    const trusted = alignmentEnvelope(query, descriptors.slice(0, 1), { correspondences: [] });
    expect(trusted.alignment?.h_id).toBe(descriptors[0]!.h_id);
    expect(trusted.alignment?.q_id).not.toBe(FOREIGN);
    expect(trusted.alignment?.producer_id).toBe("align-producer");
  });
});

describe("query and alignment generation schemas", () => {
  it("asks for producer bodies without host envelope identities", () => {
    const query = JSON.stringify(sourceSemanticQueryResponseJsonSchema());
    const alignment = JSON.stringify(sourceSemanticAlignmentResponseJsonSchema());
    expect(query).toContain("source-semantic-query-response-v3");
    expect(query).toContain("source-semantic-query-meaning-v1");
    expect(query).toContain("statement");
    expect(query).toContain("evaluation");
    expect(query).not.toContain("original_query_digest");
    expect(alignment).toContain("source-semantic-alignment-response-v3");
    expect(alignment).toContain("source-semantic-alignment-selection-v1");
    expect(alignment).toContain("membership_assumptions");
    expect(alignment).not.toContain("q_id");
    expect(alignment).not.toContain('"gaps"');
    expect(Buffer.byteLength(query)).toBeLessThan(24 * 1024);
    expect(Buffer.byteLength(alignment)).toBeLessThan(24 * 1024);
    const legacyQuery = JSON.stringify(sourceSemanticQueryResponseJsonSchema({
      contract: "source-semantic-query-request-v2"
    }));
    expect(legacyQuery).toContain("source-semantic-query-response-v2");
    expect(legacyQuery).not.toContain("source-semantic-query-meaning-v1");
  });
});

describe("query meaning receive and alignment selection", () => {
  it("materializes complete producer examples without asserting embedded actions or returning universal witnesses", () => {
    const results = sourceSemanticQueryExamples.map((example) => proposeQuerySemantics({
      original_query: example.original_query, producer_id: "query-producer", producer_version: "1"
    }, { rawJson: JSON.stringify(example.response) }));
    expect(results.map((result) => result.outcome.status)).toEqual(["interpreted", "interpreted", "interpreted"]);
    const nested = results[0]!.query!;
    expect(nested.return_variables).toEqual(["person"]);
    expect(nested.alternatives[0]!.context_obligations).toEqual([
      { frame: "request", kind: "asserted_at_source" },
      { frame: "action", kind: "explicit_embedded_structure",
        incidence: { kind: "embedding", other_frame: "request", role: "content" } }
    ]);
    const universal = results[1]!.query!;
    expect(universal.domains).toEqual([{ id: "sensors", support: { kind: "query_text", excerpt: "every registered sensor" } }]);
    expect(universal.evaluation).toEqual({ kind: "forall", domain: "sensors", binder: "sensor", local_variables: ["sensor", "calibration"] });
    expect(universal.return_variables).toEqual([]);
    expect(universal.alternatives[0]!.frames[0]!.role_requirements[0]!.target_variable).toBe("sensor");
    expect(results[2]!.query!.gaps).toEqual(sourceSemanticQueryExamples[2].response.query.gaps);
    expect(results[2]!.outcome).toEqual({ status: "interpreted", gaps: sourceSemanticQueryExamples[2].response.query.gaps });
  });

  it("rejects legacy H mention support instead of claiming that it locates a query gap", () => {
    const example = sourceSemanticQueryExamples[2];
    const query = { ...example.response.query, gaps: [{ kind: "unsupported_meaning", affected_ids: ["arrival"],
      support: [{ kind: "lexical", mentions: ["arrival"] }] }] };
    const result = proposeQuerySemantics({ original_query: example.original_query, producer_id: "query-producer", producer_version: "1" },
      { rawJson: JSON.stringify({ ...example.response, query }) });
    expect(result.outcome.status).toBe("invalid");
    expect(result.query).toBeUndefined();
  });

  it("materializes nested meaning and keeps the legacy graph envelope on its own version", () => {
    const meaning = proposeQuerySemantics({
      original_query: "Who sent the sample to Mira?", producer_id: "query-producer", producer_version: "1"
    }, {
      rawJson: JSON.stringify({
        contract: "source-semantic-query-response-v3",
        outcome: { status: "interpreted" },
        query: {
          contract: "source-semantic-query-meaning-v1",
          alternatives: [{ meaning: {
            kind: "statement", key: "send", predicate: "send",
            arguments: [
              { role: "sender", target: { kind: "free", key: "sender" }, excerpt: "Who" },
              { role: "theme", target: { kind: "named", key: "sample", excerpt: "sample" }, excerpt: "sample" },
              { role: "recipient", target: { kind: "named", key: "mira", excerpt: "Mira" }, excerpt: "Mira" }
            ]
          } }],
          return: ["sender"],
          gaps: []
        }
      })
    });
    expect(meaning.outcome.status).toBe("interpreted");
    expect(meaning.query?.variables.find((row) => row.id === "sender")?.reference).toBeUndefined();
    expect(meaning.query?.variables.find((row) => row.id === "mira")?.reference?.excerpt).toBe("Mira");
    expect(meaning.query?.alternatives[0]?.frames[0]?.source_act).toBeUndefined();
    expect(meaning.system_prompt).toContain("source-semantic-query-meaning-v1");
    expect(SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT).toContain("source_act is retrieval intent");

    const legacy = proposeQuerySemantics({
      original_query: EXISTENTIAL, producer_id: "query-producer", producer_version: "1",
      query_syntax: SOURCE_SEMANTIC_QUERY_CONTRACT
    }, {
      rawJson: JSON.stringify({
        contract: "source-semantic-query-response-v2", outcome: { status: "interpreted", gaps: [] },
        query: existentialBody()
      })
    });
    expect(legacy.outcome.status).toBe("interpreted");
    expect(legacy.request.contract).toBe("source-semantic-query-request-v2");
    expect(legacy.query).toEqual(canonicalQuery(EXISTENTIAL, existentialBody()));
  });

  it("materializes catalog selections and still accepts a legacy correspondence envelope", () => {
    const h = interpretation();
    const hId = sourceSemanticInterpretationIdentity(h, semanticSha256);
    const admitted = canonicalQuery(EXISTENTIAL, existentialBody());
    const selected = proposeAlignmentSemantics({ original_query: EXISTENTIAL,
      admitted_q: admitted, h_descriptors: [{ h_id: hId, interpretation: h }],
      producer_id: "align-producer", producer_version: "1"
    });
    const predicate = selected.request.catalog?.query_endpoints.find((row) => row.kind === "predicate");
    const frame = selected.request.catalog?.source_endpoints.find((row) => row.kind === "frame");
    expect(predicate).toBeDefined();
    expect(frame).toBeDefined();
    const received = proposeAlignmentSemantics({ original_query: EXISTENTIAL,
      admitted_q: admitted, h_descriptors: [{ h_id: hId, interpretation: h }],
      producer_id: "align-producer", producer_version: "1"
    }, {
      rawJson: JSON.stringify({
        contract: "source-semantic-alignment-response-v3",
        outcome: { status: "interpreted", gaps: [] },
        alignment: {
          contract: "source-semantic-alignment-selection-v1", h: "h1",
          selections: [{
            query: predicate!.handle, source: frame!.handle, query_excerpt: "accessioned",
            source_semantic_support: [{ kind: "lexical", mentions: ["mAccessioned"] }]
          }]
        }
      })
    });
    expect(received.outcome.status).toBe("interpreted");
    expect(received.alignment?.correspondences[0]?.query_endpoint).toEqual({
      kind: "predicate", alternative: 0, frame: "qAccession"
    });

    const legacy = proposeAlignmentSemantics({ original_query: EXISTENTIAL,
      admitted_q: admitted, h_descriptors: [{ h_id: hId, interpretation: h }],
      producer_id: "align-producer", producer_version: "1",
      alignment_syntax: SOURCE_SEMANTIC_ALIGNMENT_CONTRACT
    }, {
      rawJson: JSON.stringify({
        contract: "source-semantic-alignment-response-v2", outcome: { status: "interpreted", gaps: [] },
        alignment: { correspondences: [] }
      })
    });
    expect(legacy.outcome.status).toBe("interpreted");
    expect(legacy.request.catalog).toBeUndefined();
    expect(legacy.alignment?.correspondences).toEqual([]);
  });

  it("rejects a graph producer envelope on the default meaning request", () => {
    const query = proposeQuerySemantics({
      original_query: EXISTENTIAL, producer_id: "query-producer", producer_version: "1"
    }, {
      rawJson: JSON.stringify({
        contract: "source-semantic-query-response-v2", outcome: { status: "interpreted", gaps: [] },
        query: existentialBody()
      })
    });
    expect(query.request.contract).toBe("source-semantic-query-request-v3");
    expect(query.outcome.status).toBe("invalid");
    expect(query.query).toBeUndefined();

    const h = interpretation();
    const alignment = proposeAlignmentSemantics({ original_query: EXISTENTIAL,
      admitted_q: canonicalQuery(EXISTENTIAL, existentialBody()),
      h_descriptors: [{ h_id: sourceSemanticInterpretationIdentity(h, semanticSha256), interpretation: h }],
      producer_id: "align-producer", producer_version: "1"
    }, {
      rawJson: JSON.stringify({
        contract: "source-semantic-alignment-response-v2", outcome: { status: "interpreted", gaps: [] },
        alignment: { correspondences: [] }
      })
    });
    expect(alignment.request.contract).toBe("source-semantic-alignment-request-v4");
    expect(alignment.outcome.status).toBe("invalid");
    expect(alignment.alignment).toBeUndefined();
  });
});
