import { describe, expect, it, vi } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  SOURCE_SEMANTIC_K_VERSION, SOURCE_SEMANTIC_NORMALIZER_VERSION, SOURCE_SEMANTIC_PRODUCER_OUTCOMES,
  SourceSemanticInterpretationSchema, SourceSemanticQuerySchema, SourceSemanticResourceLedger,
  sourceSemanticInterpretationIdentity, sourceSemanticQueryIdentity, UNKNOWN_UTTERANCE_ATTRIBUTION
} from "@do-soul/alaya-protocol";
import {
  SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_REQUEST_CONTRACT,
  SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT,
  SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_REQUEST_CONTRACT, SOURCE_SEMANTIC_CORRESPONDENCE_LEGACY_SCOPED_REQUEST_CONTRACT,
  SOURCE_SEMANTIC_CORRESPONDENCE_SYSTEM_PROMPT,
  buildSourceSemanticCorrespondenceRequest, parseSourceSemanticCorrespondenceRequest, semanticSha256, sourceSemanticCorrespondenceResponseJsonSchema,
  sourceSemanticCorrespondenceSystemPrompt
} from "../../../garden/ingestion/official-api/source-semantic-request.js";
import { materializeSourceSemanticCorrespondenceFlatDraft, SourceSemanticCorrespondenceFlatDraftSchema } from "../../../garden/ingestion/official-api/source-semantic-correspondence-presentation.js";
import { proposeCorrespondenceSemantics, receiveCorrespondenceSemantics } from "../../../garden/ingestion/official-api/source-semantic-receive.js";
import {
  prepareSourceSemanticLibrary, sourceSemanticLibraryCorrespondenceCacheKey
} from "../../../garden/ingestion/official-api/source-semantic-library-prepare.js";
import {
  SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_RESPONSE_CONTRACT,
  SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_GENERATION_RESPONSE_CONTRACT
} from "../../../garden/ingestion/official-api/source-semantic-query-provenance.js";

const ORIGINAL = "How many things did Maya wash or mend?";
const role = (id: string, variable: string, excerpt: string) => ({
  id, role_reading: id, target_variable: variable, support: { kind: "query_text" as const, excerpt }
});

