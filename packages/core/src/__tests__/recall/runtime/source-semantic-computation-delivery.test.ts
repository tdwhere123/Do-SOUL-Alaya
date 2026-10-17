import { expect, it } from "vitest";
import { SourceSemanticReasoningResultSchema, sourceSemanticCorrespondenceIdentity,
  sourceSemanticQueryIdentity, type SourceSemanticQuery } from "@do-soul/alaya-protocol";
import { executeSourceSemanticInterpretation } from "../../../recall/runtime/source-semantic-reasoning.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { BUDGET, CLOCK, ORIGINAL, source, query, correspondenceFor } from "./source-semantic-proof-fixture.js";

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
type ExecutionInput = Parameters<typeof executeSourceSemanticInterpretation>[0];
const executeUnchecked = (input: unknown) => executeSourceSemanticInterpretation(input as ExecutionInput);

function fixture(groups = 1, large = false) {
  const interpretation = { ...source(), gaps: large ? Array.from({ length: 80 }, () => ({
    kind: "unsupported_meaning" as const, affected_ids: [], support: [], description: "未解释的附加语义。".repeat(110)
  })) : [] }, original = query();
  const frames = Array.from({ length: groups }, (_, index) => ({
    ...original.alternatives[0]!.frames[0]!, id: `qUse${index}`, variable: `use${index}`
  }));
  const semantics: SourceSemanticQuery = { ...original,
    requested_operation: { reading: "collect tools", support: { kind: "query_text", excerpt: "tools" } },
    variables: [...original.variables.filter(row => row.id !== "use"),
      ...frames.map(row => ({ id: row.variable, sort: "proposition" as const }))],
    alternatives: Array.from({ length: Math.ceil(groups / 16) }, (_, index) => {
      const groupFrames = frames.slice(index * 16, index * 16 + 16);
      return { frames: groupFrames, context_obligations: groupFrames.map(row => ({ frame: row.id, kind: "asserted_at_source" as const })),
        answer_frames: [], evidence_inputs: groupFrames.map(row => ({ frames: [row.id] })) };
    }),
    gaps: large ? Array.from({ length: 48 }, () => ({ kind: "aggregate" as const, affected_ids: ["tools"],
      support: [{ kind: "query_text" as const, excerpt: "tools" }], description: "未执行的查询条件。".repeat(110) })) : [] };
  const originalCorrespondence = correspondenceFor(interpretation, original);
  const correspondence = { ...originalCorrespondence, query_semantics_id: sourceSemanticQueryIdentity(semantics, fieldContractSha256),
    correspondences: originalCorrespondence.correspondences.flatMap(row => row.query_endpoint.kind === "referent" ? [row]
      : frames.map((frame, index) => ({ ...row, query_endpoint: { ...row.query_endpoint, alternative: Math.floor(index / 16), frame: frame.id } }))) };
  return {
    input: { source_interpretation: interpretation, query_semantics: semantics, semantic_correspondence: correspondence,
      workspaceId: "ws", scope: "project", authorizedScopes: ["project"], asOf: CLOCK },
    computation: { contract: "source-interpretation-reasoning-v5" as const, accepts_unreviewed_conditional_results: true as const,
      source_interpretation_id: correspondence.source_interpretation_id, query_semantics_id: correspondence.query_semantics_id,
      semantic_correspondence_id: sourceSemanticCorrespondenceIdentity(correspondence, fieldContractSha256),
      original_query: ORIGINAL, budget: BUDGET }
  };
}

it("rejects simultaneous delivery and computation inputs before executing either", () => {
  const { input, computation } = fixture();
  expect(() => executeUnchecked({ ...input, computation, request: { ...computation, output_byte_limit: 1024 } }))
    .toThrow("requires either a delivery request or computation input");
});

it("captures delivery and computation fields only once at the execution entry", () => {
  const { input, computation } = fixture();
  let requestReads = 0, computationReads = 0;
  const result = executeSourceSemanticInterpretation({ ...input,
    get request() { requestReads++; return undefined; },
    get computation() { computationReads++; return computation; }
  });
  expect(result.result.outcome.status).toBe("interpreted");
  expect([requestReads, computationReads]).toEqual([1, 1]);
});

it("strictly validates computation identity, conditional consent, original query and all budget constraints", () => {
  const { input, computation } = fixture();
  const missing = ["contract", "accepts_unreviewed_conditional_results", "source_interpretation_id", "query_semantics_id",
    "semantic_correspondence_id", "original_query", "budget"].map(key =>
    Object.fromEntries(Object.entries(computation).filter(([name]) => name !== key)));
  const malformed = [
    ...missing, { ...computation, output_byte_limit: 1_000_000 }, { ...computation, unexpected: true },
    { ...computation, accepts_unreviewed_conditional_results: false }, { ...computation, original_query: "" },
    ...["source_interpretation_id", "query_semantics_id", "semantic_correspondence_id"].map(key => ({ ...computation, [key]: "unbound" })),
    ...["schema_version", "work_units", "memory_bytes", "page_budget", "finalization_reserve", "min_envelope"].map(key => ({
      ...computation, budget: { ...BUDGET, [key]: -1 }
    })),
    { ...computation, budget: { ...BUDGET, work_units: 0.5 } },
    { ...computation, budget: { ...BUDGET, unexpected: 1 } }
  ];
  for (const invalid of malformed) {
    expect(() => executeUnchecked({ ...input, computation: invalid })).toThrow();
  }
});

