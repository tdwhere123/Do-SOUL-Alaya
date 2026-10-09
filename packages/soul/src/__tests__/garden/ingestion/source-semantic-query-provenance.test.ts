import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  SOURCE_SEMANTIC_K_VERSION, SOURCE_SEMANTIC_NORMALIZER_VERSION, SOURCE_SEMANTIC_MAX_BYTES,
  SourceSemanticInterpretationSchema, SourceSemanticQuerySchema,
  countSourceSemanticCorrespondenceJsonBytes,
  sourceSemanticInterpretationIdentity, sourceSemanticQueryIdentity, UNKNOWN_UTTERANCE_ATTRIBUTION,
  type SourceSemanticQuery
} from "@do-soul/alaya-protocol";
import {
  SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT, SOURCE_SEMANTIC_CORRESPONDENCE_SYSTEM_PROMPT,
  semanticSha256, sourceSemanticCorrespondenceResponseJsonSchema
} from "../../../garden/ingestion/official-api/source-semantic-request.js";
import { proposeCorrespondenceSemantics } from "../../../garden/ingestion/official-api/source-semantic-receive.js";
import {
  prepareSourceSemanticLibrary, sourceSemanticLibraryCorrespondenceCacheKey
} from "../../../garden/ingestion/official-api/source-semantic-library-prepare.js";
import {
  SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_RESPONSE_CONTRACT,
  completeSourceSemanticCorrespondenceGenerationAssessment,
  resolveSourceSemanticQueryProvenance, sourceSemanticCorrespondenceGenerationResponseJsonSchema
} from "../../../garden/ingestion/official-api/source-semantic-query-provenance.js";

const ORIGINAL = "Did Maya mend the coat?";
const role = (id: string, variable: string, excerpt: string) => ({
  id, role_reading: id, target_variable: variable, support: { kind: "query_text" as const, excerpt }
});

function query(extra: Partial<SourceSemanticQuery> = {}) {
  return SourceSemanticQuerySchema.parse({
    contract: "source-semantic-query-v4",
    original_query_digest: `sha256:${semanticSha256(ORIGINAL)}`,
    approved_fixed_context: null, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    producer_id: "query-producer", producer_version: "1", contract_version: "source-semantic-query-v4",
    variables: [
      { id: "maya", sort: "entity", reference: { kind: "query_text", excerpt: "Maya" } },
      { id: "coat", sort: "entity" },
      { id: "fMend", sort: "proposition" }
    ],
    alternatives: [{
      frames: [{
        id: "qMend", variable: "fMend", predicate_reading: "mend",
        role_requirements: [role("agent", "maya", "Maya"), role("theme", "coat", "the coat")]
      }],
      context_obligations: [{ frame: "qMend", kind: "asserted_at_source" }]
    }],
    return_variables: ["coat"],
    gaps: [],
    ...extra
  });
}

function interpretation() {
  const mention = (id: string, text: string, start: number) => ({
    id, assertion_id: 1, source_ref: { first: "a1s0", last: "a1s0" }, text, utf8_span: [start, start + text.length]
  });
  return SourceSemanticInterpretationSchema.parse({
    contract: "source-interpretation-v4",
    k_version: SOURCE_SEMANTIC_K_VERSION, normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
    source: { source_id: "src", source_version: "1", content_digest: `sha256:${semanticSha256(ORIGINAL)}`,
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION },
    producer_id: "h-producer", producer_version: "1", contract_version: "source-interpretation-v4",
    mentions: [mention("mMaya", "Maya", 0), mention("mMend", "mended", 5), mention("mCoat", "coat", 12)],
    referents: [
      { id: "rMaya", referent_kind: "grouped", mentions: ["mMaya"] },
      { id: "rCoat", referent_kind: "grouped", mentions: ["mCoat"] }
    ],
    frames: [{
      id: "fMend", assertion_ids: [1],
      context_owner: { kind: "source_act", source_act: "assertion" },
      additional_support: [],
      predicate_support: { kind: "explicit", reading: "mend", mentions: ["mMend"] },
      slots: [
        { id: "agent", role_reading: "agent", support: [{ kind: "lexical", mentions: ["mMaya"] }] },
        { id: "theme", role_reading: "theme", support: [{ kind: "lexical", mentions: ["mCoat"] }] }
      ],
      bindings: [
        { slot_id: "agent", target: { kind: "node", id: "rMaya" }, support: [] },
        { slot_id: "theme", target: { kind: "node", id: "rCoat" }, support: [] }
      ]
    }],
    operators: [], gaps: [], entry_roots: ["fMend"], asserted_at_scope: ["fMend"]
  });
}