function query() {
  return SourceSemanticQuerySchema.parse({
    contract: "source-semantic-query-v4",
    original_query_digest: `sha256:${semanticSha256(ORIGINAL)}`,
    approved_fixed_context: null, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    producer_id: "query-producer", producer_version: "1", contract_version: "source-semantic-query-v4",
    variables: [
      { id: "maya", sort: "entity", reference: { kind: "query_text", excerpt: "Maya" } },
      { id: "thing", sort: "entity" },
      { id: "fWash", sort: "proposition" },
      { id: "fMend", sort: "proposition" }
    ],
    alternatives: [{
      frames: [
        { id: "wash", variable: "fWash", predicate_reading: "wash",
          role_requirements: [role("agent", "maya", "Maya"), role("theme", "thing", "things")] },
        { id: "mend", variable: "fMend", predicate_reading: "mend",
          role_requirements: [role("agent", "maya", "Maya"), role("theme", "thing", "things")] }
      ],
      context_obligations: [
        { frame: "wash", kind: "asserted_at_source" },
        { frame: "mend", kind: "asserted_at_source" }
      ],
      answer_frames: [],
      evidence_inputs: [{ frames: ["wash"] }, { frames: ["mend"] }]
    }],
    return_variables: [],
    gaps: [
      { kind: "unsupported_meaning", affected_ids: ["wash", "mend"],
        support: [{ kind: "query_text", excerpt: "did Maya wash or mend" }] },
      { kind: "aggregate", affected_ids: [], support: [{ kind: "query_text", excerpt: "How many" }] }
    ],
    requested_operation: { reading: "count", support: { kind: "query_text", excerpt: "How many" } }
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
    mentions: [mention("mMaya", "Maya", 0), mention("mWash", "washed", 5), mention("mMend", "mended", 12)],
    referents: [{ id: "rMaya", referent_kind: "grouped", mentions: ["mMaya"] }],
    frames: [{
      id: "fWash", assertion_ids: [1],
      context_owner: { kind: "source_act", source_act: "assertion" },
      additional_support: [],
      predicate_support: { kind: "explicit", reading: "wash", mentions: ["mWash"] },
      slots: [
        { id: "agent", role_reading: "agent", support: [{ kind: "lexical", mentions: ["mMaya"] }] },
        { id: "theme", role_reading: "theme", support: [] }
      ],
      bindings: [{ slot_id: "agent", target: { kind: "node", id: "rMaya" }, support: [] }]
    }],
    operators: [], gaps: [], entry_roots: ["fWash"], asserted_at_scope: ["fWash"]
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

const washPolicy = {
  contract: "source-semantic-correspondence-generation-policy-v1" as const,
  kind: "branch_demand" as const, alternative: 0, target: { kind: "evidence" as const, input: 0 }
};
const mendPolicy = {
  contract: "source-semantic-correspondence-generation-policy-v1" as const,
  kind: "branch_demand" as const, alternative: 0, target: { kind: "evidence" as const, input: 1 }
};

function assessmentBody(handles: readonly string[], frameHandle: string, excerpt: string) {
  const predicate = handles.find((_, index) => index === 1) ?? handles[0]!;
  return {
    contract: "source-semantic-correspondence-assessment-v1" as const,
    source_interpretation_handle: "source1",
    assessments: handles.map((handle) => handle === predicate
      ? { query: handle, status: "supported" as const, equivalents: [{
        source: frameHandle, query_excerpt: excerpt, source_semantic_support: [], grounding: "Local frame."
      }] }
      : { query: handle, status: "unresolved" as const, query_excerpt: "Maya", explanation: "Open." })
  };
}

function flatAssessment(handles: readonly string[], frameHandle: string, excerpt: string) {
  return { decision: "assess", assessments: assessmentBody(handles, frameHandle, excerpt).assessments };
}

describe("source semantic correspondence branch demand", () => {
  it("keeps omitted generation_policy on the v7 full-catalog request and serializes v9 only for branch demand", () => {
    const prepared = input();
    const full = buildSourceSemanticCorrespondenceRequest(prepared);
    const explicitFull = buildSourceSemanticCorrespondenceRequest({
      ...prepared, generation_policy: { contract: "source-semantic-correspondence-generation-policy-v1", kind: "full_catalog" }
    });
    const wash = buildSourceSemanticCorrespondenceRequest({ ...prepared, generation_policy: washPolicy });
    expect(full.contract).toBe(SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_REQUEST_CONTRACT);
    expect(explicitFull.contract).toBe(SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_REQUEST_CONTRACT);
    expect(full.generation_policy).toBeUndefined();
    expect(full.demand).toBeUndefined();
    expect(JSON.stringify(full)).not.toContain("generation_policy");
    expect(JSON.stringify(full)).not.toContain("branch_demand");
    expect(JSON.stringify(explicitFull)).toBe(JSON.stringify(full));
    expect(wash.contract).toBe(SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_REQUEST_CONTRACT);
    expect(wash.generation_policy).toEqual(washPolicy);
    expect(wash.demand?.demanded_handles).toHaveLength(4);
    expect(wash.catalog.query_endpoints).toHaveLength(7);
    expect(sourceSemanticCorrespondenceSystemPrompt(full)).toBe(SOURCE_SEMANTIC_CORRESPONDENCE_SYSTEM_PROMPT);
    expect(sourceSemanticCorrespondenceSystemPrompt(wash)).toContain("demanded query endpoint");
    expect(sourceSemanticCorrespondenceSystemPrompt(wash)).not.toContain("Assess every advertised qeN exactly once");
    const mutating = { ...washPolicy, alternative: 0 };
    const copied = buildSourceSemanticCorrespondenceRequest({ ...prepared, generation_policy: mutating });
    mutating.alternative = 9;
    if (copied.generation_policy?.kind !== "branch_demand") throw new Error("expected captured branch demand");
    expect(copied.generation_policy.alternative).toBe(0);
    expect(wash.demand?.query_refs.frames).toEqual(["wash"]);
  });

  it("accepts flat drafts with identical canonical C and coverage to historical v6 receipts, rejects older responses on scoped, and leaves coverage off full", () => {
    const prepared = input();
    const washRequest = buildSourceSemanticCorrespondenceRequest({ ...prepared, generation_policy: washPolicy });
    const frame = washRequest.catalog.source_endpoints.find((row) => row.kind === "frame")!.handle;
    const washBody = assessmentBody(washRequest.demand!.demanded_handles, frame, "wash");
    const wash = proposeCorrespondenceSemantics({ ...prepared, generation_policy: washPolicy }, {
      rawJson: JSON.stringify(flatAssessment(washRequest.demand!.demanded_handles, frame, "wash"))
    });
    const historical = receiveCorrespondenceSemantics(JSON.stringify({
      contract: SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_GENERATION_RESPONSE_CONTRACT,
      outcome: { status: "interpreted" }, semantic_correspondence: washBody
    }), { ...washRequest, contract: SOURCE_SEMANTIC_CORRESPONDENCE_LEGACY_SCOPED_REQUEST_CONTRACT });
    expect(historical.outcome.status).toBe("interpreted");
    expect(wash.semantic_correspondence).toEqual(historical.semantic_correspondence);
    expect(wash.coverage).toEqual(historical.coverage);
    expect(wash.assessment?.contract).toBe("source-semantic-correspondence-assessment-v1");
    expect(wash.assessment?.source_interpretation_handle).toBe("source1");
    expect(wash.outcome.status).toBe("interpreted");
    expect(wash.coverage?.demanded).toEqual(washRequest.demand!.demanded_handles);
    expect(wash.coverage?.unassessed).toHaveLength(3);
    expect(wash.semantic_correspondence?.correspondences.length).toBeGreaterThan(0);
    const schema = JSON.stringify(sourceSemanticCorrespondenceResponseJsonSchema(washRequest));
    expect(schema).toContain('"decision"');
    expect(schema).not.toContain('"const":');
    expect(schema).toContain('"enum":["supported"]');
    expect(schema).not.toContain("source_interpretation_handle");
    expect(schema).not.toContain("source-semantic-correspondence-assessment-v1");
    for (const handle of washRequest.demand!.demanded_handles) expect(schema).toContain(handle);
    const v4 = proposeCorrespondenceSemantics({ ...prepared, generation_policy: washPolicy }, {
      rawJson: JSON.stringify({
        contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT,
        outcome: { status: "interpreted" }, semantic_correspondence: washBody
      })
    });
    expect(v4.outcome.status).toBe("invalid");
    expect(v4.coverage).toBeUndefined();
    const v5 = proposeCorrespondenceSemantics({ ...prepared, generation_policy: washPolicy }, {
      rawJson: JSON.stringify({
        contract: SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_RESPONSE_CONTRACT,
        outcome: { status: "interpreted" }, semantic_correspondence: washBody
      })
    });
    expect(v5.outcome.status).toBe("invalid");
    const full = proposeCorrespondenceSemantics(prepared, {
      rawJson: JSON.stringify({
        contract: SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_RESPONSE_CONTRACT,
        outcome: { status: "interpreted" },
        semantic_correspondence: assessmentBody(
          washRequest.catalog.query_endpoints.map((row) => row.handle), frame, "wash"
        )
      })
    });
    expect(full.outcome.status).toBe("interpreted");
    expect(full.coverage).toBeUndefined();
    const scopedOnFull = proposeCorrespondenceSemantics(prepared, {
      rawJson: JSON.stringify({
        contract: SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_GENERATION_RESPONSE_CONTRACT,
        outcome: { status: "interpreted" }, semantic_correspondence: washBody
      })
    });
    expect(scopedOnFull.outcome.status).toBe("invalid");
    const abstained = proposeCorrespondenceSemantics({ ...prepared, generation_policy: washPolicy }, {
      rawJson: JSON.stringify({ decision: "abstain", assessments: [] })
    });
    expect(abstained.outcome.status).toBe("abstained");
    expect(abstained.coverage).toBeUndefined();
  });

  it("does not let a wash cache entry satisfy full catalog or the mend demand", () => {
    const prepared = input();
    const washRequest = buildSourceSemanticCorrespondenceRequest({ ...prepared, generation_policy: washPolicy });
    const frame = washRequest.catalog.source_endpoints.find((row) => row.kind === "frame")!.handle;
    const washJson = JSON.stringify(flatAssessment(washRequest.demand!.demanded_handles, frame, "wash"));
    const mendRequest = buildSourceSemanticCorrespondenceRequest({ ...prepared, generation_policy: mendPolicy });
    const mendJson = JSON.stringify(flatAssessment(mendRequest.demand!.demanded_handles, frame, "mend"));
    const queryId = sourceSemanticQueryIdentity(prepared.admitted_query_semantics, semanticSha256);
    const sourceId = prepared.source_interpretation_descriptors[0]!.source_interpretation_id;
    let calls = 0;
    const branched = prepareSourceSemanticLibrary({
      ...prepared,
      correspondence_demand: { kind: "query_branches", maximum_demands_per_interpretation: 2 },
      correspondence_cap: 2,
      produce: (_descriptor, task) => {
        calls += 1;
        if (task?.generation_policy.kind === "branch_demand" && task.generation_policy.target.kind === "evidence"
          && task.generation_policy.target.input === 0) return { rawJson: washJson };
        return { rawJson: mendJson };
      }
    });
    expect(calls).toBe(2);
    expect(branched.semantic_correspondences).toHaveLength(2);
    expect(branched.outcomes.map((row) => row.generation_policy?.kind)).toEqual(["branch_demand", "branch_demand"]);
    const washKey = sourceSemanticLibraryCorrespondenceCacheKey(queryId, sourceId, washPolicy);
    const mendKey = sourceSemanticLibraryCorrespondenceCacheKey(queryId, sourceId, mendPolicy);
    const fullKey = sourceSemanticLibraryCorrespondenceCacheKey(queryId, sourceId);
    expect(washKey).not.toBe(fullKey);
    expect(washKey).not.toBe(mendKey);
    expect(branched.cache[fullKey]).toBeUndefined();
    expect(branched.cache[washKey]?.semantic_correspondence.correspondences.length).toBeGreaterThan(0);
    expect(branched.cache[washKey]?.coverage?.demanded).toEqual(washRequest.demand!.demanded_handles);
    expect(branched.outcomes[0]?.coverage?.demanded).toEqual(washRequest.demand!.demanded_handles);
    expect(branched.cache[mendKey]?.semantic_correspondence.correspondences.length).toBeGreaterThan(0);
    const live = { ...prepared };
    const mutated = prepareSourceSemanticLibrary({
      ...live,
      correspondence_demand: { kind: "query_branches", maximum_demands_per_interpretation: 1 },
      correspondence_cap: 1,
      produce: (descriptor) => {
        live.original_query = "changed";
        Reflect.set(descriptor, "source_interpretation_id", `sha256:${"0".repeat(64)}`);
        return { rawJson: washJson };
      }
    });
    expect(mutated.cache[washKey]?.semantic_correspondence.query_semantics_id).toBe(queryId);
    expect(mutated.semantic_correspondences[0]?.query_semantics_id).toBe(queryId);
    expect(mutated.semantic_correspondences[0]?.source_interpretation_id).toBe(sourceId);
    const failedThenUnattempted = prepareSourceSemanticLibrary({
      ...prepared,
      correspondence_demand: { kind: "query_branches", maximum_demands_per_interpretation: 2 },
      correspondence_cap: 2,
      produce: (_descriptor, task) => {
        if (task?.generation_policy.kind === "branch_demand" && task.generation_policy.target.kind === "evidence"
          && task.generation_policy.target.input === 0) throw new Error("transport down");
        return { rawJson: mendJson };
      }
    });
    expect(failedThenUnattempted.outcomes[0]?.status).toBe("failed");
    expect(failedThenUnattempted.outcomes[1]?.status).toBe("interpreted");
    const capped = prepareSourceSemanticLibrary({
      ...prepared,
      correspondence_demand: { kind: "query_branches", maximum_demands_per_interpretation: 2 },
      correspondence_cap: 1,
      produce: () => ({ rawJson: washJson })
    });
    expect(capped.outcomes[0]?.status).toBe("interpreted");
    expect(capped.outcomes[1]?.status).toBe("unattempted");
    expect(capped.outcomes[1]?.generation_policy).toEqual(mendPolicy);
    const second = interpretation();
    const twoHosts = prepareSourceSemanticLibrary({
      ...prepared,
      source_interpretation_descriptors: [
        prepared.source_interpretation_descriptors[0]!,
        { source_interpretation_id: sourceSemanticInterpretationIdentity(second, semanticSha256), interpretation: second }
      ],
      correspondence_demand: { kind: "query_branches", maximum_demands_per_interpretation: 2 },
      correspondence_cap: 1,
      produce: () => ({ rawJson: washJson })
    });
    expect(twoHosts.outcomes.map((row) => [row.status, row.generation_policy?.kind, row.generation_policy?.kind === "branch_demand" ? row.generation_policy.target : undefined])).toEqual([
      ["interpreted", "branch_demand", { kind: "evidence", input: 0 }],
      ["unattempted", "branch_demand", { kind: "evidence", input: 1 }],
      ["unattempted", "branch_demand", { kind: "evidence", input: 0 }],
      ["unattempted", "branch_demand", { kind: "evidence", input: 1 }]
    ]);
    const zero = prepareSourceSemanticLibrary({
      ...prepared,
      correspondence_demand: { kind: "query_branches", maximum_demands_per_interpretation: 2 },
      correspondence_cap: 0,
      produce: () => ({ rawJson: washJson })
    });
    expect(zero.semantic_correspondences).toEqual([]);
    expect(zero.outcomes.every((row) => row.status === "unattempted")).toBe(true);
    expect(zero.outcomes.map((row) => row.generation_policy)).toEqual([washPolicy, mendPolicy]);
    expect(() => prepareSourceSemanticLibrary({
      ...prepared, correspondence_demand: { kind: "query_branches", maximum_demands_per_interpretation: 2 },
      produce: () => ({ rawJson: washJson })
    })).toThrow(/must appear together/u);
    expect(() => prepareSourceSemanticLibrary({
      ...prepared, correspondence_cap: 1, produce: () => ({ rawJson: washJson })
    })).toThrow(/must appear together/u);
  });

  it("advertises exactly the shared eligible producer statuses through one mapped flat decision schema", () => {
    const request = buildSourceSemanticCorrespondenceRequest({ ...input(), generation_policy: washPolicy });
    const decisions = SourceSemanticCorrespondenceFlatDraftSchema.unwrap().shape.decision.options;
    const statusByDecision = { assess: "interpreted", abstain: "abstained" };
    expect(new Set(decisions.map(decision => statusByDecision[decision])))
      .toEqual(new Set(SOURCE_SEMANTIC_PRODUCER_OUTCOMES.correspondence));
    const generated = sourceSemanticCorrespondenceResponseJsonSchema(request) as {
      properties: { decision: { enum: string[] } }; anyOf: { properties: { decision: { enum: string[] } } }[]
    };
    expect(generated.properties.decision.enum).toEqual(decisions);
    expect(generated.anyOf.flatMap(branch => branch.properties.decision.enum)).toEqual(decisions);
  });

  it.each(["missing assessments", "null assessments", "null domains", "null membership", "empty supported",
    "missing demanded", "duplicate demanded", "extra undemanded", "predicate excerpt omitted", "unknown decision",
    "outer contract", "outcome wrapper", "inner contract", "source handle", "extra assessment field", "abstain payload"])(
    "rejects a flat draft with %s without canonical C or coverage", (condition) => {
      const prepared = { ...input(), generation_policy: washPolicy };
      const request = buildSourceSemanticCorrespondenceRequest(prepared);
      const frame = request.catalog.source_endpoints.find((row) => row.kind === "frame")!.handle;
      const flat = flatAssessment(request.demand!.demanded_handles, frame, "wash");
      const cases: Record<string, unknown> = {
        "missing assessments": { decision: "assess" }, "null assessments": { ...flat, assessments: null },
        "null domains": { ...flat, domains: null }, "null membership": { ...flat, membership_assumptions: null },
        "empty supported": { ...flat, assessments: flat.assessments.map(row => row.status === "supported" ? { ...row, equivalents: [] } : row) },
        "missing demanded": { ...flat, assessments: flat.assessments.slice(1) },
        "duplicate demanded": { ...flat, assessments: [...flat.assessments, flat.assessments[0]] },
        "extra undemanded": { ...flat, assessments: [...flat.assessments, { query: "qe5", status: "unresolved", query_excerpt: "mend", explanation: "Open." }] },
        "predicate excerpt omitted": { ...flat, assessments: flat.assessments.map(row => row.status === "supported"
          ? { ...row, equivalents: row.equivalents.map(({ query_excerpt: _quote, ...rest }) => rest) } : row) },
        "unknown decision": { ...flat, decision: "no_match" }, "outer contract": { ...flat, contract: "source-semantic-correspondence-response-v7" },
        "outcome wrapper": { ...flat, outcome: { status: "interpreted" } },
        "inner contract": { ...flat, contract: "source-semantic-correspondence-assessment-v1" },
        "source handle": { ...flat, source_interpretation_handle: "source1" },
        "extra assessment field": { ...flat, assessments: [{ ...flat.assessments[0], invented: true }, ...flat.assessments.slice(1)] },
        "abstain payload": { ...flat, decision: "abstain" }
      };
      const received = proposeCorrespondenceSemantics(prepared, { rawJson: JSON.stringify(cases[condition]) });
      expect(received.outcome.status).toBe("invalid");
      expect(received.semantic_correspondence).toBeUndefined();
      expect(received.coverage).toBeUndefined();
    });

  it("keeps optional absence, completes eligible excerpts, and binds original raw bytes and all host identities", () => {
    const prepared = { ...input(), generation_policy: washPolicy };
    const request = buildSourceSemanticCorrespondenceRequest(prepared);
    const frame = request.catalog.source_endpoints.find((row) => row.kind === "frame")!.handle;
    const flat = flatAssessment(request.demand!.demanded_handles, frame, "wash");
    const omitted = { ...flat, assessments: flat.assessments.map(row => {
      if (row.status === "supported") return row;
      const { query_excerpt: _quote, ...rest } = row;
      return rest;
    }) };
    const rawJson = ` \n${JSON.stringify(omitted, null, 2)}\n`;
    const received = proposeCorrespondenceSemantics(prepared, { rawJson });
    expect(received.outcome.status).toBe("interpreted");
    expect(received.rawJson).toBe(rawJson);
    expect(received.raw_response_id).toBe(`sha256:${semanticSha256(rawJson)}`);
    expect(received.assessment?.assessments.filter(row => row.status === "unresolved").map(row => row.query_excerpt))
      .toEqual(["Maya", "Maya", "things"]);
    expect(Object.hasOwn(received.assessment!, "domains")).toBe(false);
    expect(Object.hasOwn(received.assessment!, "membership_assumptions")).toBe(false);
    expect(received.semantic_correspondence).toMatchObject({
      source_interpretation_id: prepared.source_interpretation_descriptors[0]!.source_interpretation_id,
      query_semantics_id: sourceSemanticQueryIdentity(prepared.admitted_query_semantics, semanticSha256),
      producer_id: prepared.producer_id, producer_version: prepared.producer_version
    });
    const empty = proposeCorrespondenceSemantics(prepared, { rawJson: JSON.stringify({ ...flat, domains: [], membership_assumptions: [] }) });
    expect(empty.assessment?.domains).toEqual([]);
    expect(empty.assessment?.membership_assumptions).toEqual([]);
    const old = { ...request, contract: SOURCE_SEMANTIC_CORRESPONDENCE_LEGACY_SCOPED_REQUEST_CONTRACT };
    expect(receiveCorrespondenceSemantics(rawJson, old).outcome.status).toBe("invalid");
    expect(proposeCorrespondenceSemantics(prepared, { rawJson: JSON.stringify({
      contract: SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_GENERATION_RESPONSE_CONTRACT,
      outcome: { status: "interpreted" }, semantic_correspondence: assessmentBody(request.demand!.demanded_handles, frame, "wash")
    }) }).outcome.status).toBe("invalid");
    expect(sourceSemanticCorrespondenceResponseJsonSchema(old)).not.toEqual(sourceSemanticCorrespondenceResponseJsonSchema(request));
    expect(sourceSemanticCorrespondenceSystemPrompt(old)).not.toBe(sourceSemanticCorrespondenceSystemPrompt(request));
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(sourceSemanticCorrespondenceResponseJsonSchema(request));
    expect(validate(omitted)).toBe(true);
    expect(validate({ decision: "abstain", assessments: [] })).toBe(true);
    expect(validate({ ...omitted, source_interpretation_handle: "source1" })).toBe(false);
    expect(validate({ ...omitted, decision: "abstain" })).toBe(false);
    const exhausted = proposeCorrespondenceSemantics({ ...prepared, resource_limits: { work_units: 0, memory_bytes: 0 } }, { rawJson });
    expect(exhausted.outcome.status).toBe("resource_exhausted");
    expect(exhausted.semantic_correspondence).toBeUndefined();
  });

  it.each(["canonical correspondence row allocation", "coverage demanded entry"])(
    "preserves provenance and returns no partial result when the shared nonzero budget exhausts during %s", phase => {
      const prepared = { ...input(), generation_policy: washPolicy };
      const request = buildSourceSemanticCorrespondenceRequest(prepared);
      const frame = request.catalog.source_endpoints.find(row => row.kind === "frame")!.handle;
      const flat = flatAssessment(request.demand!.demanded_handles, frame, "wash");
      const rawJson = ` \n${JSON.stringify(flat, null, 2)}\n`;
      let workAtPhase: number | undefined;
      const charge = SourceSemanticResourceLedger.prototype.charge;
      const observer = vi.spyOn(SourceSemanticResourceLedger.prototype, "charge").mockImplementation(function (
        this: SourceSemanticResourceLedger, work, bytes, currentPhase = "preparation"
      ) {
        if (currentPhase === phase && workAtPhase === undefined) workAtPhase = this.spentWork;
        charge.call(this, work, bytes, currentPhase);
      });
      try { expect(proposeCorrespondenceSemantics(prepared, { rawJson }).outcome.status).toBe("interpreted"); }
      finally { observer.mockRestore(); }
      if (workAtPhase === undefined || workAtPhase === 0) throw new Error("expected a nonzero downstream budget");
      const resource_limits = { work_units: workAtPhase, memory_bytes: 20000000 };
      const limited = buildSourceSemanticCorrespondenceRequest({ ...prepared, resource_limits });
      // A real ledger with this same allowance can finish presentation before downstream receive exhausts.
      expect(() => materializeSourceSemanticCorrespondenceFlatDraft(flat, limited,
        new SourceSemanticResourceLedger(resource_limits))).not.toThrow();
      const reserve = vi.spyOn(SourceSemanticResourceLedger.prototype, "reserve");
      try {
        const received = receiveCorrespondenceSemantics(rawJson, limited);
        expect(reserve.mock.lastCall?.[2]).toBe(phase);
        expect(received.outcome).toEqual({ status: "resource_exhausted" });
        expect(received.semantic_correspondence).toBeUndefined();
        expect(received.assessment).toBeUndefined();
        expect(received.coverage).toBeUndefined();
        expect(received.rawJson).toBe(rawJson);
        expect(received.raw_response_id).toBe(`sha256:${semanticSha256(rawJson)}`);
      } finally { reserve.mockRestore(); }
    });

  it("accepts empty abstention arrays only, without a canonical C or successful coverage", () => {
    const prepared = { ...input(), generation_policy: washPolicy };
    for (const optional of [{}, { domains: [] }, { membership_assumptions: [] }, { domains: [], membership_assumptions: [] }]) {
      const received = proposeCorrespondenceSemantics(prepared, { rawJson: JSON.stringify({ decision: "abstain", assessments: [], ...optional }) });
      expect(received.outcome).toEqual({ status: "abstained" });
      expect(received.semantic_correspondence).toBeUndefined();
      expect(received.coverage).toBeUndefined();
    }
    for (const payload of [{}, { domains: null }, { membership_assumptions: null }, { reason: "uncertain" },
      { domains: [{ query_domain: "q", source_domain: "s", query_support: { kind: "query_text", excerpt: "Maya" }, source_semantic_support: [] }] },
      { membership_assumptions: [{ query_variable: "maya", source_domain: "s", restrictions: [], status: "member",
        query_support: { kind: "query_text", excerpt: "Maya" }, description: "Conditional" }] }]) {
      const raw = Object.keys(payload).length === 0 ? { decision: "abstain" } : { decision: "abstain", assessments: [], ...payload };
      expect(proposeCorrespondenceSemantics(prepared, { rawJson: JSON.stringify(raw) }).outcome.status).toBe("invalid");
    }
  });

  it("captures exactly one identity-validated H in v9 and preserves the historical multi-descriptor v8 bound", () => {
    const prepared = input();
    const doubled = { ...prepared, source_interpretation_descriptors: [...prepared.source_interpretation_descriptors, ...prepared.source_interpretation_descriptors] };
    expect(() => buildSourceSemanticCorrespondenceRequest({ ...doubled, generation_policy: washPolicy })).toThrow();
    const request = buildSourceSemanticCorrespondenceRequest({ ...prepared, generation_policy: washPolicy });
    const oldMulti = { ...buildSourceSemanticCorrespondenceRequest(doubled),
      contract: SOURCE_SEMANTIC_CORRESPONDENCE_LEGACY_SCOPED_REQUEST_CONTRACT,
      generation_policy: washPolicy, demand: request.demand };
    expect(parseSourceSemanticCorrespondenceRequest(oldMulti).source_interpretation_descriptors).toHaveLength(2);
    expect(() => parseSourceSemanticCorrespondenceRequest({ ...oldMulti, contract: request.contract })).toThrow();
    const mutated = structuredClone(request);
    Reflect.set(mutated.source_interpretation_descriptors[0]!, "source_interpretation_id", `sha256:${"0".repeat(64)}`);
    expect(() => receiveCorrespondenceSemantics('{"decision":"abstain","assessments":[]}', mutated)).toThrow(/identity/u);
    const recataloged = structuredClone(request);
    Reflect.set(recataloged.catalog.query_endpoints[0]!, "reading", "forged");
    expect(() => parseSourceSemanticCorrespondenceRequest(recataloged)).toThrow(/differs/u);
  });

  it("reports a local descriptor rejection without a producer attempt or transport outcome", () => {
    const prepared = input();
    prepared.source_interpretation_descriptors[0]!.source_interpretation_id = `sha256:${"0".repeat(64)}`;
    let calls = 0;
    const result = prepareSourceSemanticLibrary({ ...prepared,
      correspondence_demand: { kind: "query_branches", maximum_demands_per_interpretation: 2 },
      correspondence_cap: 1,
      produce: () => { calls++; return { status: "unattempted" }; }
    });
    expect(calls).toBe(0);
    expect(result.outcomes.map(row => row.status)).toEqual(["preparation_failed", "unattempted"]);
    expect(result.outcomes[0]?.outcome).toBeUndefined();
    expect(result.outcomes[0]?.coverage).toBeUndefined();
    expect(result.semantic_correspondences).toEqual([]);
    expect(result.cache).toEqual({});
  });
});
