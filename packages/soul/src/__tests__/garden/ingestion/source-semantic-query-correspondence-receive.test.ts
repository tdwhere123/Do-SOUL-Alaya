import { describe, expect, it } from "vitest";
import {
  SourceSemanticQuerySchema, sourceSemanticInterpretationIdentity
} from "@do-soul/alaya-protocol";
import { buildOfficialApiSourceCorpus, indexOfficialApiSourceAssertions } from "../../../garden/triage/grounding/source-locator.js";
import {
  buildSourceSemanticRequest as buildCurrentSourceSemanticRequest, semanticSha256,
  parseSourceSemanticRequest, SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT
} from "../../../garden/ingestion/official-api/source-semantic-request.js";
import {
  proposeCorrespondenceSemantics, proposeQuerySemantics, receiveSourceSemantics
} from "../../../garden/ingestion/official-api/source-semantic-receive.js";
import { sourceSemanticQueryExamples } from "../../../garden/ingestion/official-api/source-semantic-query-examples.js";

const TEXT = "The archivist accessioned folio F into bay B.";
const EXISTENTIAL = "which folio was accessioned into bay B?";

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

function canonicalQuery(original: string, body: object) {
  return SourceSemanticQuerySchema.parse({
    contract: "source-semantic-query-v2",
    original_query_digest: `sha256:${semanticSha256(original)}`,
    producer_id: "query-producer", producer_version: "1", contract_version: "source-semantic-query-v2",
    ...body
  });
}

describe("query meaning receive and semantic_correspondence selection", () => {
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

  it("rejects legacy source-interpretation mention support instead of claiming that it locates a query gap", () => {
    const example = sourceSemanticQueryExamples[2];
    const query = { ...example.response.query, gaps: [{ kind: "unsupported_meaning", affected_ids: ["arrival"],
      support: [{ kind: "lexical", mentions: ["arrival"] }] }] };
    const result = proposeQuerySemantics({ original_query: example.original_query, producer_id: "query-producer", producer_version: "1" },
      { rawJson: JSON.stringify({ ...example.response, query }) });
    expect(result.outcome.status).toBe("invalid");
    expect(result.query).toBeUndefined();
  });

  it("materializes nested meaning with host-owned occurrence structure", () => {
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

  });

  it("materializes catalog selections", () => {
    const h = interpretation();
    const hId = sourceSemanticInterpretationIdentity(h, semanticSha256);
    const admitted = canonicalQuery(EXISTENTIAL, existentialBody());
    const selected = proposeCorrespondenceSemantics({ original_query: EXISTENTIAL,
      admitted_query_semantics: admitted, source_interpretation_descriptors: [{ source_interpretation_id: hId, interpretation: h }],
      producer_id: "align-producer", producer_version: "1"
    });
    const predicate = selected.request.catalog?.query_endpoints.find((row) => row.kind === "predicate");
    const frame = selected.request.catalog?.source_endpoints.find((row) => row.kind === "frame");
    expect(predicate).toBeDefined();
    expect(frame).toBeDefined();
    const received = proposeCorrespondenceSemantics({ original_query: EXISTENTIAL,
      admitted_query_semantics: admitted, source_interpretation_descriptors: [{ source_interpretation_id: hId, interpretation: h }],
      producer_id: "align-producer", producer_version: "1"
    }, {
      rawJson: JSON.stringify({
        contract: "source-semantic-correspondence-response-v3",
        outcome: { status: "interpreted", gaps: [] },
        semantic_correspondence: {
          contract: "source-semantic-correspondence-selection-v2", source_interpretation_handle: "source1",
          selections: [{
            query: predicate!.handle, source: frame!.handle, query_excerpt: "accessioned",
            source_semantic_support: [{ kind: "lexical", mentions: ["mAccessioned"] }]
          }]
        }
      })
    });
    expect(received.outcome.status).toBe("interpreted");
    expect(received.semantic_correspondence?.correspondences[0]?.query_endpoint).toEqual({
      kind: "predicate", alternative: 0, frame: "qAccession"
    });

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
    const semantic_correspondence = proposeCorrespondenceSemantics({ original_query: EXISTENTIAL,
      admitted_query_semantics: canonicalQuery(EXISTENTIAL, existentialBody()),
      source_interpretation_descriptors: [{ source_interpretation_id: sourceSemanticInterpretationIdentity(h, semanticSha256), interpretation: h }],
      producer_id: "align-producer", producer_version: "1"
    }, {
      rawJson: JSON.stringify({
        contract: "source-semantic-correspondence-response-v2", outcome: { status: "interpreted", gaps: [] },
        semantic_correspondence: { correspondences: [] }
      })
    });
    expect(semantic_correspondence.request.contract).toBe("source-semantic-correspondence-request-v4");
    expect(semantic_correspondence.outcome.status).toBe("invalid");
    expect(semantic_correspondence.semantic_correspondence).toBeUndefined();
  });
});