function input() {
  const source = interpretation();
  return {
    original_query: ORIGINAL, admitted_query_semantics: query(),
    source_interpretation_descriptors: [{
      source_interpretation_id: sourceSemanticInterpretationIdentity(source, semanticSha256),
      interpretation: source
    }],
    producer_id: "correspondence-producer", producer_version: "1"
  };
}

function catalogOf() {
  return proposeCorrespondenceSemantics(input()).request.catalog;
}

function handles() {
  const catalog = catalogOf();
  return {
    catalog,
    referent: catalog.query_endpoints.find((row) => row.kind === "referent")!,
    predicate: catalog.query_endpoints.find((row) => row.kind === "predicate")!,
    agent: catalog.query_endpoints.find((row) => row.kind === "slot" && row.slot === "agent")!,
    theme: catalog.query_endpoints.find((row) => row.kind === "slot" && row.slot === "theme")!,
    frame: catalog.source_endpoints.find((row) => row.kind === "frame")!,
    sourceReferent: catalog.source_endpoints.find((row) => row.kind === "referent" && row.referent === "rCoat")!
  };
}

function nonquotation(body: Record<string, unknown>) {
  const assessments = Array.isArray(body.assessments) ? body.assessments : [];
  return {
    source_interpretation_handle: body.source_interpretation_handle,
    domains: body.domains ?? null,
    membership_assumptions: body.membership_assumptions ?? null,
    assessments: assessments.map((row) => {
      const item = row as Record<string, unknown>;
      return {
        query: item.query, status: item.status, explanation: item.explanation ?? null,
        equivalents: Array.isArray(item.equivalents)
          ? item.equivalents.map((entry) => {
            const equivalent = entry as Record<string, unknown>;
            return {
              source: equivalent.source, source_semantic_support: equivalent.source_semantic_support,
              applicable_context: equivalent.applicable_context ?? null, grounding: equivalent.grounding
            };
          }) : null
      };
    })
  };
}

function omitEligibleQuotes(assessments: readonly Record<string, unknown>[], eligible: ReadonlySet<string>) {
  return assessments.map((row) => {
    if (!eligible.has(row.query as string)) return row;
    if (row.status === "unresolved") {
      const { query_excerpt: _omit, ...rest } = row;
      return rest;
    }
    if (!Array.isArray(row.equivalents)) return row;
    return {
      ...row,
      equivalents: row.equivalents.map((entry) => {
        const equivalent = entry as Record<string, unknown>;
        const { query_excerpt: _omit, ...rest } = equivalent;
        return rest;
      })
    };
  });
}

