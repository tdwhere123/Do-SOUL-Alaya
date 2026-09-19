import { describe, expect, it, vi } from "vitest";
import { sourceReferenceResolver, sourceSemanticInterpretationIdentity, type SourceInterpretationProfile } from "@do-soul/alaya-protocol";
import { buildOfficialApiSourceCorpus, indexOfficialApiSourceAssertions } from "../../../garden/triage/grounding/source-locator.js";
import { parseOfficialApiSourcePacketRequest } from "../../../garden/ingestion/official-api/source-packet-request.js";
import {
  SOURCE_SEMANTIC_ALIGNMENT_REQUEST_CONTRACT, SOURCE_SEMANTIC_QUERY_REQUEST_CONTRACT,
  SOURCE_SEMANTIC_SYSTEM_PROMPT, buildSourceSemanticRequest, semanticSha256,
  sourceSemanticResponseJsonSchema
} from "../../../garden/ingestion/official-api/source-semantic-request.js";
import {
  MAX_SOURCE_SEMANTIC_RESPONSE_BYTES, proposeAlignmentSemantics, proposeQuerySemantics,
  proposeSourceSemantics
} from "../../../garden/ingestion/official-api/source-semantic-receive.js";

const PROFILE: SourceInterpretationProfile = {
  contract: "source-interpretation-profile-v1", description: "Observed acts of seeing",
  predicates: [{ symbol: "see", governing_roles: [], meaning: "A perceiver sees a theme." }],
  roles: [{ symbol: "perceiver", meaning: "Participant perceiving." }, { symbol: "theme", meaning: "What is perceived." }]
};

const TEXT = "The archivist accessioned folio F into bay B.";

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
  const hits = request.source_catalog.assertions[0]!.segments.filter((row) => row.text === text);
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

function interpretedJson(request: ReturnType<typeof buildSourceSemanticRequest>, gaps: readonly object[] = []) {
  const draft = accessionDraft(request, gaps);
  return JSON.stringify({
    contract: "source-interpretation-response-v4",
    outcome: { status: "interpreted", gaps },
    draft
  });
}

const digest = `sha256:${"a".repeat(64)}`;

