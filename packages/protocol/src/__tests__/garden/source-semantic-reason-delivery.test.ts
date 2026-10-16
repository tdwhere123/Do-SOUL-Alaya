import { expect, it } from "vitest";
import { encodeSourceDisclosure } from "../../recall/source-disclosure.js";
import { UNKNOWN_UTTERANCE_ATTRIBUTION } from "../../conversation/utterance-attribution.js";
import { SourceSemanticQuerySchema } from "../../recall/conditional-field/semantic-query.js";
import { sourceSemanticExecution } from "../../garden/source-semantic-access.js";
import {
  SourceSemanticUndeliveredConclusionSchema, sourceSemanticReasonControl, sourceSemanticUndeliveredConclusion
} from "../../garden/source-semantic-reason-delivery.js";
import { SourceSemanticReasoningResultSchema } from "../../garden/source-semantic-interpretation.js";
import { SoulInterpretationReasonResponseSchema, SoulInterpretationResponseSchema } from "../../surfaces/mcp-interpretation-types.js";
import { SourceSemanticWorkerResultSchema } from "../../garden/source-semantic-worker.js";

const digest = `sha256:${"a".repeat(64)}`;
const other = `sha256:${"b".repeat(64)}`;
const coverage = {
  discovery: "complete" as const, source_interpretation: "complete" as const,
  query_semantics: "complete" as const, semantic_correspondence: "complete" as const,
  conditional_computation: "complete" as const, payload: "truncated" as const
};
const work = { native_work: 1, native_bytes: 2, logical_memory_bytes: 3, rss_bytes: 4 };
const disclosure = encodeSourceDisclosure({ material_kind: "interpretation", source_binding: "unbound",
  evaluated_as_of: "2026-09-25T00:00:00Z", validity: { kind: "unknown", reason: "unbound" },
  temporal_state: "unknown", proof_use: { kind: "source_only", qualification: "not_current_proof" } });
const queryGaps = [{ kind: "disconnected_query" as const, affected_ids: ["actor"],
  support: [{ kind: "query_text" as const, excerpt: "Alice" }] }];
const attention = {
  contract: "source-semantic-attention-v1" as const, kind: "computed" as const,
  conditional_computation_id: digest, source_interpretation_id: digest, query_semantics_id: digest,
  semantic_correspondence_id: other, source_id: "src", source_version: "v1", content_digest: digest,
  entries: [], truncated: false
};
const query = SourceSemanticQuerySchema.parse({
  contract: "source-semantic-query-v4", original_query_digest: digest,
  approved_fixed_context: null, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
  producer_id: "qp", producer_version: "1", contract_version: "source-semantic-query-v4",
  variables: [{ id: "actor", sort: "entity" }, { id: "fUse", sort: "proposition" }],
  alternatives: [{ frames: [{ id: "qUse", variable: "fUse", predicate_reading: "use",
    role_requirements: [{ id: "agent", role_reading: "agent", target_variable: "actor",
      support: { kind: "query_text", excerpt: "Alice" } }] }],
  context_obligations: [{ frame: "qUse", kind: "asserted_at_source" }] }],
  return_variables: ["actor"], gaps: []
});

function reasoningResult(overrides: Record<string, unknown> = {}) {
  return SourceSemanticReasoningResultSchema.parse({
    contract: "source-interpretation-reasoning-v5",
    outcome: { status: "preparation_required", missing: "query_semantics_and_correspondence" },
    source_interpretation_id: digest, query_semantics_id: digest, semantic_correspondence_id: other,
    conditional_computation_id: digest, consumed_leaves: [], query_gaps: queryGaps, attention,
    semantic_status: "unreviewed", conclusion_scope: "conditional_on_interpretation", world_claim: "unknown",
    ...overrides
  });
}

function parseRejected(schema: { safeParse(value: unknown): { success: boolean; error?: { issues: { message: string }[] } } },
  value: unknown) {
  const parsed = schema.safeParse(value);
  expect(parsed.success).toBe(false);
  return parsed.success ? [] : parsed.error!.issues.map(issue => issue.message);
}

it("preserves intact outcome restrictions, identities, and query gaps on a no_conclusion tuple", () => {
  const result = reasoningResult();
  const receipt = sourceSemanticUndeliveredConclusion(result);
  expect(receipt.no_conclusion[0]).toEqual({
    status: "preparation_required", missing: "query_semantics_and_correspondence"
  });
  expect(receipt.no_conclusion[1]).toEqual([digest, digest, other, digest]);
  expect(receipt.no_conclusion[2]).toEqual(queryGaps);
  const interpreted = sourceSemanticUndeliveredConclusion(reasoningResult({
    outcome: { status: "interpreted", gaps: [{ kind: "unresolved_referent", affected_ids: ["actor"], support: [] }] },
    semantic_correspondence_id: undefined, query_gaps: undefined, attention: undefined
  }));
  expect(interpreted.no_conclusion[0]).toEqual({
    status: "interpreted", gaps: [{ kind: "unresolved_referent", affected_ids: ["actor"], support: [] }]
  });
  expect(interpreted.no_conclusion[1]).toEqual([digest, digest, null, digest]);
  expect(interpreted.no_conclusion).toHaveLength(2);
  const eligible = sourceSemanticUndeliveredConclusion(reasoningResult({
    outcome: { status: "no_eligible_source", provider_attempts: 0 }, query_gaps: [], attention: undefined
  }));
  expect(eligible.no_conclusion[0]).toEqual({ status: "no_eligible_source", provider_attempts: 0 });
  expect(eligible.no_conclusion[2]).toEqual([]);
  expect(SourceSemanticUndeliveredConclusionSchema.safeParse({
    no_conclusion: [{ status: "preparation_required" }, [null, null, null, null]]
  }).success).toBe(false);
  expect(SourceSemanticUndeliveredConclusionSchema.safeParse({
    no_conclusion: [{ status: "no_eligible_source" }, [null, null, null, null]]
  }).success).toBe(false);
  expect(SourceSemanticUndeliveredConclusionSchema.safeParse({
    no_conclusion: [{ status: "truncated", reason: "clipped" }, [null, null, null, null]]
  }).success).toBe(false);
});

