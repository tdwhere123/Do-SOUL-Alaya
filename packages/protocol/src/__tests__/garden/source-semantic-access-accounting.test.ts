import { expect, it } from "vitest";
import {
  SourceSemanticAccessReceiptSchema, SourceSemanticAcquisitionPhaseSchema, SourceSemanticAcquisitionSchema,
  SourceSemanticExecutionSchema, isNativeReasoningOnlyExecution, sourceSemanticAcquisitionNotRun,
  sourceSemanticExecution, sourceSemanticExecutionPhases, unavailableSourceQueryPreparation,
  type SourceSemanticExecution
} from "../../garden/source-semantic-access.js";
import { SoulInterpretationPrepareQueryResponseSchema, SoulInterpretationResponseSchema } from "../../surfaces/mcp-interpretation-types.js";

const digest = `sha256:${"a".repeat(64)}`;
const coverage = {
  discovery: "complete" as const, source_interpretation: "unexercised" as const,
  query_semantics: "unexercised" as const, semantic_correspondence: "unexercised" as const,
  conditional_computation: "unexercised" as const, payload: "complete" as const
};
const work = { native_work: 0, native_bytes: 0, logical_memory_bytes: 0, rss_bytes: 0 };
const phaseAccounting = {
  observation: null,
  completion: "included_in_worker_work_not_separately_measured" as const,
  native_cpu: "unknown" as const, deadline: "soft_quarantine_until_exit" as const
};

function accessV2(overrides: Record<string, unknown> = {}) {
  return {
    contract: "source-semantic-access-v2" as const,
    preparation: unavailableSourceQueryPreparation("controlled_or_scoped_access", "not_requested"),
    acquisition: sourceSemanticAcquisitionNotRun("controlled_or_scoped_access"),
    phase_accounting: phaseAccounting,
    policy: "canonical-v1" as const, input_id: digest, pool_id: digest,
    observed_source_count: 2, observed_interpretation_count: 0,
    source_candidates: [{ source_id: "source-2", record_id: digest, read_bytes: 1, body_bytes: 1,
      complete: true, signal: { source_text_score: null, interpretation_reading_score: 0 } }],
    interpretation_candidates: [], unvisited_sources: false, unvisited_interpretations: false,
    stopping_reasons: [], trace: { kind: "preparation_page" as const, source_offset: 1, interpretation_offset: 0,
      omitted_source_count: 1, omitted_interpretation_count: 0 },
    ...overrides
  };
}

function historicV1() {
  const { preparation: _preparation, acquisition: _acquisition, phase_accounting: _phases, ...rest } = accessV2();
  return { ...rest, contract: "source-semantic-access-v1" as const };
}

function publicPrepare(overrides: Record<string, unknown> = {}) {
  return {
    operation: "prepare_query" as const, query_semantics_status: { status: "unavailable" as const, reason: "absent" as const },
    candidates: [], truncated: false, coverage, work, execution: sourceSemanticExecution(),
    ...overrides
  };
}

function parseRejected(schema: { safeParse(value: unknown): { success: boolean; error?: { issues: { message: string }[] } } },
  value: unknown) {
  const parsed = schema.safeParse(value);
  expect(parsed.success).toBe(false);
  return parsed.success ? [] : parsed.error!.issues.map(issue => issue.message);
}

it("rejects historic access v1 through the live receipt and public prepare consumers", () => {
  const historic = historicV1();
  const receiptMessages = parseRejected(SourceSemanticAccessReceiptSchema, historic);
  expect(receiptMessages.some(message => /Historic Source access v1 is unsupported/u.test(message))).toBe(true);
  expect(SoulInterpretationPrepareQueryResponseSchema.safeParse(publicPrepare({ access: historic })).success).toBe(false);
  expect(SoulInterpretationResponseSchema.safeParse(publicPrepare({ access: historic })).success).toBe(false);
  expect(SourceSemanticAccessReceiptSchema.safeParse({ ...historic, contract: "source-semantic-access-v2" }).success)
    .toBe(false);
  expect(SourceSemanticAccessReceiptSchema.safeParse(accessV2()).success).toBe(true);
  expect(SoulInterpretationPrepareQueryResponseSchema.safeParse(publicPrepare({ access: accessV2() })).success).toBe(true);
});