it("keeps identity, trusted scope and real resource admission active for computation-only execution", () => {
  const { input, computation } = fixture();
  for (const key of ["source_interpretation_id", "query_semantics_id", "semantic_correspondence_id"] as const) {
    expect(executeSourceSemanticInterpretation({ ...input, computation: { ...computation, [key]: `sha256:${"0".repeat(64)}` } }).result)
      .toMatchObject({ outcome: { status: "invalid", reason: "identity_mismatch" }, consumed_leaves: [] });
  }
  expect(executeSourceSemanticInterpretation({ ...input, computation, authorizedScopes: [] }).result)
    .toMatchObject({ outcome: { status: "invalid", reason: "unauthorized_scope" }, consumed_leaves: [] });
  expect(executeSourceSemanticInterpretation({ ...input, computation: { ...computation,
    budget: { ...BUDGET, work_units: 1, memory_bytes: 1, finalization_reserve: 0, min_envelope: 0 } } }).result)
    .toMatchObject({ outcome: { status: "resource_exhausted" }, consumed_leaves: [] });
});

it("preserves explicit v5 full, attention-only omission and truncated delivery behavior", () => {
  const { input, computation } = fixture();
  const full = executeSourceSemanticInterpretation({ ...input, request: { ...computation, output_byte_limit: 1_000_000 } });
  expect(full.result.outcome.status).toBe("interpreted");
  expect(full.result.attention).toBeDefined();
  const { attention: _attention, ...required } = full.result;
  const omitted = executeSourceSemanticInterpretation({ ...input, request: { ...computation, output_byte_limit: bytes(required) } });
  expect(omitted.result).toEqual(required);
  expect(omitted.index).toEqual(full.index);
  expect(omitted.source_dependencies).toEqual(full.source_dependencies);
  const truncated = executeSourceSemanticInterpretation({ ...input, request: { ...computation, output_byte_limit: 1024 } });
  expect(truncated.result).toMatchObject({ outcome: { status: "truncated" }, consumed_leaves: [],
    source_interpretation_id: computation.source_interpretation_id, query_semantics_id: computation.query_semantics_id,
    semantic_correspondence_id: computation.semantic_correspondence_id,
    semantic_status: "unreviewed", conclusion_scope: "conditional_on_interpretation", world_claim: "unknown" });
  expect(bytes(truncated.result)).toBeLessThanOrEqual(1024);
  expect(truncated.index).toBeNull();
  expect(truncated.source_dependencies).toBeUndefined();
  expect(truncated.result).not.toHaveProperty("binding_results");
  for (const output_byte_limit of [1023, 1_000_001]) {
    expect(() => executeSourceSemanticInterpretation({ ...input, request: { ...computation, output_byte_limit } })).toThrow();
  }
});

it("retains a valid computed result beyond one megabyte while explicit delivery remains capped", () => {
  const { input, computation } = fixture(28, true);
  const full = executeSourceSemanticInterpretation({ ...input, computation });
  expect(bytes(full.result)).toBeGreaterThan(1_000_000);
  expect(SourceSemanticReasoningResultSchema.safeParse(full.result).success).toBe(true);
  expect(full.result.outcome).toEqual({ status: "interpreted", gaps: input.source_interpretation.gaps });
  expect(full.result.query_gaps).toEqual(input.query_semantics.gaps);
  expect(full.result.binding_results).toHaveLength(28);
  expect(full.result.derivations).toHaveLength(980);
  expect(full.result.consumed_leaves.length).toBeGreaterThan(0);
  expect(full.result.evidence_leaves!.length).toBeGreaterThan(0);
  expect(full.source_dependencies!.length).toBeGreaterThan(0);
  expect(full.index?.entries).toHaveLength(28);
  const capped = executeSourceSemanticInterpretation({ ...input, request: { ...computation, output_byte_limit: 1_000_000 } });
  expect(capped.result.outcome.status).toBe("truncated");
  expect(capped.index).toBeNull();
  expect(bytes(capped.result)).toBeLessThanOrEqual(1_000_000);
}, 30_000);

it("fails closed on actual merged derivation schema overflow instead of erasing completed proof as resource exhaustion", () => {
  const { input, computation } = fixture(29);
  for (const mode of [{ computation }, { request: { ...computation, output_byte_limit: 1_000_000 } }]) {
    let failure: unknown;
    try { executeSourceSemanticInterpretation({ ...input, ...mode }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ name: "ZodError", issues: expect.arrayContaining([
      expect.objectContaining({ code: "too_big", path: ["derivations"], maximum: 1000 })
    ]) });
  }
}, 30_000);