it("does not fabricate attention when recovering an undelivered conclusion", () => {
  const receipt = sourceSemanticUndeliveredConclusion(reasoningResult());
  const control = sourceSemanticReasonControl(receipt);
  expect(control.outcome).toEqual({
    status: "preparation_required", missing: "query_semantics_and_correspondence"
  });
  expect(control.source_interpretation_id).toBe(digest);
  expect(control.query_semantics_id).toBe(digest);
  expect(control.semantic_correspondence_id).toBe(other);
  expect(control.conditional_computation_id).toBe(digest);
  expect(control.query_gaps).toEqual(queryGaps);
  expect(control).not.toHaveProperty("attention");
  expect(control).not.toHaveProperty("source_target");
  expect(sourceSemanticReasonControl({ ...receipt, attention })).not.toHaveProperty("attention");
});

it("rejects mixed full and compact result or premises at native and public reason boundaries", () => {
  const result = reasoningResult();
  const receipt = sourceSemanticUndeliveredConclusion(result);
  const mixed = { kind: "reason" as const, result, no_conclusion: receipt.no_conclusion, source_disclosure: disclosure,
    coverage, work };
  expect(parseRejected(SourceSemanticWorkerResultSchema, mixed)
    .some(message => /cannot also carry an undelivered conclusion/u.test(message))).toBe(true);
  expect(parseRejected(SoulInterpretationReasonResponseSchema, {
    operation: "reason", result, no_conclusion: receipt.no_conclusion, source_disclosure: disclosure,
    coverage, work, execution: sourceSemanticExecution()
  }).some(message => /cannot also carry an undelivered conclusion/u.test(message))).toBe(true);
  const withPremise = { kind: "reason" as const, no_conclusion: receipt.no_conclusion, query,
    source_disclosure: disclosure, coverage, work };
  expect(parseRejected(SourceSemanticWorkerResultSchema, withPremise)
    .some(message => /cannot carry premises/u.test(message))).toBe(true);
  expect(parseRejected(SoulInterpretationReasonResponseSchema, {
    operation: "reason", no_conclusion: receipt.no_conclusion, query, source_disclosure: disclosure,
    coverage, work, execution: sourceSemanticExecution()
  }).some(message => /cannot carry premises/u.test(message))).toBe(true);
  expect(() => sourceSemanticReasonControl({ result, no_conclusion: receipt.no_conclusion })).toThrow();
});

it("rejects missing disclosure at native and public reason boundaries, missing public execution, and historic v1", () => {
  const result = reasoningResult({ attention: undefined });
  const native = { kind: "reason" as const, result, coverage, work };
  expect(SourceSemanticWorkerResultSchema.safeParse(native).success).toBe(false);
  expect(SourceSemanticWorkerResultSchema.safeParse({ ...native, source_disclosure: disclosure }).success).toBe(true);
  expect(parseRejected(SoulInterpretationReasonResponseSchema, {
    operation: "reason", result, coverage, work, execution: sourceSemanticExecution()
  }).some(message => /requires disclosure/u.test(message))).toBe(true);
  expect(SoulInterpretationReasonResponseSchema.safeParse({
    operation: "reason", result, source_disclosure: disclosure, coverage, work
  }).success).toBe(false);
  expect(SoulInterpretationResponseSchema.safeParse({
    operation: "reason", result, source_disclosure: disclosure, coverage, work
  }).success).toBe(false);
  expect(parseRejected(SoulInterpretationReasonResponseSchema, {
    operation: "reason", result, source_disclosure: disclosure, coverage, work,
    execution: { contract: "source-semantic-execution-v1" }
  }).length).toBeGreaterThan(0);
});

it("roundtrips a full reason result and premises without compacting them", () => {
  const result = reasoningResult();
  const native = SourceSemanticWorkerResultSchema.parse({
    kind: "reason", result, query, source_disclosure: disclosure, coverage, work,
    execution: sourceSemanticExecution()
  });
  if (native.kind !== "reason") throw new Error("expected a reasoning result");
  expect(native.result).toEqual(result);
  expect(native.query).toEqual(query);
  expect(native.no_conclusion).toBeUndefined();
  expect(sourceSemanticReasonControl(native)).toEqual(result);
  const published = SoulInterpretationReasonResponseSchema.parse({
    operation: "reason", result, query, source_disclosure: disclosure, coverage, work,
    execution: sourceSemanticExecution()
  });
  expect(published.result).toEqual(result);
  expect(published.query).toEqual(query);
  expect(published.execution).toBe("native_reasoning_only");
  expect(sourceSemanticReasonControl(published)).toEqual(result);
  const compact = SourceSemanticWorkerResultSchema.parse({
    kind: "reason", no_conclusion: sourceSemanticUndeliveredConclusion(result).no_conclusion,
    source_disclosure: disclosure, coverage, work
  });
  if (compact.kind !== "reason") throw new Error("expected a reasoning result");
  expect(compact.result).toBeUndefined();
  expect(compact.query).toBeUndefined();
  expect(sourceSemanticReasonControl(compact)).not.toHaveProperty("attention");
});