it("rejects missing acquisition or execution instead of defaulting them to success or absence", () => {
  const access = accessV2();
  const { acquisition: _acquisition, ...withoutAcquisition } = access;
  const { preparation: _preparation, ...withoutPreparation } = access;
  const { phase_accounting: _phases, ...withoutPhases } = access;
  expect(SourceSemanticAccessReceiptSchema.safeParse(withoutAcquisition).success).toBe(false);
  expect(SourceSemanticAccessReceiptSchema.safeParse(withoutPreparation).success).toBe(false);
  expect(SourceSemanticAccessReceiptSchema.safeParse(withoutPhases).success).toBe(false);
  expect(SoulInterpretationPrepareQueryResponseSchema.safeParse(publicPrepare({ access: withoutAcquisition })).success)
    .toBe(false);
  const { execution: _execution, ...withoutExecution } = publicPrepare({ access });
  expect(SoulInterpretationPrepareQueryResponseSchema.safeParse(withoutExecution).success).toBe(false);
  expect(SoulInterpretationResponseSchema.safeParse(withoutExecution).success).toBe(false);
  expect(SourceSemanticExecutionSchema.safeParse({
    contract: "source-semantic-execution-v2",
    acquisition: sourceSemanticAcquisitionNotRun("operation_does_not_acquire"),
    semantic_generation_attempts: 0
  }).success).toBe(false);
});

function expandedExecution(execution: SourceSemanticExecution) {
  expect(execution).not.toBe("native_reasoning_only");
  if (execution === "native_reasoning_only") throw new Error("expected expanded execution");
  return execution;
}

it("compacts only exact canonical not-run execution to native_reasoning_only", () => {
  expect(sourceSemanticExecution()).toBe("native_reasoning_only");
  expect(SourceSemanticExecutionSchema.parse("native_reasoning_only")).toBe("native_reasoning_only");
  expect(isNativeReasoningOnlyExecution(sourceSemanticExecution())).toBe(true);
  const phases = sourceSemanticExecutionPhases("native_reasoning_only");
  expect(isNativeReasoningOnlyExecution(phases)).toBe(true);
  expect(sourceSemanticExecution(phases.query_preparation, phases.acquisition)).toBe("native_reasoning_only");
  expect(SourceSemanticExecutionSchema.parse(phases)).toEqual(phases);
  expect(phases.semantic_generation_attempts).toBe(0);
  expect(phases.query_preparation).toEqual(unavailableSourceQueryPreparation("operation_does_not_prepare", "not_requested"));
  expect(phases.acquisition).toEqual(sourceSemanticAcquisitionNotRun("operation_does_not_acquire"));
  expect(SourceSemanticExecutionSchema.safeParse({ contract: "source-semantic-execution-v1" }).success).toBe(false);
  expect(SoulInterpretationPrepareQueryResponseSchema.parse(publicPrepare()).execution).toBe("native_reasoning_only");
});

it("keeps reason-bearing not-run, failures, nonzero resources, and unknown attempts expanded", () => {
  const phases = sourceSemanticExecutionPhases("native_reasoning_only");
  const reasonBearing = expandedExecution(sourceSemanticExecution(
    unavailableSourceQueryPreparation("attestation_missing", "not_requested")));
  expect(isNativeReasoningOnlyExecution(reasonBearing)).toBe(false);
  expect(reasonBearing.query_preparation.reason).toBe("attestation_missing");
  expect(reasonBearing.query_preparation.external_api_attempts).toBe(0);
  const failed = expandedExecution(sourceSemanticExecution(phases.query_preparation, {
    ...sourceSemanticAcquisitionNotRun("operation_does_not_acquire"), status: "failed",
    reason: "index_unavailable", accounting: "partial"
  }));
  expect(failed.acquisition.status).toBe("failed");
  expect(failed.acquisition.accounting).toBe("partial");
  expect(failed.acquisition.budget).toEqual({ work_units: 0, memory_bytes: 0 });
  const nonzero = expandedExecution(sourceSemanticExecution(phases.query_preparation, {
    ...sourceSemanticAcquisitionNotRun("operation_does_not_acquire"),
    budget: { work_units: 4, memory_bytes: 8 }
  }));
  expect(nonzero.acquisition.status).toBe("not_run");
  expect(nonzero.acquisition.budget).toEqual({ work_units: 4, memory_bytes: 8 });
  expect(sourceSemanticExecutionPhases(nonzero).acquisition.budget.work_units).toBe(4);
  const unknownAttempts = expandedExecution(sourceSemanticExecution({
    ...phases.query_preparation, external_api_attempts: null
  }));
  expect(unknownAttempts.query_preparation.external_api_attempts).toBeNull();
  expect(sourceSemanticExecutionPhases(unknownAttempts).query_preparation.external_api_attempts).toBeNull();
  expect(sourceSemanticExecution(unknownAttempts.query_preparation, unknownAttempts.acquisition))
    .not.toBe("native_reasoning_only");
});

