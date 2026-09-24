import { describe, expect, it, vi } from "vitest";
import {
  sourceSemanticInterpretationIdentity, UNKNOWN_UTTERANCE_ATTRIBUTION,
  normalizeSourceSemantics, UTTERANCE_ATTRIBUTION_CONTRACT,
  encodeSourceSemanticQueryCarrier, type SourceSemanticQueryMeaningBody,
  type UtteranceAttribution
} from "@do-soul/alaya-protocol";
import { buildOfficialApiSourceCorpus, indexOfficialApiSourceAssertions } from "../../../garden/triage/grounding/source-locator.js";
import { parseOfficialApiSourcePacketRequest } from "../../../garden/ingestion/official-api/source-packet-request.js";
import {
  SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_REQUEST_CONTRACT, SOURCE_SEMANTIC_QUERY_MEANING_REQUEST_CONTRACT,
  SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT,
  buildSourceSemanticRequest, buildSourceSemanticQueryRequest, semanticSha256,
  sourceSemanticResponseJsonSchema, sourceSemanticRequestCatalog, parseSourceSemanticRequest,
  sourceSemanticSystemPrompt
} from "../../../garden/ingestion/official-api/source-semantic-request.js";
import {
  MAX_SOURCE_SEMANTIC_RESPONSE_BYTES, proposeCorrespondenceSemantics, proposeQuerySemantics,
  proposeSourceSemantics
} from "../../../garden/ingestion/official-api/source-semantic-receive.js";

const TEXT = "The archivist accessioned folio F into bay B.";

function currentQueryWire(rawJson: string): string {
  const response = JSON.parse(rawJson);
  return JSON.stringify({ ...response, contract: "source-semantic-query-response-v8",
    query: encodeSourceSemanticQueryCarrier(response.query as SourceSemanticQueryMeaningBody) });
}

it("keeps source bytes and query text identity stable while changing current H and Q request context", () => {
  const source = sourceInput();
  const capturedSource: UtteranceAttribution = { contract: UTTERANCE_ATTRIBUTION_CONTRACT,
    status: "captured", issuer_scope: "authored-harness", utterances: [{ occurrence_id: "source-turn",
      utf8_span: [0, Buffer.byteLength(source.sourceCorpus)], conversation_ref: "conversation-1", author_ref: "author-1" }] };
  const unknownH = buildSourceSemanticRequest(source);
  const capturedH = buildSourceSemanticRequest({ ...source, attribution_context: capturedSource });
  expect(unknownH.source_digest).toBe(capturedH.source_digest);
  expect(sourceSemanticRequestCatalog(unknownH)).toEqual(sourceSemanticRequestCatalog(capturedH));
  expect(unknownH.source_request.attribution_context).toEqual(UNKNOWN_UTTERANCE_ATTRIBUTION);
  expect(JSON.stringify(unknownH)).not.toBe(JSON.stringify(capturedH));

  const original_query = "which folio was accessioned into bay B?";
  const capturedQuery: UtteranceAttribution = { ...capturedSource, utterances: [{
    occurrence_id: "query-turn", utf8_span: [0, Buffer.byteLength(original_query)],
    conversation_ref: "conversation-1", author_ref: "author-1" }] };
  const input = { original_query, producer_id: "query-producer", producer_version: "1" };
  const unknownQ = buildSourceSemanticQueryRequest(input);
  const capturedQ = buildSourceSemanticQueryRequest({ ...input, attribution_context: capturedQuery });
  expect(unknownQ.original_query_digest).toBe(capturedQ.original_query_digest);
  expect(unknownQ.attribution_context).toEqual(UNKNOWN_UTTERANCE_ATTRIBUTION);
  expect(JSON.stringify(unknownQ)).not.toBe(JSON.stringify(capturedQ));
});

