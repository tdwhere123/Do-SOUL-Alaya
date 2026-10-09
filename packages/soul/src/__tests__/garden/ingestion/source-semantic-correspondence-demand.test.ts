import { describe, expect, it } from "vitest";
import {
  SOURCE_SEMANTIC_K_VERSION, SOURCE_SEMANTIC_NORMALIZER_VERSION,
  SourceSemanticInterpretationSchema, SourceSemanticQuerySchema,
  sourceSemanticInterpretationIdentity, sourceSemanticQueryIdentity, UNKNOWN_UTTERANCE_ATTRIBUTION
} from "@do-soul/alaya-protocol";
import {
  SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_REQUEST_CONTRACT,
  SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT,
  SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_REQUEST_CONTRACT,
  SOURCE_SEMANTIC_CORRESPONDENCE_SYSTEM_PROMPT,
  buildSourceSemanticCorrespondenceRequest, semanticSha256, sourceSemanticCorrespondenceResponseJsonSchema,
  sourceSemanticCorrespondenceSystemPrompt
} from "../../../garden/ingestion/official-api/source-semantic-request.js";
import { proposeCorrespondenceSemantics } from "../../../garden/ingestion/official-api/source-semantic-receive.js";
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

describe("source semantic correspondence branch demand", () => {
  it("keeps omitted generation_policy on the v7 full-catalog request and serializes v8 only for branch demand", () => {
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

  it("accepts independent wash and mend v6 receipts, rejects v4 on scoped, and leaves coverage off the full path", () => {
    const prepared = input();
    const washRequest = buildSourceSemanticCorrespondenceRequest({ ...prepared, generation_policy: washPolicy });
    const frame = washRequest.catalog.source_endpoints.find((row) => row.kind === "frame")!.handle;
    const washBody = assessmentBody(washRequest.demand!.demanded_handles, frame, "wash");
    const wash = proposeCorrespondenceSemantics({ ...prepared, generation_policy: washPolicy }, {
      rawJson: JSON.stringify({
        contract: SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_GENERATION_RESPONSE_CONTRACT,
        outcome: { status: "interpreted" }, semantic_correspondence: washBody
      })
    });
    expect(wash.outcome.status).toBe("interpreted");
    expect(wash.coverage?.demanded).toEqual(washRequest.demand!.demanded_handles);
    expect(wash.coverage?.unassessed).toHaveLength(3);
    expect(wash.semantic_correspondence?.correspondences.length).toBeGreaterThan(0);
    const schema = JSON.stringify(sourceSemanticCorrespondenceResponseJsonSchema(washRequest));
    expect(schema).toContain(SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_GENERATION_RESPONSE_CONTRACT);
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
      rawJson: JSON.stringify({
        contract: SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_GENERATION_RESPONSE_CONTRACT,
        outcome: { status: "abstained" }
      })
    });
    expect(abstained.outcome.status).toBe("abstained");
    expect(abstained.coverage).toBeUndefined();
  });

  it("does not let a wash cache entry satisfy full catalog or the mend demand", () => {
    const prepared = input();
    const washRequest = buildSourceSemanticCorrespondenceRequest({ ...prepared, generation_policy: washPolicy });
    const frame = washRequest.catalog.source_endpoints.find((row) => row.kind === "frame")!.handle;
    const washJson = JSON.stringify({
      contract: SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_GENERATION_RESPONSE_CONTRACT,
      outcome: { status: "interpreted" },
      semantic_correspondence: assessmentBody(washRequest.demand!.demanded_handles, frame, "wash")
    });
    const mendRequest = buildSourceSemanticCorrespondenceRequest({ ...prepared, generation_policy: mendPolicy });
    const mendJson = JSON.stringify({
      contract: SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_GENERATION_RESPONSE_CONTRACT,
      outcome: { status: "interpreted" },
      semantic_correspondence: assessmentBody(mendRequest.demand!.demanded_handles, frame, "mend")
    });
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