it("derives canonical external attempts without rewriting unknown to zero", () => {
  expect(sourceSemanticExecutionPhases("native_reasoning_only").query_preparation.external_api_attempts).toBe(0);
  const unknown = expandedExecution(SourceSemanticExecutionSchema.parse({
    ...sourceSemanticExecutionPhases("native_reasoning_only"),
    query_preparation: { ...sourceSemanticExecutionPhases("native_reasoning_only").query_preparation,
      external_api_attempts: null }
  }));
  expect(unknown.query_preparation.external_api_attempts).toBeNull();
  expect(sourceSemanticExecution(unknown.query_preparation)).not.toBe("native_reasoning_only");
  expect("provider_attempts" in SoulInterpretationPrepareQueryResponseSchema.parse(publicPrepare())).toBe(false);
  expect(SoulInterpretationPrepareQueryResponseSchema.safeParse(publicPrepare({ provider_attempts: 0 })).success)
    .toBe(false);
});

it("preserves unknown versus zero and unavailable versus partial on local, external, and semantic counters", () => {
  const execution = sourceSemanticExecutionPhases(sourceSemanticExecution());
  expect(sourceSemanticExecution()).toBe("native_reasoning_only");
  expect(execution.semantic_generation_attempts).toBe(0);
  expect(execution.query_preparation.method).toBe("not_run");
  expect(execution.query_preparation.token_count).toBeNull();
  expect(execution.query_preparation.external_api_attempts).toBe(0);
  expect(execution.query_preparation.binding_work).toBe("not_run");
  expect(execution.query_preparation.execution_work).toBe("not_run");
  expect(execution.acquisition.status).toBe("not_run");
  expect(execution.acquisition.accounting).toBe("not_run");
  expect(execution.acquisition.result).toBeNull();
  expect(SourceSemanticExecutionSchema.safeParse({ ...execution, semantic_generation_attempts: 1 }).success).toBe(false);
  const unknownAttempts = unavailableSourceQueryPreparation("attestation_missing");
  expect(unknownAttempts.external_api_attempts).toBe(0);
  expect(unknownAttempts.token_count).toBeNull();
  expect(unknownAttempts.elapsed_ms).toBeNull();
  expect(expandedExecution(SourceSemanticExecutionSchema.parse({
    ...execution,
    query_preparation: { ...execution.query_preparation, method: "local_inference", submitted_inputs: 1,
      token_count: 8, external_api_attempts: 0, status: "ready", reason: null }
  })).query_preparation.external_api_attempts).toBe(0);
  expect(expandedExecution(SourceSemanticExecutionSchema.parse({
    ...execution,
    query_preparation: { ...execution.query_preparation, method: "external_api", submitted_inputs: 1,
      token_count: 8, external_api_attempts: 2, status: "ready", reason: null }
  })).query_preparation.external_api_attempts).toBe(2);
  expect(expandedExecution(SourceSemanticExecutionSchema.parse({
    ...execution,
    query_preparation: { ...execution.query_preparation, external_api_attempts: null }
  })).query_preparation.external_api_attempts).toBeNull();
  const measuredZero = {
    ...accessV2().phase_accounting,
    observation: { work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: "unknown" as const }
  };
  expect(SourceSemanticAccessReceiptSchema.parse(accessV2({ phase_accounting: measuredZero }))
    .phase_accounting.observation).toEqual(measuredZero.observation);
  expect(SourceSemanticAccessReceiptSchema.parse(accessV2()).phase_accounting.observation).toBeNull();
  expect(SourceSemanticAccessReceiptSchema.safeParse(accessV2({
    phase_accounting: { ...phaseAccounting, native_cpu: 0 }
  })).success).toBe(false);
  expect(SourceSemanticAccessReceiptSchema.safeParse(accessV2({
    phase_accounting: { ...phaseAccounting, observation: { work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: 0 } }
  })).success).toBe(false);
  expect(SourceSemanticAcquisitionPhaseSchema.parse({
    ...sourceSemanticAcquisitionNotRun("index_unavailable"), status: "failed", reason: "index_unavailable",
    accounting: "partial"
  }).accounting).toBe("partial");
  expect(SourceSemanticAcquisitionPhaseSchema.safeParse({
    ...sourceSemanticAcquisitionNotRun("index_unavailable"), accounting: "complete", result: null, status: "failed"
  }).success).toBe(true);
});