function sourceInput(text = TEXT) {
  const sourceCorpus = buildOfficialApiSourceCorpus(text, [{ role: "user", content: text }]);
  const assertion = indexOfficialApiSourceAssertions(sourceCorpus).find((row) => row.text.includes(text))!;
  return {
    sourceCorpus, assertionIds: [assertion.assertion_id],
    source_id: "src", source_version: "1",
    producer_id: "authored-producer", producer_version: "p1"
  };
}

function segment(request: ReturnType<typeof buildSourceSemanticRequest>, text: string, nth = 0) {
  const hits = sourceSemanticRequestCatalog(request).assertions[0]!.segments.filter((row) => row.text === text);
  return hits[nth]!;
}

function accessionDraft(request: ReturnType<typeof buildSourceSemanticRequest>, gaps: readonly object[] = []) {
  const assertionId = request.source_request.source_assertions[0]!.assertion_id;
  const mention = (id: string, token: string, nth = 0) => {
    const row = segment(request, token, nth);
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
    gaps
  };
}

function currentInterpretation() {
  const input = sourceInput();
  const request = buildSourceSemanticRequest(input);
  const normalized = normalizeSourceSemantics({
    draft: accessionDraft(request), catalog: sourceSemanticRequestCatalog(request), sha256: semanticSha256,
    source: { source_id: input.source_id, source_version: input.source_version,
      content_digest: `sha256:${semanticSha256(input.sourceCorpus)}`,
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION },
    producer_id: input.producer_id, producer_version: input.producer_version,
    contract_version: "source-interpretation-v4"
  });
  if (normalized.status !== "normalized") throw new Error("current source fixture did not normalize");
  return normalized.interpretation;
}

const digest = `sha256:${"a".repeat(64)}`;

function admittedQuery() {
  return {
    contract: "source-semantic-query-v4" as const,
    original_query_digest: `sha256:${semanticSha256("which folio was accessioned into bay B?")}`,
    approved_fixed_context: null, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    producer_id: "query-producer", producer_version: "1", contract_version: "source-semantic-query-v4",
    variables: [
      { id: "folio", sort: "entity" as const }, { id: "bay", sort: "entity" as const },
      { id: "fAccession", sort: "proposition" as const }
    ],
    alternatives: [{
      frames: [{
        id: "qAccession", variable: "fAccession", predicate_reading: "accession",
        role_requirements: [
          { id: "object", role_reading: "folio", target_variable: "folio",
            support: { kind: "query_text" as const, excerpt: "folio" } },
          { id: "bay", role_reading: "bay", target_variable: "bay",
            support: { kind: "query_text" as const, excerpt: "bay B" } }
        ]
      }],
      context_obligations: [{ frame: "qAccession", kind: "asserted_at_source" as const }]
    }],
    return_variables: ["folio"],
    gaps: []
  };
}