describe("query provenance generation completion", () => {
  it("resolves unique stored referent and role quotes and leaves predicates ineligible", () => {
    const request = proposeCorrespondenceSemantics(input()).request;
    const resolved = resolveSourceSemanticQueryProvenance(
      request.admitted_query_semantics, request.catalog, ORIGINAL
    );
    const { referent, predicate, agent, theme } = handles();
    expect(resolved.eligible).toEqual([
      { handle: referent.handle, excerpt: "Maya" },
      { handle: agent.handle, excerpt: "Maya" },
      { handle: theme.handle, excerpt: "the coat" }
    ]);
    expect(resolved.ineligible).toEqual([predicate.handle]);
  });

  it("rejects mixed, missing, and original-query-absent support without borrowing readings", () => {
    const base = query() as SourceSemanticQuery;
    const mixed = {
      ...base,
      alternatives: [{
        ...base.alternatives[0]!,
        frames: [{
          ...base.alternatives[0]!.frames[0]!,
          role_requirements: [
            { id: "agent", role_reading: "agent", target_variable: "maya",
              support: [{ kind: "query_text", excerpt: "Maya" }, { kind: "query_text", excerpt: "mend" }] },
            base.alternatives[0]!.frames[0]!.role_requirements[1]!
          ]
        }]
      }]
    } as SourceSemanticQuery;
    const absent = {
      ...base,
      variables: base.variables.map((row) => row.id === "maya" ? { id: "maya", sort: "entity" as const } : row)
    } as SourceSemanticQuery;
    const foreign = {
      ...base,
      variables: base.variables.map((row) => row.id === "maya"
        ? { ...row, reference: { kind: "query_text" as const, excerpt: "Niko" } } : row)
    } as SourceSemanticQuery;
    const catalog = catalogOf();
    const agent = catalog.query_endpoints.find((row) => row.kind === "slot" && row.slot === "agent")!;
    const referent = catalog.query_endpoints.find((row) => row.kind === "referent")!;
    expect(resolveSourceSemanticQueryProvenance(mixed, catalog, ORIGINAL).ineligible).toContain(agent.handle);
    expect(resolveSourceSemanticQueryProvenance(absent, catalog, ORIGINAL).ineligible).toContain(referent.handle);
    expect(resolveSourceSemanticQueryProvenance(foreign, catalog, ORIGINAL).ineligible).toContain(referent.handle);
    expect(catalog.query_endpoints.find((row) => row.kind === "predicate")?.reading).toBe("mend");
  });

  it("completes omitted eligible quotes on supported and unresolved rows and preserves nonquotation fields", () => {
    const { referent, predicate, agent, theme, frame, sourceReferent } = handles();
    const completeBody = {
      contract: "source-semantic-correspondence-assessment-v1",
      source_interpretation_handle: "source1",
      assessments: [
        { query: referent.handle, status: "unresolved", query_excerpt: "Maya",
          explanation: "No Maya equivalent is proposed." },
        { query: predicate.handle, status: "supported", equivalents: [{
          source: frame.handle, query_excerpt: "mend", grounding: "The local mend relation.",
          source_semantic_support: [{ kind: "lexical", mentions: ["mMend"] }]
        }] },
        { query: agent.handle, status: "supported", equivalents: [{
          source: sourceReferent.handle, query_excerpt: "Maya", grounding: "Named actor.",
          source_semantic_support: [{ kind: "lexical", mentions: ["mMaya"] }]
        }] },
        { query: theme.handle, status: "unresolved", query_excerpt: "the coat",
          explanation: "Coat is unestablished." }
      ]
    };
    const eligible = new Set([referent.handle, agent.handle, theme.handle]);
    const omitted = { ...completeBody, assessments: omitEligibleQuotes(completeBody.assessments, eligible) };
    const received = proposeCorrespondenceSemantics(input(), {
      rawJson: JSON.stringify({
        contract: SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_RESPONSE_CONTRACT,
        outcome: { status: "interpreted" }, semantic_correspondence: omitted
      })
    });
    expect(received.outcome.status).toBe("interpreted");
    expect(received.assessment).toEqual(completeBody);
    expect(received.rawJson).toContain(SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_RESPONSE_CONTRACT);
    expect(JSON.parse(received.rawJson!).semantic_correspondence.assessments[0]).not.toHaveProperty("query_excerpt");
    expect(nonquotation(received.assessment as Record<string, unknown>)).toEqual(nonquotation(completeBody));
    expect(received.semantic_correspondence?.correspondences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        query_endpoint: { kind: "slot", alternative: 0, frame: "qMend", slot: "agent" },
        source_endpoint: { kind: "referent", referent: "rCoat" }
      })
    ]));
  });

  it("does not reinterpret a v4 envelope or repair supplied null, empty, or invalid quotes", () => {
    const { referent, predicate, agent, theme, frame } = handles();
    const unresolved = (handle: string, excerpt: unknown) => ({
      query: handle, status: "unresolved", query_excerpt: excerpt, explanation: "Open."
    });
    const v4 = {
      contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT,
      outcome: { status: "interpreted" },
      semantic_correspondence: {
        contract: "source-semantic-correspondence-assessment-v1", source_interpretation_handle: "source1",
        assessments: [
          unresolved(referent.handle, "agent"),
          { query: predicate.handle, status: "supported", equivalents: [{
            source: frame.handle, query_excerpt: "theme", grounding: "Reading.",
            source_semantic_support: [{ kind: "lexical", mentions: ["mMend"] }]
          }] },
          unresolved(agent.handle, null),
          unresolved(theme.handle, "")
        ]
      }
    };
    const v4Received = proposeCorrespondenceSemantics(input(), { rawJson: JSON.stringify(v4) });
    expect(v4Received.outcome.status).toBe("invalid");
    expect(v4Received.assessment).toBeUndefined();
    const omittedV4 = JSON.parse(JSON.stringify(v4));
    delete omittedV4.semantic_correspondence.assessments[0].query_excerpt;
    expect(proposeCorrespondenceSemantics(input(), { rawJson: JSON.stringify(omittedV4) }).outcome.status).toBe("invalid");
    const v5 = {
      contract: SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_RESPONSE_CONTRACT,
      outcome: { status: "interpreted" },
      semantic_correspondence: v4.semantic_correspondence
    };
    expect(proposeCorrespondenceSemantics(input(), { rawJson: JSON.stringify(v5) }).outcome.status).toBe("invalid");
  });

  it("fails missing predicate quotes, unknown handles, and does not borrow a nearby excerpt", () => {
    const { referent, predicate, agent, theme, frame } = handles();
    const body = {
      contract: "source-semantic-correspondence-assessment-v1", source_interpretation_handle: "source1",
      assessments: [
        { query: referent.handle, status: "unresolved", explanation: "Open." },
        { query: predicate.handle, status: "supported", equivalents: [{
          source: frame.handle, grounding: "Local relation.",
          source_semantic_support: [{ kind: "lexical", mentions: ["mMend"] }]
        }] },
        { query: agent.handle, status: "unresolved", explanation: "Open." },
        { query: theme.handle, status: "unresolved", explanation: "Open." }
      ]
    };
    const received = proposeCorrespondenceSemantics(input(), {
      rawJson: JSON.stringify({
        contract: SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_RESPONSE_CONTRACT,
        outcome: { status: "interpreted" }, semantic_correspondence: body
      })
    });
    expect(received.outcome.status).toBe("invalid");
    expect(received.assessment).toBeUndefined();
    const unknown = {
      ...body,
      assessments: [...body.assessments.slice(0, 3), { query: "qe99", status: "unresolved", explanation: "Unknown." }]
    };
    expect(proposeCorrespondenceSemantics(input(), {
      rawJson: JSON.stringify({
        contract: SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_RESPONSE_CONTRACT,
        outcome: { status: "interpreted" }, semantic_correspondence: unknown
      })
    }).outcome.status).toBe("invalid");
  });

  it("keeps a supplied valid excerpt that is not the resolver quote", () => {
    const { referent, predicate, agent, theme } = handles();
    const received = proposeCorrespondenceSemantics(input(), {
      rawJson: JSON.stringify({
        contract: SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_RESPONSE_CONTRACT,
        outcome: { status: "interpreted" },
        semantic_correspondence: {
          contract: "source-semantic-correspondence-assessment-v1", source_interpretation_handle: "source1",
          assessments: [
            { query: referent.handle, status: "unresolved", query_excerpt: "May", explanation: "Open." },
            { query: predicate.handle, status: "unresolved", query_excerpt: "mend", explanation: "Open." },
            { query: agent.handle, status: "unresolved", query_excerpt: "May", explanation: "Open." },
            { query: theme.handle, status: "unresolved", query_excerpt: "coat", explanation: "Open." }
          ]
        }
      })
    });
    expect(received.outcome.status).toBe("interpreted");
    expect(received.assessment?.assessments.map((row) => row.status === "unresolved" ? row.query_excerpt : null))
      .toEqual(["May", "mend", "May", "coat"]);
  });

  it("premeters escaped UTF-8 quote expansion before allocating completed assessments", () => {
    const excerpt = "quote\" slash\\ \n 猫\u{1F600}";
    const row = { query: "qe1", status: "unresolved", explanation: "Open." };
    let mapped = false;
    const assessments = new Proxy([row], {
      get(target, prop, receiver) {
        if (prop === "map") {
          mapped = true;
          return target.map.bind(target);
        }
        return Reflect.get(target, prop, receiver);
      }
    });
    const body = {
      contract: "source-semantic-correspondence-assessment-v1",
      source_interpretation_handle: "source1",
      assessments
    };
    const resolved = { eligible: [{ handle: "qe1", excerpt }], ineligible: [] };
    const originalBytes = countSourceSemanticCorrespondenceJsonBytes(body, SOURCE_SEMANTIC_MAX_BYTES);
    const extra = countSourceSemanticCorrespondenceJsonBytes({ query_excerpt: excerpt }, SOURCE_SEMANTIC_MAX_BYTES) - 1;
    expect(() => completeSourceSemanticCorrespondenceGenerationAssessment(body, resolved, extra + originalBytes - 1))
      .toThrow(/exceeds its byte bound/u);
    expect(mapped).toBe(false);
    expect(completeSourceSemanticCorrespondenceGenerationAssessment(body, resolved, extra + originalBytes))
      .toMatchObject({ assessments: [{ query: "qe1", query_excerpt: excerpt }] });
    expect(mapped).toBe(true);
    expect(SOURCE_SEMANTIC_CORRESPONDENCE_SYSTEM_PROMPT).toContain("Only request-schema-eligible referent and slot handles");
    expect(SOURCE_SEMANTIC_CORRESPONDENCE_SYSTEM_PROMPT).toContain("predicate handles and source words still require");
  });

  it("preserves a valid-empty comparison catalog through generation schema and receive", () => {
    const admitted = SourceSemanticQuerySchema.parse({
      contract: "source-semantic-query-v4",
      original_query_digest: `sha256:${semanticSha256(ORIGINAL)}`,
      approved_fixed_context: null, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
      producer_id: "query-producer", producer_version: "1", contract_version: "source-semantic-query-v4",
      variables: [{ id: "left", sort: "entity" }, { id: "right", sort: "entity" }],
      alternatives: [{ frames: [], context_obligations: [] }],
      return_variables: ["left", "right"], gaps: [],
      domains: [{ id: "garments", support: { kind: "query_text", excerpt: "coat" } }],
      evaluation: {
        kind: "comparison", domain: "garments", operation: "gt", left: "left", right: "right",
        strict: true, metric: "mass", unit: "kg", context: "weighing", scope: "asserted"
      }
    });
    const prepared = proposeCorrespondenceSemantics({ ...input(), admitted_query_semantics: admitted });
    expect(prepared.request.catalog.query_endpoints).toEqual([]);
    const schema = sourceSemanticCorrespondenceGenerationResponseJsonSchema(prepared.request);
    expect(JSON.stringify(schema)).toMatch(/"maxItems":0/u);
    const empty = {
      contract: SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_RESPONSE_CONTRACT,
      outcome: { status: "interpreted" },
      semantic_correspondence: {
        contract: "source-semantic-correspondence-assessment-v1", source_interpretation_handle: "source1",
        assessments: []
      }
    };
    const received = proposeCorrespondenceSemantics({ ...input(), admitted_query_semantics: admitted },
      { rawJson: JSON.stringify(empty) });
    expect(received.outcome.status).toBe("interpreted");
    expect(received.assessment?.assessments).toEqual([]);
    expect(received.semantic_correspondence?.correspondences).toEqual([]);
    const abstained = proposeCorrespondenceSemantics({ ...input(), admitted_query_semantics: admitted }, {
      rawJson: JSON.stringify({
        contract: SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_RESPONSE_CONTRACT, outcome: { status: "abstained" }
      })
    });
    expect(abstained.outcome.status).toBe("abstained");
    expect(abstained.assessment).toBeUndefined();
  });

  it("rejects well-formed host-state claims while preserving actual host parse and transport outcomes", () => {
    const prepared = input();
    for (const outcome of [
      { status: "truncated" }, { status: "transport_failure" }, { status: "resource_exhausted" },
      { status: "invalid", reason: "unsupported reading" }
    ]) {
      const body = { contract: SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_RESPONSE_CONTRACT, outcome };
      const received = proposeCorrespondenceSemantics(prepared, { rawJson: JSON.stringify(body) });
      expect(received.outcome.status).toBe("invalid");
      expect(received.outcome).not.toMatchObject(outcome);
      expect(received.rawJson).toBe(JSON.stringify(body));
    }
    const parsed = proposeCorrespondenceSemantics(prepared, { rawJson: "{" });
    expect(parsed.outcome).toEqual({ status: "invalid", reason: "malformed_json" });
    expect(parsed.rawJson).toBe("{");
    const empty = proposeCorrespondenceSemantics(prepared, { rawJson: "" });
    expect(empty.outcome.status).toBe("transport_failure");
    expect(empty.rawJson).toBe("");
  });

  it("derives a request-aware generation schema with at most two quote groups", () => {
    const request = proposeCorrespondenceSemantics(input()).request;
    const v4 = sourceSemanticCorrespondenceResponseJsonSchema() as Record<string, unknown>;
    const generated = sourceSemanticCorrespondenceGenerationResponseJsonSchema(request) as Record<string, unknown>;
    const publicGenerated = sourceSemanticCorrespondenceResponseJsonSchema(request) as Record<string, unknown>;
    const properties = generated.properties as Record<string, unknown>;
    const contract = properties.contract as { enum?: string[] };
    expect(publicGenerated).toEqual(generated);
    expect(contract.enum).toEqual([SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_RESPONSE_CONTRACT]);
    expect(JSON.stringify(v4)).toContain(SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT);
    expect(JSON.stringify(v4)).not.toContain(SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_RESPONSE_CONTRACT);
    expect(JSON.stringify(publicGenerated)).toContain(SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_RESPONSE_CONTRACT);
    expect(JSON.stringify(publicGenerated)).not.toContain(SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT);
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: true });
    expect(ajv.validateSchema(generated)).toBe(true);
    const validate = ajv.compile(generated);
    const missing = { contract: SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_RESPONSE_CONTRACT, outcome: { status: "interpreted" } };
    expect(validate(missing)).toBe(false);
    expect(proposeCorrespondenceSemantics(input(), { rawJson: JSON.stringify(missing) }).outcome)
      .toEqual({ status: "invalid", reason: "interpreted_correspondence_required" });
    expect(validate({ ...missing, outcome: { status: "abstained" } })).toBe(true);
    const validateRetained = ajv.compile(v4);
    expect(validateRetained({ ...missing, contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT })).toBe(false);
    const { referent, predicate, agent, theme } = handles();
    const eligibleOmitted = {
      contract: SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_RESPONSE_CONTRACT,
      outcome: { status: "interpreted" },
      semantic_correspondence: {
        contract: "source-semantic-correspondence-assessment-v1", source_interpretation_handle: "source1",
        assessments: [
          { query: referent.handle, status: "unresolved", explanation: "Open." },
          { query: predicate.handle, status: "unresolved", query_excerpt: "mend", explanation: "Open." },
          { query: agent.handle, status: "unresolved", explanation: "Open." },
          { query: theme.handle, status: "unresolved", explanation: "Open." }
        ]
      }
    };
    expect(validate(structuredClone(eligibleOmitted))).toBe(true);
    const negativeWithPayload = { ...eligibleOmitted, outcome: { status: "abstained" } };
    expect(validate(negativeWithPayload)).toBe(true);
    expect(proposeCorrespondenceSemantics(input(), { rawJson: JSON.stringify(negativeWithPayload) }).outcome)
      .toEqual({ status: "abstained" });
    const retainedNegative = { ...negativeWithPayload, contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT,
      semantic_correspondence: { ...negativeWithPayload.semantic_correspondence,
        assessments: negativeWithPayload.semantic_correspondence.assessments.map(row => ({ ...row,
          query_excerpt: row.query_excerpt ?? (row.query === referent.handle || row.query === agent.handle ? "Maya" : "the coat") })) } };
    expect(validateRetained(retainedNegative)).toBe(true);
    expect(proposeCorrespondenceSemantics(input(), { rawJson: JSON.stringify(retainedNegative) }).outcome)
      .toEqual({ status: "abstained" });
    const supported = (query: string) => ({ query, status: "supported", equivalents: [{
      source: handles().frame.handle, grounding: "The relation is explicit in the source.",
      source_semantic_support: [{ kind: "lexical", mentions: ["mMend"] }]
    }] });
    const supportedOmission = {
      ...eligibleOmitted,
      semantic_correspondence: {
        ...eligibleOmitted.semantic_correspondence,
        assessments: eligibleOmitted.semantic_correspondence.assessments.map(row =>
          row.query === agent.handle ? supported(row.query) : row)
      }
    };
    expect(validate(supportedOmission)).toBe(true);
    supportedOmission.semantic_correspondence.assessments =
      eligibleOmitted.semantic_correspondence.assessments.map(row =>
        row.query === predicate.handle ? supported(row.query) : row);
    expect(validate(supportedOmission)).toBe(false);
    const predicateOmitted = structuredClone(eligibleOmitted);
    delete (predicateOmitted.semantic_correspondence.assessments[1] as { query_excerpt?: string }).query_excerpt;
    expect(validate(predicateOmitted)).toBe(false);
  });

  it("preserves raw generation bytes and Q/H cache identity through library preparation", () => {
    const prepared = input();
    const { referent, predicate, agent, theme, frame } = handles();
    const rawJson = JSON.stringify({
      contract: SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_RESPONSE_CONTRACT,
      outcome: { status: "interpreted" },
      semantic_correspondence: {
        contract: "source-semantic-correspondence-assessment-v1", source_interpretation_handle: "source1",
        assessments: [
          { query: referent.handle, status: "unresolved", explanation: "Open." },
          { query: predicate.handle, status: "unresolved", query_excerpt: "mend", explanation: "Open." },
          { query: agent.handle, status: "supported", equivalents: [{
            source: frame.handle, grounding: "Actor.", source_semantic_support: [{ kind: "lexical", mentions: ["mMaya"] }]
          }] },
          { query: theme.handle, status: "unresolved", explanation: "Open." }
        ]
      }
    });
    const result = prepareSourceSemanticLibrary({
      original_query: ORIGINAL, admitted_query_semantics: prepared.admitted_query_semantics,
      source_interpretation_descriptors: prepared.source_interpretation_descriptors,
      produce: () => ({ rawJson }), producer_id: prepared.producer_id, producer_version: prepared.producer_version
    });
    const queryId = sourceSemanticQueryIdentity(prepared.admitted_query_semantics, semanticSha256);
    const sourceId = prepared.source_interpretation_descriptors[0]!.source_interpretation_id;
    const key = sourceSemanticLibraryCorrespondenceCacheKey(queryId, sourceId);
    expect(result.outcomes[0]?.status).toBe("interpreted");
    expect(result.cache[key]?.rawJson).toBe(rawJson);
    expect(result.cache[key]?.semantic_correspondence.correspondences.length).toBeGreaterThan(0);
    const v4Invalid = prepareSourceSemanticLibrary({
      ...prepared, produce: () => ({ rawJson: JSON.stringify({
        contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT,
        outcome: { status: "interpreted" },
        semantic_correspondence: {
          contract: "source-semantic-correspondence-assessment-v1", source_interpretation_handle: "source1",
          assessments: catalogOf().query_endpoints.map((row) => ({
            query: row.handle, status: "unresolved", query_excerpt: "agent", explanation: "Open."
          }))
        }
      }) })
    });
    expect(v4Invalid.outcomes[0]?.status).toBe("invalid");
    expect(Object.keys(v4Invalid.cache)).toEqual([]);
  });
});