it("keeps private vector bodies out of the public acquisition schema", () => {
  const phase = sourceSemanticAcquisitionNotRun("controlled_or_scoped_access");
  const vector = {
    completion: "partial" as const, state: { status: "unknown" as const, reason: "unbound" }, reason: null,
    inspected_windows: 0, invalid_windows: 0, validation: "not_run" as const,
    ranking: "exact_over_inspected_subset" as const,
    input: { status: "unavailable" as const, reason: "no public vector body" }
  };
  const result = {
    policy: "source-index-interleaved-prefix.v1" as const, navigation_digest: null, completion: "partial" as const,
    nominations: [{
      source: {
        root_key: "record", source_id: "source-2", body_bytes: 1,
        target: { kind: "source_evidence" as const, workspace_id: "workspace", root_kind: "source_record" as const,
          root_id: "record", source_version: "v1", content_digest: digest, evidence_object_id: null }
      },
      lexical: [], vector: { rank: 0, cosine: 1, window: { window_id: digest, start_byte: 0, end_byte: 1,
        content_digest: digest } }
    }],
    accounting: { attempted: 1, admitted: 1, duplicate: 0, rejected: 0, scope_denied: 0, native_unknown: 0,
      resource_refused: 0, stale: 0, nomination_limit: 16 },
    resources: { work: 1, memory_bytes: 8, native_bytes: 8, sql_internal_work: "unknown" as const },
    resource_refusals: [],
    lexical: { completion: "partial" as const, index_coverage: "partial" as const, reason: null, limitations: [],
      tokenization: null },
    vector, limitations: []
  };
  expect(SourceSemanticAcquisitionSchema.parse(result).nominations[0]?.vector).not.toHaveProperty("embedding");
  expect(SourceSemanticAcquisitionSchema.safeParse({
    ...result, nominations: [{ ...result.nominations[0]!, vector: { ...result.nominations[0]!.vector!,
      embedding: [0.25, 0.5] } }]
  }).success).toBe(false);
  expect(SourceSemanticAcquisitionSchema.safeParse({
    ...result, vector: { ...vector, input: { status: "available", profile_id: digest, input_digest: digest,
      embedding: new Float32Array([0.25, 0.5]) } }
  }).success).toBe(false);
  expect(SourceSemanticAcquisitionPhaseSchema.safeParse({
    ...phase, status: "executed", accounting: "complete", result: {
      ...result, nominations: [{ ...result.nominations[0]!, vector: {
        rank: 0, cosine: 1, window: result.nominations[0]!.vector!.window, embedding: new Float32Array(8)
      } }]
    }
  }).success).toBe(false);
  const publicText = JSON.stringify(SourceSemanticAccessReceiptSchema.parse(accessV2({
    acquisition: { ...phase, status: "executed", accounting: "complete", result }
  })));
  expect(publicText).not.toMatch(/embedding/u);
  expect(publicText).not.toMatch(/Float32Array/u);
});

it("does not add an external dispatch while rejecting an old access artifact", () => {
  const original = globalThis.fetch;
  const calls: unknown[] = [];
  globalThis.fetch = ((input: unknown, init?: unknown) => {
    calls.push([input, init]);
    throw new Error("provider transport forbidden");
  }) as typeof fetch;
  try {
    expect(SourceSemanticAccessReceiptSchema.safeParse(historicV1()).success).toBe(false);
    expect(SoulInterpretationPrepareQueryResponseSchema.safeParse(publicPrepare({ access: historicV1() })).success)
      .toBe(false);
    expect(SourceSemanticExecutionSchema.parse(sourceSemanticExecution())).toBe("native_reasoning_only");
    expect(sourceSemanticExecutionPhases(sourceSemanticExecution()).query_preparation.method).toBe("not_run");
    expect(sourceSemanticExecutionPhases(sourceSemanticExecution()).query_preparation.external_api_attempts)
      .toBe(0);
    expect(calls).toEqual([]);
  } finally { globalThis.fetch = original; }
});