function admittedQuery() {
  return {
    contract: "source-semantic-query-v2" as const,
    original_query_digest: `sha256:${semanticSha256("which folio was accessioned into bay B?")}`,
    producer_id: "query-producer", producer_version: "1", contract_version: "source-semantic-query-v2",
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

describe("open source semantic proposal producer", () => {
  it("normalizes the complete neutral prompt example through the real request catalog", () => {
    const rawJson = SOURCE_SEMANTIC_SYSTEM_PROMPT.split("Example response:\n")[1]!;
    const input = { sourceCorpus: "Mira shelved something. The label is hard to interpret.", assertionIds: [1, 2],
      source_id: "example", source_version: "1", producer_id: "authored", producer_version: "1" };
    const received = proposeSourceSemantics(input, { rawJson });
    expect(received.outcome.status).toBe("interpreted");
    expect(received.interpretation?.mentions.map((row) => row.text)).toEqual(["Mira", "shelved", "something", "The label is hard to interpret."]);
    expect(received.interpretation?.gaps).toEqual(JSON.parse(rawJson).outcome.gaps);
    expect(received.interpretation?.gaps).toHaveLength(2);
    expect(received.interpretation?.frames.map((row) => row.id)).toEqual(["fShelve"]);
    expect(received.interpretation?.gaps[1]).toMatchObject({ kind: "uninterpreted_clause", affected_ids: ["mClause"] });
    expect(received.interpretation?.frames[0]?.bindings.map((row) => row.target)).toEqual([
      { kind: "node", id: "rActor" }, { kind: "node", id: "rItem" }
    ]);
  });
  it.each(["mention_target", "undeclared_gap"] as const)("rejects %s in a partial proposal without repairing its handles", (failure) => {
    const envelope = JSON.parse(SOURCE_SEMANTIC_SYSTEM_PROMPT.split("Example response:\n")[1]!);
    const input = { sourceCorpus: "Mira shelved something. The label is hard to interpret.", assertionIds: [1, 2],
      source_id: "example", source_version: "1", producer_id: "authored", producer_version: "1" };
    if (failure === "mention_target") envelope.draft.frames[0].bindings[0].target.id = "mActor";
    else {
      envelope.draft.gaps[1].affected_ids = ["fOmitted"];
      envelope.outcome.gaps = envelope.draft.gaps;
    }
    const rawJson = JSON.stringify(envelope);
    const received = proposeSourceSemantics(input, { rawJson });
    expect(received.outcome).toMatchObject({ status: "invalid", reason: "malformed_response", diagnostics: [{
      code: "unknown_cross_reference",
      path: failure === "mention_target" ? ["draft", "frames", 0, "bindings", 0, "target", "id"] : ["draft", "gaps", 1, "affected_ids", 0],
      reference: failure === "mention_target" ? "mActor" : "fOmitted"
    }] });
    expect(received.rawJson).toBe(rawJson);
    expect(received.raw_response_id).toBe(`sha256:${semanticSha256(rawJson)}`);
    expect(received.draft).toBeUndefined();
    expect(received.interpretation).toBeUndefined();
  });
  it("builds an open request with catalog, versions, capability and limits and no mandatory profile", () => {
    const request = buildSourceSemanticRequest(sourceInput());
    expect(request.schema_version).toBe(5);
    expect(request.interpretation_contract).toBe("source-interpretation-v4");
    expect(request.profile).toBeUndefined();
    expect(request.source_request.k_version).toBe("source-semantic-k-v3");
    expect(request.source_request.producer_capability.proposes).toBe("draft_semantics");
    expect(request.source_request.resource_limits.output_byte_limit).toBe(1024 * 1024);
    expect(request.source_catalog.assertions.length).toBe(1);
    expect(JSON.stringify(request)).not.toMatch(/profile_id/u);
    expect(() => parseOfficialApiSourcePacketRequest(request)).toThrow();
    expect(SOURCE_SEMANTIC_SYSTEM_PROMPT).toMatch(/Do not emit host hashes/u);
    expect(SOURCE_SEMANTIC_SYSTEM_PROMPT).toMatch(/not an admission prerequisite/u);
    const schema = JSON.stringify(sourceSemanticResponseJsonSchema());
    expect(schema).not.toContain('"enum":["see"]');
    expect(schema).not.toContain('"enum":["perceiver","theme"]');
  });

  it("admits a novel predicate from an injected draft and normalizes catalog first/last", () => {
    const input = sourceInput();
    const request = buildSourceSemanticRequest(input);
    const received = proposeSourceSemantics(input, { rawJson: interpretedJson(request) });
    expect(received.provider_attempts).toBe(1);
    expect(received.outcome.status).toBe("interpreted");
    expect(received.draft?.frames[0]?.predicate_support).toEqual({
      kind: "explicit", reading: "accession", mentions: ["mAccessioned"]
    });
    expect(received.interpretation?.frames[0]?.slots.map((row) => row.role_reading)).toEqual(["agent", "folio", "bay"]);
    const references = sourceReferenceResolver(request.source_catalog, semanticSha256);
    const mention = received.interpretation!.mentions.find((row) => row.id === "mAccessioned")!;
    expect(references.resolve(request.source_catalog.catalog_id, mention.assertion_id, mention.source_ref).text)
      .toBe("accessioned");
    expect(received.raw_response_id).toMatch(/^sha256:/u);
    const withProfileInput = { ...input, profile: PROFILE };
    const withProfile = proposeSourceSemantics(withProfileInput, {
      rawJson: interpretedJson(buildSourceSemanticRequest(withProfileInput))
    });
    expect(withProfile.request.profile).toEqual(PROFILE);
    expect(withProfile.draft?.frames[0]?.predicate_support.reading).toBe("accession");
  });

  it("keeps abstention as abstained with a receipt and does not convert it to empty success", () => {
    const received = proposeSourceSemantics(sourceInput(), {
      rawJson: JSON.stringify({ contract: "source-interpretation-response-v4", outcome: { status: "abstained" } })
    });
    expect(received.outcome.status).toBe("abstained");
    expect(received.provider_attempts).toBe(1);
    expect(received.draft).toBeUndefined();
    expect(received.interpretation).toBeUndefined();
    expect(received.raw_response_id).toMatch(/^sha256:/u);
  });

  it("keeps partial interpretation plus explicit gaps", () => {
    const input = sourceInput();
    const request = buildSourceSemanticRequest(input);
    const gaps = [{ kind: "unresolved_referent", affected_ids: ["rBay"], support: [], description: "bay identity uncertain" }];
    const received = proposeSourceSemantics(input, { rawJson: interpretedJson(request, gaps) });
    expect(received.outcome).toEqual({ status: "interpreted", gaps });
    expect(received.draft?.gaps).toEqual(gaps);
    expect(received.interpretation?.gaps[0]?.kind).toBe("unresolved_referent");
  });

  it("rejects outcome-only gaps instead of silently dropping them", () => {
    const input = sourceInput(), request = buildSourceSemanticRequest(input);
    const envelope = JSON.parse(interpretedJson(request));
    envelope.outcome.gaps = [{ kind: "unresolved_referent", affected_ids: ["rBay"], support: [] }];
    const received = proposeSourceSemantics(input, { rawJson: JSON.stringify(envelope) });
    expect(received.outcome.status).toBe("invalid");
    expect(received.interpretation).toBeUndefined();
  });

  it("identifies catalog IDs used as graph mention handles without repairing them", () => {
    const input = sourceInput(), request = buildSourceSemanticRequest(input);
    const envelope = JSON.parse(interpretedJson(request));
    const reference = segment(request, "archivist").id;
    envelope.draft.frames[0].slots[0].support[0].mentions = [reference];
    const rawJson = JSON.stringify(envelope);
    const received = proposeSourceSemantics(input, { rawJson });
    expect(received.outcome).toMatchObject({ status: "invalid", reason: "malformed_response", diagnostics: [{
      code: "unknown_cross_reference", path: ["draft", "frames", 0, "slots", 0, "support", 0, "mentions", 0], reference
    }] });
    expect(received.rawJson).toBe(rawJson);
    expect(received.raw_response_id).toBe(`sha256:${semanticSha256(rawJson)}`);
    expect(received.interpretation).toBeUndefined();
  });

  it("treats a v2 packet:null refusal as invalid instead of successful empty", () => {
    const received = proposeSourceSemantics(sourceInput(), {
      rawJson: JSON.stringify({ contract: "source-interpretation-response-v2", packet: null })
    });
    expect(received.outcome.status).toBe("invalid");
    expect(received.provider_attempts).toBe(1);
    expect(received.raw_response_id).toMatch(/^sha256:/u);
    expect(received).not.toHaveProperty("packet");
    expect(received.interpretation).toBeUndefined();
  });

  it("quarantines bad catalog references rather than admitting an H", () => {
    const input = sourceInput();
    const request = buildSourceSemanticRequest(input);
    const draft = accessionDraft(request);
    draft.mentions = draft.mentions.map((row) => row.id === "mF"
      ? { ...row, source_ref: { first: "a1s999", last: "a1s999" } } : row);
    const received = proposeSourceSemantics(input, {
      rawJson: JSON.stringify({
        contract: "source-interpretation-response-v4",
        outcome: { status: "interpreted", gaps: [] },
        draft
      })
    });
    expect(received.outcome.status).toBe("invalid");
    expect(received.interpretation).toBeUndefined();
    expect(received.raw_response_id).toMatch(/^sha256:/u);
  });

  it("keeps malformed JSON distinct from interpreted empty", () => {
    const received = proposeSourceSemantics(sourceInput(), { rawJson: '{"contract":true}' });
    expect(received.outcome.status).toBe("invalid");
    expect(received.provider_attempts).toBe(1);
    expect(received.draft).toBeUndefined();
  });

  it("keeps incomplete JSON as invalid rather than truncated or abstained", () => {
    for (const rawJson of ['{"contract":"source-interpretation-response-v4"', '{"a":', "[", '{"a":"']) {
      const received = proposeSourceSemantics(sourceInput(), { rawJson });
      expect(received.outcome, rawJson).toEqual({ status: "invalid", reason: "malformed_json" });
      expect(received.provider_attempts).toBe(1);
    }
  });

  it("bounds raw response bytes before JSON parse", () => {
    const received = proposeSourceSemantics(sourceInput(), {
      rawJson: "中".repeat(Math.ceil(MAX_SOURCE_SEMANTIC_RESPONSE_BYTES / 3))
    });
    expect(received.outcome.status).toBe("truncated");
    expect(received.provider_attempts).toBe(1);
  });

  it("returns no_eligible_source with zero attempts and never dispatches", () => {
    const received = proposeSourceSemantics({
      sourceCorpus: "", assertionIds: [], source_id: "src", source_version: "1",
      producer_id: "authored-producer", producer_version: "p1"
    }, { rawJson: interpretedJson(buildSourceSemanticRequest(sourceInput())) });
    expect(received.outcome).toEqual({ status: "no_eligible_source", provider_attempts: 0 });
    expect(received.provider_attempts).toBe(0);
    expect(received.raw_response_id).toBeUndefined();
  });

  it("returns unexercised when no injected response is supplied", () => {
    expect(proposeSourceSemantics(sourceInput()).outcome.status).toBe("unexercised");
  });
});

describe("query and alignment proposal entry points", () => {
  it("prepares native Q/A prompts without provider calls and retains them on injected success or failure", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("provider calls are forbidden"));
    try {
      const source = sourceInput(), sourceRequest = buildSourceSemanticRequest(source);
      const h = proposeSourceSemantics(source, { rawJson: interpretedJson(sourceRequest) }).interpretation!;
      const query = admittedQuery();
      const queryInput = { original_query: "which folio was accessioned into bay B?", producer_id: "query-producer", producer_version: "1" };
      const alignmentInput = { admitted_q: query,
        h_descriptors: [{ h_id: sourceSemanticInterpretationIdentity(h, semanticSha256), interpretation: h }],
        producer_id: "align-producer", producer_version: "1" };
      const preparedQuery = proposeQuerySemantics(queryInput);
      const preparedAlignment = proposeAlignmentSemantics(alignmentInput);
      for (const prepared of [preparedQuery, preparedAlignment]) {
        expect(prepared.outcome).toEqual({ status: "unexercised" });
        expect(prepared.provider_attempts).toBe(0);
        expect(prepared.raw_response_id).toBeUndefined();
        expect(prepared.request).not.toHaveProperty("system_prompt");
      }
      expect(preparedQuery.system_prompt).toContain("outcome.gaps must exactly echo query.gaps");
      expect(preparedAlignment.system_prompt).toContain("outcome.gaps must be empty");
      for (const valid of [false, true]) {
        const q = proposeQuerySemantics(queryInput, { rawJson: valid ? JSON.stringify({
          contract: "source-semantic-query-response-v2", outcome: { status: "interpreted", gaps: [] },
          query: { variables: query.variables, alternatives: query.alternatives, return_variables: query.return_variables, gaps: [] }
        }) : "{}" });
        const a = proposeAlignmentSemantics(alignmentInput, { rawJson: valid ? JSON.stringify({
          contract: "source-semantic-alignment-response-v2", outcome: { status: "interpreted", gaps: [] }, alignment: { correspondences: [] }
        }) : "{}" });
        expect(q.outcome.status).toBe(valid ? "interpreted" : "invalid");
        expect(a.outcome.status).toBe(valid ? "interpreted" : "invalid");
        expect(q.system_prompt).toBe(preparedQuery.system_prompt);
        expect(a.system_prompt).toBe(preparedAlignment.system_prompt);
        expect(q.request).toEqual(preparedQuery.request);
        expect(a.request).toEqual(preparedAlignment.request);
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it.each([false, true])("validates query outcome gaps against the admitted body (matching=%s)", (matching) => {
    const query = admittedQuery();
    const gaps = [{ kind: "unresolved_referent", affected_ids: ["bay"], support: [] }];
    const received = proposeQuerySemantics({ original_query: "which folio was accessioned into bay B?",
      producer_id: "query-producer", producer_version: "1" }, { rawJson: JSON.stringify({
      contract: "source-semantic-query-response-v2", outcome: { status: "interpreted", gaps },
      query: { variables: query.variables, alternatives: query.alternatives,
        return_variables: query.return_variables, gaps: matching ? gaps : [] }
    }) });
    if (matching) {
      expect(received.outcome).toEqual({ status: "interpreted", gaps });
      expect(received.query?.gaps).toEqual(gaps);
    } else {
      expect(received.outcome).toMatchObject({ status: "invalid", diagnostics: [{ code: "outcome_gap_mismatch", path: ["outcome", "gaps"] }] });
      expect(received.query).toBeUndefined();
    }
  });

  it("rejects alignment outcome gaps rather than returning successful empty gaps", () => {
    const input = sourceInput(), request = buildSourceSemanticRequest(input);
    const h = proposeSourceSemantics(input, { rawJson: interpretedJson(request) }).interpretation!;
    const received = proposeAlignmentSemantics({ admitted_q: admittedQuery(),
      h_descriptors: [{ h_id: sourceSemanticInterpretationIdentity(h, semanticSha256), interpretation: h }],
      producer_id: "align-producer", producer_version: "1" }, { rawJson: JSON.stringify({
      contract: "source-semantic-alignment-response-v2",
      outcome: { status: "interpreted", gaps: [{ kind: "unsupported_meaning", affected_ids: [], support: [] }] },
      alignment: { correspondences: [] }
    }) });
    expect(received.outcome).toMatchObject({ status: "invalid", diagnostics: [{ code: "outcome_gap_mismatch", path: ["outcome", "gaps"] }] });
    expect(received.alignment).toBeUndefined();
  });

  it("accepts the original query and approved context and rejects answers or programs", () => {
    const query = admittedQuery();
    const body = {
      variables: query.variables, alternatives: query.alternatives,
      return_variables: query.return_variables, gaps: query.gaps
    };
    const received = proposeQuerySemantics({
      original_query: "which folio was accessioned into bay B?",
      approved_fixed_context: { context_id: "fixed-ctx" },
      producer_id: "query-producer", producer_version: "1"
    }, {
      rawJson: JSON.stringify({
        contract: "source-semantic-query-response-v2",
        outcome: { status: "interpreted", gaps: [] },
        query: body
      })
    });
    expect(received.request.contract).toBe(SOURCE_SEMANTIC_QUERY_REQUEST_CONTRACT);
    expect(received.request.original_query).toBe("which folio was accessioned into bay B?");
    expect(received.query?.variables.map((row) => row.id)).toContain("folio");
    expect(() => proposeQuerySemantics({
      original_query: "which folio was accessioned into bay B?",
      producer_id: "query-producer", producer_version: "1",
      answers: ["F"]
    } as never)).toThrow(/answers/u);
  });

  it("accepts admitted Q plus H descriptors and rejects ranking or seeds", () => {
    const input = sourceInput(), request = buildSourceSemanticRequest(input);
    const h = proposeSourceSemantics(input, { rawJson: interpretedJson(request) }).interpretation!;
    const received = proposeAlignmentSemantics({
      admitted_q: admittedQuery(),
      h_descriptors: [{
        h_id: sourceSemanticInterpretationIdentity(h, semanticSha256), interpretation: h
      }],
      producer_id: "align-producer", producer_version: "1"
    }, {
      rawJson: JSON.stringify({
        contract: "source-semantic-alignment-response-v2",
        outcome: { status: "interpreted", gaps: [] },
        alignment: {
          correspondences: [{
            relation: "contextual_equivalence",
            query_endpoint: { kind: "predicate", alternative: 0, frame: "qAccession" },
            source_endpoint: { kind: "frame", frame: "fAccession" },
            query_support: { kind: "query_text", excerpt: "accessioned" },
            source_semantic_support: [{ kind: "lexical", mentions: ["mAccessioned"] }]
          }]
        }
      })
    });
    expect(received.request.contract).toBe(SOURCE_SEMANTIC_ALIGNMENT_REQUEST_CONTRACT);
    expect(received.alignment?.correspondences).toHaveLength(1);
    expect(received.request.h_descriptors[0]!.interpretation.mentions.length).toBe(6);
    expect(received.request.h_descriptors[0]!.interpretation.frames[0]!.bindings.length).toBe(3);
    expect(() => proposeAlignmentSemantics({
      admitted_q: admittedQuery(),
      h_descriptors: [{ h_id: digest, source_id: "src", source_version: "1", frames: [] }],
      producer_id: "align-producer", producer_version: "1",
      ranking: [digest], seeds: ["fAccession"]
    } as never)).toThrow(/ranking|seeds/u);
  });
});

it("retains a located no-proposition disposition without confusing it with abstention", () => {
  const input = sourceInput("Thank you very much for the detailed response and helpful explanation."), request = buildSourceSemanticRequest(input);
  const row = request.source_catalog.assertions[0]!;
  const disposition = { status: "no_executable_proposition", description: "Acknowledgement without an executable proposition",
    context_support: [{ kind: "source_reference", assertion_id: row.assertion_id,
      source_ref: { first: row.segments[0]!.id, last: row.segments.at(-1)!.id } }] };
  const received = proposeSourceSemantics(input, { rawJson: JSON.stringify({ contract: "source-interpretation-response-v4", outcome: disposition }) });
  expect(received.outcome).toEqual(disposition);
  expect(received.provider_attempts).toBe(1); expect(received.draft).toBeUndefined(); expect(received.raw_response_id).toBeDefined();
  const forged = { ...disposition, context_support: [{ kind: "source_reference", assertion_id: row.assertion_id,
    source_ref: { first: "a999s0", last: "a999s0" } }] };
  expect(proposeSourceSemantics(input, { rawJson: JSON.stringify({ contract: "source-interpretation-response-v4", outcome: forged }) }).outcome.status).toBe("invalid");
});