describe("current source table proposal entry point", () => {
  it("builds a source-bound table request with current capability and limits", () => {
    const request = buildSourceSemanticRequest(sourceInput());
    expect(request.schema_version).toBe(6);
    expect(request.source_request.proposal_contract).toBe("source-semantic-proposal-v8");
    expect(request.source_request.normalizer_version).toBe("source-semantic-normalizer-v5");
    expect(request.source_request.producer_capability.proposes).toBe("draft_semantics");
    expect(request.source_request.resource_limits.output_byte_limit).toBe(1024 * 1024);
    expect(sourceSemanticRequestCatalog(request).assertions).toHaveLength(1);
    expect(() => parseOfficialApiSourcePacketRequest(request)).toThrow();
    expect(sourceSemanticSystemPrompt(request)).toMatch(/The host owns IDs/u);
    expect(JSON.stringify(sourceSemanticResponseJsonSchema(request))).toContain("source-semantic-proposal-v8");
    expect(parseSourceSemanticRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
  });

  it("keeps abstention, malformed, and incomplete responses distinct from empty success", () => {
    const input = sourceInput();
    const abstained = proposeSourceSemantics(input, {
      rawJson: JSON.stringify({ contract: "source-semantic-proposal-v8", outcome: { status: "abstained" } })
    });
    expect(abstained.outcome.status).toBe("abstained");
    expect(abstained.provider_attempts).toBe(1);
    expect(abstained.interpretation).toBeUndefined();
    expect(abstained.raw_response_id).toMatch(/^sha256:/u);
    for (const rawJson of ['{"contract":true}', '{"contract":"source-semantic-proposal-v8"', '{"a":']) {
      const received = proposeSourceSemantics(input, { rawJson });
      expect(received.outcome.status).toBe("invalid");
      expect(received.interpretation).toBeUndefined();
      expect(received.rawJson).toBe(rawJson);
    }
  });

  it("bounds raw response bytes and avoids dispatch for empty source or no injected response", () => {
    const input = sourceInput();
    const truncated = proposeSourceSemantics(input, { rawJson: "中".repeat(Math.ceil(MAX_SOURCE_SEMANTIC_RESPONSE_BYTES / 3)) });
    expect(truncated.outcome.status).toBe("truncated");
    expect(truncated.provider_attempts).toBe(1);
    expect(proposeSourceSemantics(input).outcome.status).toBe("unexercised");
    const empty = proposeSourceSemantics({ sourceCorpus: "", assertionIds: [], source_id: "src", source_version: "1",
      producer_id: "authored-producer", producer_version: "p1" }, { rawJson: "{}" });
    expect(empty.outcome).toEqual({ status: "no_eligible_source", provider_attempts: 0 });
    expect(empty.raw_response_id).toBeUndefined();
  });
});

describe("query and semantic_correspondence proposal entry points", () => {
  it("prepares native query-semantics and semantic-correspondence prompts without provider calls and retains them on injected success or failure", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("provider calls are forbidden"));
    try {
      const sourceInterpretation = currentInterpretation();
      const query = admittedQuery();
      const queryInput = { original_query: "which folio was accessioned into bay B?", producer_id: "query-producer", producer_version: "1" };
      const correspondenceInput = { original_query: "which folio was accessioned into bay B?", admitted_query_semantics: query,
        source_interpretation_descriptors: [{ source_interpretation_id: sourceSemanticInterpretationIdentity(sourceInterpretation, semanticSha256), interpretation: sourceInterpretation }],
        producer_id: "correspondence-producer", producer_version: "1" };
      const preparedQuery = proposeQuerySemantics(queryInput);
      const preparedCorrespondence = proposeCorrespondenceSemantics(correspondenceInput);
      for (const prepared of [preparedQuery, preparedCorrespondence]) {
        expect(prepared.outcome).toEqual({ status: "unexercised" });
        expect(prepared.provider_attempts).toBe(0);
        expect(prepared.raw_response_id).toBeUndefined();
        expect(prepared.request).not.toHaveProperty("system_prompt");
      }
      expect(preparedQuery.system_prompt).toBe(SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT);
      expect(preparedCorrespondence.system_prompt).toContain("request-local handle source1, source2");
      for (const valid of [false, true]) {
        const querySemantics = proposeQuerySemantics(queryInput, { rawJson: valid ? currentQueryWire(JSON.stringify({
          contract: "source-semantic-query-response-v8", outcome: { status: "interpreted", gaps: [] },
          query: {
            contract: "source-semantic-query-meaning-v5",
            alternatives: [{ conditions: [{
              kind: "statement", key: "accession", predicate: "accession",
              arguments: [
                { role: "object", target: { kind: "free", key: "folio", return: true }, excerpt: "folio" },
                { role: "bay", target: { kind: "named", key: "bay", excerpt: "bay B" }, excerpt: "bay B" }
              ]
            }] }],
            gaps: []
          }
        })) : "{}" });
        const semanticCorrespondence = proposeCorrespondenceSemantics(correspondenceInput, { rawJson: valid ? JSON.stringify({
          contract: "source-semantic-correspondence-response-v3", outcome: { status: "interpreted", gaps: [] },
          semantic_correspondence: { contract: "source-semantic-correspondence-selection-v2", source_interpretation_handle: "source1", selections: [] }
        }) : "{}" });
        expect(querySemantics.outcome.status).toBe(valid ? "interpreted" : "invalid");
        expect(semanticCorrespondence.outcome.status).toBe(valid ? "interpreted" : "invalid");
        expect(querySemantics.system_prompt).toBe(preparedQuery.system_prompt);
        expect(semanticCorrespondence.system_prompt).toBe(preparedCorrespondence.system_prompt);
        expect(querySemantics.request).toEqual(preparedQuery.request);
        expect(semanticCorrespondence.request).toEqual(preparedCorrespondence.request);
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it.each([false, true])("validates query outcome gaps against the admitted body (matching=%s)", (matching) => {
    const gaps = [{ kind: "unresolved_referent", affected_ids: ["bay"],
      support: [{ kind: "query_text", excerpt: "bay B" }] }];
    const received = proposeQuerySemantics({ original_query: "which folio was accessioned into bay B?",
      producer_id: "query-producer", producer_version: "1" }, { rawJson: currentQueryWire(JSON.stringify({
      contract: "source-semantic-query-response-v8", outcome: { status: "interpreted", gaps },
      query: { contract: "source-semantic-query-meaning-v5", alternatives: [{ conditions: [{
        kind: "statement", key: "accession", predicate: "accession", arguments: [
          { role: "object", target: { kind: "free", key: "folio", return: true }, excerpt: "folio" },
          { role: "bay", target: { kind: "named", key: "bay", excerpt: "bay B" }, excerpt: "bay B" }
        ] }] }], gaps: matching ? gaps : [] }
    })) });
    if (matching) {
      expect(received.outcome).toEqual({ status: "interpreted", gaps });
      expect(received.query?.gaps).toEqual(gaps);
    } else {
      expect(received.outcome).toMatchObject({ status: "invalid", diagnostics: [{ code: "outcome_gap_mismatch", path: ["outcome", "gaps"] }] });
      expect(received.query).toBeUndefined();
    }
  });

  it("rejects semantic_correspondence outcome gaps rather than returning successful empty gaps", () => {
    const sourceInterpretation = currentInterpretation();
    const received = proposeCorrespondenceSemantics({ original_query: "which folio was accessioned into bay B?", admitted_query_semantics: admittedQuery(),
      source_interpretation_descriptors: [{ source_interpretation_id: sourceSemanticInterpretationIdentity(sourceInterpretation, semanticSha256), interpretation: sourceInterpretation }],
      producer_id: "correspondence-producer", producer_version: "1" }, { rawJson: JSON.stringify({
      contract: "source-semantic-correspondence-response-v3",
      outcome: { status: "interpreted", gaps: [{ kind: "unsupported_meaning", affected_ids: [], support: [] }] },
      semantic_correspondence: { contract: "source-semantic-correspondence-selection-v2", selections: [] }
    }) });
    expect(received.outcome).toMatchObject({ status: "invalid", diagnostics: [{ code: "outcome_gap_mismatch", path: ["outcome", "gaps"] }] });
    expect(received.semantic_correspondence).toBeUndefined();
  });

  it("accepts the original query and approved context and rejects answers or programs", () => {
    const received = proposeQuerySemantics({
      original_query: "which folio was accessioned into bay B?",
      approved_fixed_context: { context_id: "fixed-ctx" },
      producer_id: "query-producer", producer_version: "1"
    }, {
      rawJson: currentQueryWire(JSON.stringify({
        contract: "source-semantic-query-response-v8",
        outcome: { status: "interpreted", gaps: [] },
        query: {
          contract: "source-semantic-query-meaning-v5",
          alternatives: [{ conditions: [{
            kind: "statement", key: "accession", predicate: "accession",
            arguments: [
              { role: "object", target: { kind: "free", key: "folio", return: true }, excerpt: "folio" },
              { role: "bay", target: { kind: "named", key: "bay", excerpt: "bay B" }, excerpt: "bay B" }
            ]
          }] }],
          gaps: []
        }
      }))
    });
    expect(received.request.contract).toBe(SOURCE_SEMANTIC_QUERY_MEANING_REQUEST_CONTRACT);
    expect(received.request.original_query).toBe("which folio was accessioned into bay B?");
    expect(received.query?.variables.map((row) => row.id)).toContain("folio");
    expect(() => proposeQuerySemantics({
      original_query: "which folio was accessioned into bay B?",
      producer_id: "query-producer", producer_version: "1",
      answers: ["F"]
    } as never)).toThrow(/answers/u);
  });

  it("accepts admitted query semantics plus source-interpretation descriptors and rejects ranking or seeds", () => {
    const sourceInterpretation = currentInterpretation();
    const correspondenceInput = { original_query: "which folio was accessioned into bay B?",
      admitted_query_semantics: admittedQuery(),
      source_interpretation_descriptors: [{
        source_interpretation_id: sourceSemanticInterpretationIdentity(sourceInterpretation, semanticSha256), interpretation: sourceInterpretation
      }],
      producer_id: "correspondence-producer", producer_version: "1"
    };
    const prepared = proposeCorrespondenceSemantics(correspondenceInput);
    expect(prepared.request.original_query).toBe(correspondenceInput.original_query);
    expect(() => proposeCorrespondenceSemantics({ ...correspondenceInput,
      original_query: "a different query" })).toThrow(/does not bind the original query/u);
    expect(() => proposeCorrespondenceSemantics({ ...correspondenceInput,
      original_query: "" })).toThrow(/requires the original query/u);
    const predicate = prepared.request.catalog?.query_endpoints.find((row) => row.kind === "predicate");
    const frame = prepared.request.catalog?.source_endpoints.find((row) => row.kind === "frame");
    const received = proposeCorrespondenceSemantics(correspondenceInput, {
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
    expect(received.request.contract).toBe(SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_REQUEST_CONTRACT);
    expect(received.semantic_correspondence?.correspondences).toHaveLength(1);
    expect(received.request.source_interpretation_descriptors[0]!.interpretation.mentions.length).toBe(6);
    expect(received.request.source_interpretation_descriptors[0]!.interpretation.frames[0]!.bindings.length).toBe(3);
    expect(() => proposeCorrespondenceSemantics({ original_query: "which folio was accessioned into bay B?",
      admitted_query_semantics: admittedQuery(),
      source_interpretation_descriptors: [{ source_interpretation_id: digest, source_id: "src", source_version: "1", frames: [] }],
      producer_id: "correspondence-producer", producer_version: "1",
      ranking: [digest], seeds: ["fAccession"]
    } as never)).toThrow(/ranking|seeds/u);
  });
});

it("keeps a located no-proposition disposition distinct from abstention", () => {
  const input = sourceInput("Thank you very much for the detailed response and helpful explanation.");
  const row = sourceSemanticRequestCatalog(buildSourceSemanticRequest(input)).assertions[0]!;
  const disposition = { status: "no_executable_proposition", description: "Acknowledgement without an executable proposition",
    context_support: [{ assertion_id: row.assertion_id, text: "Thank you very much" }] };
  const received = proposeSourceSemantics(input, { rawJson: JSON.stringify({
    contract: "source-semantic-proposal-v8", outcome: disposition
  }) });
  expect(received.outcome.status).toBe("no_executable_proposition");
  expect(received.provider_attempts).toBe(1);
  expect(received.interpretation).toBeUndefined();
  const forged = { ...disposition, context_support: [{ assertion_id: row.assertion_id, text: "unrecorded" }] };
  expect(proposeSourceSemantics(input, { rawJson: JSON.stringify({
    contract: "source-semantic-proposal-v8", outcome: forged
  }) }).outcome.status).toBe("invalid");
});
