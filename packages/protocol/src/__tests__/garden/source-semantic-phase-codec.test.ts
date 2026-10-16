import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { canonicalJson } from "../../recall/selection/capture/canonical-json.js";
import {
  SourceSemanticAcquisitionPhaseSchema, SourceSemanticAcquisitionSchema,
  SourceSemanticExecutionPhasesSchema, SourceSemanticPhaseAccountingSchema,
  SourceSemanticQueryPreparationSchema, sourceSemanticAcquisitionNotRun,
  unavailableSourceQueryPreparation
} from "../../garden/source-semantic-phase-semantics.js";
import {
  PHASE_CODES, SourceSemanticAccessPhasesSchema, SourceSemanticCompactAcquisitionSchema,
  SourceSemanticCompactPreparationSchema, SourceSemanticExecutionSchema
} from "../../garden/source-semantic-phase-wire.js";
import * as codec from "../../garden/source-semantic-phase-codec.js";

it("classifies an out-of-bounds phase reference as a validation error", () => {
  const acquisition = codec.packSourceSemanticAcquisition(sourceSemanticAcquisitionNotRun("operation_does_not_acquire"));
  const malformed = [1, [1, [], [0, 3, 0, null, 0]], acquisition] as const;
  expect(SourceSemanticExecutionSchema.safeParse(malformed).success).toBe(false);
  expect(() => codec.sourceSemanticExecutionPhases(malformed))
    .toThrow(expect.objectContaining({ name: "AlayaError", code: "VALIDATION" }));
});

const digest = (ch: string) => `sha256:${ch.repeat(64)}`;
const a = digest("a"), b = digest("b"), c = digest("c"), d = digest("d"), e = digest("e");
const profile = {
  provider_kind: "local_onnx", model_id: "mini", model_revision: "r1", artifact_digest: a,
  tokenizer_revision: "t1", dimensions: 8, preprocessing: "prep", normalization: "norm",
  max_input_tokens: 16, windowing: "utf8-byte-windows.v1" as const, window_bytes: 32
};
const target = {
  root_key: "record", source_id: "source-2", body_bytes: 1,
  target: { kind: "source_evidence" as const, workspace_id: "workspace", root_kind: "source_record" as const,
    root_id: "record", source_version: "v1", content_digest: a, evidence_object_id: null }
};
const binding = {
  workspace_id: "workspace", selection_revision: 3, config_id: c, profile_id: d, generation_id: e,
  source_epoch: 1, dimensions: 8
};
const window = { window_id: a, start_byte: 0, end_byte: 1, content_digest: a };
const nineZeros = [0, 0, 0, 0, 0, 0, 0, 0, 0] as const;

function sameCanonical(actual: unknown, expected: unknown) {
  expect(canonicalJson(actual)).toBe(canonicalJson(expected));
}

function code<const Values extends readonly string[]>(values: Values, value: Values[number]) {
  const index = values.indexOf(value);
  if (index < 0) throw new Error("missing phase code");
  return index;
}

function activePreparation() {
  return {
    status: "ready" as const, reason: null, navigation_digest: b,
    selected: { selection_revision: 3, config_id: c, profile_id: d, profile },
    method: "local_inference" as const, submitted_inputs: 1, token_count: 8, external_api_attempts: 0,
    binding_work: "unknown" as const, execution_work: "unknown" as const, elapsed_ms: 1.5
  };
}

function activeAcquisition() {
  return {
    policy: "source-index-interleaved-prefix.v1" as const, status: "executed" as const, reason: null,
    allowance: { max_attempts: 2, max_roots: 4, max_vector_windows: 8 },
    budget: { work_units: 10, memory_bytes: 100 },
    result: {
      policy: "source-index-interleaved-prefix.v1" as const, navigation_digest: b, completion: "partial" as const,
      nominations: [{
        source: target,
        lexical: [{ rank: 0, lane: "unicode61" as const, lane_rank: 0, bm25: 1.25 }],
        vector: { rank: 0, cosine: 0.5, window }
      }],
      accounting: { attempted: 1, admitted: 1, duplicate: 0, rejected: 0, scope_denied: 0, native_unknown: 0,
        resource_refused: 0, stale: 0, nomination_limit: 16 },
      resources: { work: 1, memory_bytes: 8, native_bytes: 8, sql_internal_work: "unknown" as const },
      resource_refusals: [{ stage: "vector" as const, phase: "quota" }],
      lexical: {
        completion: "partial" as const, index_coverage: "partial" as const, reason: null,
        limitations: ["lexical_corpus_coverage_untracked", "0", ""],
        tokenization: {
          policy: "source-index-fts.v1" as const, binding_digest: e, cjk_state: "ready" as const,
          terms: ["发送", "0"], unicode61_terms: ["Alice"], trigram_terms: ["ali"]
        }
      },
      vector: {
        completion: "partial" as const,
        state: { status: "ready" as const, binding },
        reason: null, inspected_windows: 1, invalid_windows: 0, validation: "validated" as const,
        ranking: "exact_over_inspected_subset" as const,
        input: { status: "available" as const, profile_id: d, input_digest: b }
      },
      limitations: ["nominations_are_not_source_absence", "1"]
    },
    accounting: "complete" as const
  };
}

it.each(["input profile", "input digest", "binding", "target", "window"])(
  "rejects a malformed native %s before packing acquisition evidence", (fault) => {
    const phase = structuredClone(activeAcquisition());
    if (fault === "input profile") phase.result.vector.input.profile_id = "invalid";
    if (fault === "input digest") phase.result.vector.input.input_digest = "invalid";
    if (fault === "binding") phase.result.vector.state.binding.generation_id = "invalid";
    if (fault === "target") phase.result.nominations[0]!.source.target.content_digest = "invalid";
    if (fault === "window") phase.result.nominations[0]!.vector.window.window_id = "invalid";
    expect(() => codec.packSourceSemanticAcquisition(phase)).toThrow();
  }
);

function notRunAcquisition(reason = "operation_does_not_acquire") {
  return sourceSemanticAcquisitionNotRun(reason);
}

it("public admission rejects expanded objects, historic versions, and malformed tuples, refs, and enums", () => {
  const expandedPrep = unavailableSourceQueryPreparation("operation_does_not_prepare", "not_requested");
  const expandedAcq = notRunAcquisition();
  const expandedExecution = codec.sourceSemanticExecutionPhases("native_reasoning_only");
  expect(SourceSemanticCompactPreparationSchema.safeParse(expandedPrep).success).toBe(false);
  expect(SourceSemanticCompactAcquisitionSchema.safeParse(expandedAcq).success).toBe(false);
  expect(SourceSemanticExecutionSchema.safeParse(expandedExecution).success).toBe(false);
  expect(SourceSemanticAccessPhasesSchema.safeParse({
    preparation: expandedPrep, acquisition: expandedAcq, phase_accounting: {
      observation: null, completion: "included_in_worker_work_not_separately_measured",
      native_cpu: "unknown", deadline: "soft_quarantine_until_exit"
    }
  }).success).toBe(false);
  expect(SourceSemanticExecutionSchema.safeParse({ contract: "source-semantic-execution-v1" }).success).toBe(false);
  expect(SourceSemanticExecutionSchema.safeParse({
    contract: "source-semantic-execution-v2", query_preparation: expandedPrep, acquisition: expandedAcq,
    semantic_generation_attempts: 0
  }).success).toBe(false);
  const shortBody = [0, code(PHASE_CODES.preparation, "not_requested"), 0, null, 0] as const;
  expect(SourceSemanticCompactPreparationSchema.safeParse([0, ["operation_does_not_prepare"], shortBody]).success)
    .toBe(false);
  expect(SourceSemanticCompactPreparationSchema.safeParse([2, ["operation_does_not_prepare"], shortBody]).success)
    .toBe(false);
  expect(SourceSemanticCompactPreparationSchema.safeParse([1, ["operation_does_not_prepare"]]).success).toBe(false);
  expect(SourceSemanticCompactPreparationSchema.safeParse([1, ["operation_does_not_prepare"],
    [0, 4, 0, null, 0]]).success).toBe(false);
  expect(SourceSemanticCompactPreparationSchema.safeParse([1, ["operation_does_not_prepare"],
    [0, code(PHASE_CODES.preparation, "not_requested"), 1, null, 0]]).success).toBe(false);
  expect(SourceSemanticCompactPreparationSchema.safeParse([1, ["not-a-digest"],
    [0, code(PHASE_CODES.preparation, "not_requested"), null, 0, 0]]).success).toBe(false);
});

it("parse then serialize stays compact and does not call packing or expansion", () => {
  const wireSource = readFileSync(new URL("../../garden/source-semantic-phase-wire.ts", import.meta.url), "utf8");
  expect(wireSource.includes("source-semantic-phase-codec")).toBe(false);
  expect(wireSource.includes("packSourceSemantic")).toBe(false);
  expect(wireSource.includes("expandPreparation")).toBe(false);
  const captured = codec.captureSourceSemanticQueryPreparation(
    unavailableSourceQueryPreparation("operation_does_not_prepare", "not_requested"));
  const packed = codec.packSourceSemanticQueryPreparation(captured);
  const fullEquivalent = [1, ["operation_does_not_prepare"],
    [1, code(PHASE_CODES.preparation, "not_requested"), 0, null, null, 0, 0, null, 0, 0, 0, 0]] as const;
  const nineZeroResult = [null, code(PHASE_CODES.completion, "not_run"), [], nineZeros, [0, 0, 0], [],
    [code(PHASE_CODES.completion, "not_run"), null, [], null],
    [code(PHASE_CODES.completion, "not_run"), null, null, 0, 0, code(PHASE_CODES.validation, "not_run"),
      [1, 0]], []] as const;
  const packedAcq = [1, ["operation_does_not_acquire", "zero-work"],
    [code(PHASE_CODES.acquisition, "not_run"), 0, [0, 0, 0], [0, 0], nineZeroResult,
      code(PHASE_CODES.accounting, "not_run")]] as const;
  const packPrep = vi.spyOn(codec, "packSourceSemanticQueryPreparation");
  const packAcq = vi.spyOn(codec, "packSourceSemanticAcquisition");
  const expandExec = vi.spyOn(codec, "sourceSemanticExecutionPhases");
  const expandAccess = vi.spyOn(codec, "sourceSemanticAccessPhases");
  try {
    const admittedPrep = SourceSemanticCompactPreparationSchema.parse(packed);
    sameCanonical(admittedPrep, packed);
    sameCanonical(SourceSemanticCompactPreparationSchema.parse(JSON.parse(JSON.stringify(admittedPrep))), packed);
    const admittedFull = SourceSemanticCompactPreparationSchema.parse(fullEquivalent);
    expect(admittedFull[2][0]).toBe(1);
    sameCanonical(admittedFull, fullEquivalent);
    const admittedAcq = SourceSemanticCompactAcquisitionSchema.parse(packedAcq);
    expect(admittedAcq[2][4]?.[3]).toEqual([...nineZeros]);
    sameCanonical(admittedAcq, packedAcq);
    const execution = [1, packed, packedAcq] as const;
    const admittedExecution = SourceSemanticExecutionSchema.parse(execution);
    expect(admittedExecution).not.toBe("native_reasoning_only");
    sameCanonical(admittedExecution, execution);
    expect(packPrep).not.toHaveBeenCalled();
    expect(packAcq).not.toHaveBeenCalled();
    expect(expandExec).not.toHaveBeenCalled();
    expect(expandAccess).not.toHaveBeenCalled();
  } finally {
    packPrep.mockRestore(); packAcq.mockRestore(); expandExec.mockRestore(); expandAccess.mockRestore();
  }
  expect(codec.packSourceSemanticQueryPreparation(captured)[2][0]).toBe(0);
  expect(codec.packSourceSemanticAcquisition(codec.captureSourceSemanticAcquisition({
    ...notRunAcquisition(), result: {
      policy: "source-index-interleaved-prefix.v1", navigation_digest: null, completion: "not_run",
      nominations: [], accounting: { attempted: 0, admitted: 0, duplicate: 0, rejected: 0, scope_denied: 0,
        native_unknown: 0, resource_refused: 0, stale: 0, nomination_limit: 0 },
      resources: { work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: "unknown" },
      resource_refusals: [],
      lexical: { completion: "not_run", index_coverage: "partial", reason: null, limitations: [], tokenization: null },
      vector: { completion: "not_run", state: null, reason: null, inspected_windows: 0, invalid_windows: 0,
        validation: "not_run", ranking: "exact_over_inspected_subset",
        input: { status: "unavailable", reason: "zero-work" } },
      limitations: []
    }
  }))[2][4]?.[3]).toBe(0);
});

it("short preparation elides only exact not-run work and zero counters pack as the 0 scalar", () => {
  const short = codec.packSourceSemanticQueryPreparation(codec.captureSourceSemanticQueryPreparation(
    unavailableSourceQueryPreparation("controlled_or_scoped_access", "not_requested")));
  expect(short).toEqual([1, ["controlled_or_scoped_access"],
    [0, code(PHASE_CODES.preparation, "not_requested"), 0, null, 0]]);
  const unavailable = codec.packSourceSemanticQueryPreparation(codec.captureSourceSemanticQueryPreparation(
    unavailableSourceQueryPreparation("attestation_missing")));
  expect(unavailable).toEqual([1, ["attestation_missing"],
    [0, code(PHASE_CODES.preparation, "unavailable"), 0, null, null]]);
  const keepFull = (overrides: Record<string, unknown>) =>
    codec.packSourceSemanticQueryPreparation(codec.captureSourceSemanticQueryPreparation({
      ...unavailableSourceQueryPreparation("controlled_or_scoped_access", "not_requested"), ...overrides
    }))[2][0];
  expect(keepFull({ token_count: 0 })).toBe(1);
  expect(keepFull({ external_api_attempts: null })).toBe(1);
  expect(keepFull({ submitted_inputs: 1 })).toBe(1);
  expect(keepFull({ method: "local_inference" })).toBe(1);
  expect(keepFull({ binding_work: "unknown" })).toBe(1);
  expect(keepFull({ execution_work: "unknown" })).toBe(1);
  expect(keepFull({ selected: { selection_revision: 0, config_id: a, profile_id: d, profile } })).toBe(1);
  const notRun = codec.packSourceSemanticAcquisition(codec.captureSourceSemanticAcquisition(notRunAcquisition()));
  expect(notRun).toEqual([1, ["operation_does_not_acquire"],
    [code(PHASE_CODES.acquisition, "not_run"), 0, [0, 0, 0], [0, 0], null, code(PHASE_CODES.accounting, "not_run")]]);
});

it("capture, pack, public admit, and expand roundtrip inactive and full active fixtures", () => {
  const capturedPrep = codec.captureSourceSemanticQueryPreparation(activePreparation());
  const capturedAcq = codec.captureSourceSemanticAcquisition(activeAcquisition());
  expect(SourceSemanticQueryPreparationSchema.parse(capturedPrep)).toEqual(capturedPrep);
  expect(SourceSemanticAcquisitionPhaseSchema.parse(capturedAcq)).toEqual(capturedAcq);
  expect(SourceSemanticAcquisitionSchema.parse(capturedAcq.result)).toEqual(capturedAcq.result);
  const packedPrep = codec.packSourceSemanticQueryPreparation(capturedPrep);
  const packedAcq = codec.packSourceSemanticAcquisition(capturedAcq);
  expect(packedPrep).toEqual([1, [b, c, d], [1, code(PHASE_CODES.preparation, "ready"), null, 0,
    [3, 1, 2, profile], code(PHASE_CODES.method, "local_inference"), 1, 8, 0,
    code(PHASE_CODES.work, "unknown"), code(PHASE_CODES.work, "unknown"), 1.5]]);
  expect(packedAcq[0]).toBe(1);
  expect(packedAcq[2][0]).toBe(code(PHASE_CODES.acquisition, "executed"));
  expect(packedAcq[2][1]).toBeNull();
  expect(packedAcq[2][2]).toEqual([2, 4, 8]);
  expect(packedAcq[2][3]).toEqual([10, 100]);
  expect(packedAcq[2][5]).toBe(code(PHASE_CODES.accounting, "complete"));
  const result = packedAcq[2][4]!;
  expect(packedAcq[1][result[0]!]).toBe(b);
  expect(result[1]).toBe(code(PHASE_CODES.completion, "partial"));
  expect(result[2][0]?.[0]).toEqual(target);
  expect(result[2][0]?.[1]).toEqual([[0, code(PHASE_CODES.lane, "unicode61"), 0, 1.25]]);
  expect(result[2][0]?.[2]).toEqual([0, 0.5, window]);
  expect(result[3]).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 16]);
  expect(result[7][1]).toEqual([code(PHASE_CODES.vector, "ready"), binding]);
  expect(result[7][6]).toEqual([0, packedAcq[1].indexOf(d), packedAcq[1].indexOf(b)]);
  expect(result[6][2][0]).toBe(code(PHASE_CODES.limitation, "lexical_corpus_coverage_untracked"));
  expect(packedAcq[1][(result[6][2][1] as readonly [number])[0]!]).toBe("0");
  expect(packedAcq[1][(result[6][2][2] as readonly [number])[0]!]).toBe("");
  expect(result[8][0]).toBe(code(PHASE_CODES.limitation, "nominations_are_not_source_absence"));
  expect(packedAcq[1][(result[8][1] as readonly [number])[0]!]).toBe("1");
  const phases = SourceSemanticAccessPhasesSchema.parse([1, packedPrep, packedAcq, null]);
  sameCanonical(phases, [1, packedPrep, packedAcq, null]);
  const expanded = codec.sourceSemanticAccessPhases({ phases });
  sameCanonical(expanded.preparation, capturedPrep);
  sameCanonical(expanded.acquisition, capturedAcq);
  expect(expanded.phase_accounting.observation).toBeNull();
  const measured = codec.sourceSemanticAccessPhases({
    phases: SourceSemanticAccessPhasesSchema.parse([1, packedPrep, packedAcq, [0, 0, 0]])
  });
  expect(measured.phase_accounting.observation).toEqual({
    work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: "unknown"
  });
  const inactivePrep = codec.captureSourceSemanticQueryPreparation(
    unavailableSourceQueryPreparation("controlled_or_scoped_access", "not_requested"));
  const inactiveAcq = codec.captureSourceSemanticAcquisition(notRunAcquisition("controlled_or_scoped_access"));
  const inactive = codec.sourceSemanticAccessPhases({
    phases: SourceSemanticAccessPhasesSchema.parse([1,
      codec.packSourceSemanticQueryPreparation(inactivePrep),
      codec.packSourceSemanticAcquisition(inactiveAcq), null])
  });
  sameCanonical(inactive.preparation, inactivePrep);
  sameCanonical(inactive.acquisition, inactiveAcq);
  const execution = codec.sourceSemanticExecution(capturedPrep, capturedAcq);
  expect(execution).not.toBe("native_reasoning_only");
  if (execution === "native_reasoning_only") throw new Error("expected compact execution");
  sameCanonical(SourceSemanticExecutionSchema.parse(execution), execution);
  const executionPhases = codec.sourceSemanticExecutionPhases(execution);
  expect(SourceSemanticExecutionPhasesSchema.parse(executionPhases)).toEqual(executionPhases);
  sameCanonical(executionPhases.query_preparation, capturedPrep);
  sameCanonical(executionPhases.acquisition, capturedAcq);
  expect(executionPhases.semantic_generation_attempts).toBe(0);
});

it("preserves missing versus null, zero, not_run, partial, and unicode or empty legal strings", () => {
  const emptyReason = codec.captureSourceSemanticQueryPreparation({
    ...unavailableSourceQueryPreparation("x", "not_requested"), reason: ""
  });
  expect(emptyReason.reason).toBe("");
  expect(codec.packSourceSemanticQueryPreparation(emptyReason)).toEqual([1, [""],
    [0, code(PHASE_CODES.preparation, "not_requested"), 0, null, 0]]);
  const unicode = codec.captureSourceSemanticQueryPreparation({
    ...unavailableSourceQueryPreparation("发送 😀"), elapsed_ms: 0
  });
  expect(unicode.reason).toBe("发送 😀");
  expect(codec.packSourceSemanticQueryPreparation(unicode)).toEqual([1, ["发送 😀"],
    [0, code(PHASE_CODES.preparation, "unavailable"), 0, null, 0]]);
  const zeroToken = codec.captureSourceSemanticQueryPreparation({
    ...unavailableSourceQueryPreparation("attestation_missing"), token_count: 0, elapsed_ms: 0
  });
  expect(zeroToken.token_count).toBe(0);
  expect(zeroToken.elapsed_ms).toBe(0);
  expect(unavailableSourceQueryPreparation("attestation_missing").token_count).toBeNull();
  expect(unavailableSourceQueryPreparation("attestation_missing").elapsed_ms).toBeNull();
  const unknownAttempts = codec.captureSourceSemanticQueryPreparation({
    ...unavailableSourceQueryPreparation("attestation_missing", "not_requested"), external_api_attempts: null
  });
  expect(unknownAttempts.external_api_attempts).toBeNull();
  expect(codec.sourceSemanticExecutionExternalAttempts(codec.sourceSemanticExecution(unknownAttempts))).toBeNull();
  expect(codec.sourceSemanticExecutionExternalAttempts("native_reasoning_only")).toBe(0);
  const partial = codec.captureSourceSemanticAcquisition({
    ...notRunAcquisition("index_unavailable"), status: "failed", accounting: "partial"
  });
  expect(partial.accounting).toBe("partial");
  expect(partial.result).toBeNull();
  expect(codec.packSourceSemanticAcquisition(partial)[2][5]).toBe(code(PHASE_CODES.accounting, "partial"));
  expect(SourceSemanticQueryPreparationSchema.safeParse({
    ...unavailableSourceQueryPreparation("attestation_missing"), token_count: undefined
  }).success).toBe(false);
  expect(SourceSemanticPhaseAccountingSchema.safeParse({
    observation: { work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: 0 },
    completion: "included_in_worker_work_not_separately_measured", native_cpu: "unknown",
    deadline: "soft_quarantine_until_exit"
  }).success).toBe(false);
  expect(SourceSemanticPhaseAccountingSchema.safeParse({
    observation: null, completion: "included_in_worker_work_not_separately_measured", native_cpu: 0,
    deadline: "soft_quarantine_until_exit"
  }).success).toBe(false);
});

it("keeps selected profile, generation binding, nomination windows, and target ids exact", () => {
  const captured = codec.captureSourceSemanticAcquisition(activeAcquisition());
  const packed = codec.packSourceSemanticAcquisition(captured);
  const expanded = codec.sourceSemanticAccessPhases({
    phases: [1, codec.packSourceSemanticQueryPreparation(codec.captureSourceSemanticQueryPreparation(activePreparation())),
      packed, null]
  }).acquisition;
  expect(expanded.result?.nominations[0]?.source).toEqual(target);
  expect(expanded.result?.nominations[0]?.vector?.window).toEqual(window);
  expect(expanded.result?.vector.state).toEqual({ status: "ready", binding });
  expect(expanded.result?.vector.input).toEqual({ status: "available", profile_id: d, input_digest: b });
  const selected = codec.sourceSemanticExecutionPhases(codec.sourceSemanticExecution(activePreparation())).query_preparation.selected;
  expect(selected).toEqual({ selection_revision: 3, config_id: c, profile_id: d, profile });
  expect(selected?.profile).toEqual(profile);
});

it("rejects invalid wire coordinates that would bypass leaf constraints and keeps vector bodies out", () => {
  const packedPrep = codec.packSourceSemanticQueryPreparation(codec.captureSourceSemanticQueryPreparation(activePreparation()));
  const badProfile = structuredClone(packedPrep) as unknown as [number, string[], unknown[]];
  const selected = badProfile[2][4] as [number, number, number, typeof profile];
  selected[3] = { ...profile, dimensions: 0 };
  expect(SourceSemanticCompactPreparationSchema.safeParse(badProfile).success).toBe(false);
  const packedAcq = codec.packSourceSemanticAcquisition(codec.captureSourceSemanticAcquisition(activeAcquisition()));
  const withSpan = structuredClone(packedAcq) as unknown as [number, string[], unknown[]];
  const nomination = (withSpan[2][4] as unknown[])[2] as unknown[][];
  nomination[0] = [{ ...target, target: { ...target.target, span: {
    content_start: 0, content_end: 1, retained_extent: "body", content_complete: true, original_complete: true
  } } }, nomination[0]![1], nomination[0]![2]];
  expect(SourceSemanticCompactAcquisitionSchema.safeParse(withSpan).success).toBe(false);
  const capsule = structuredClone(packedAcq) as unknown as [number, string[], unknown[]];
  const capsuleRow = (capsule[2][4] as unknown[])[2] as unknown[][];
  capsuleRow[0] = [{ ...target, target: { ...target.target, root_kind: "evidence_capsule" } },
    capsuleRow[0]![1], capsuleRow[0]![2]];
  expect(SourceSemanticCompactAcquisitionSchema.safeParse(capsule).success).toBe(false);
  const overCap = structuredClone(packedAcq) as unknown as [number, string[], unknown[]];
  const rows = (overCap[2][4] as unknown[])[2] as unknown[];
  rows.push(...Array.from({ length: 16 }, () => rows[0]));
  expect(rows.length).toBe(17);
  expect(SourceSemanticCompactAcquisitionSchema.safeParse(overCap).success).toBe(false);
  expect(SourceSemanticAcquisitionSchema.safeParse({
    ...activeAcquisition().result, nominations: Array.from({ length: 16 }, () => activeAcquisition().result!.nominations[0]!)
  }).success).toBe(true);
  expect(SourceSemanticAcquisitionSchema.safeParse({
    ...activeAcquisition().result, nominations: Array.from({ length: 17 }, () => activeAcquisition().result!.nominations[0]!)
  }).success).toBe(false);
  expect(SourceSemanticAcquisitionSchema.safeParse({
    ...activeAcquisition().result,
    nominations: [{ ...activeAcquisition().result!.nominations[0]!, vector: {
      ...activeAcquisition().result!.nominations[0]!.vector!, embedding: [0.1, 0.2]
    } }]
  }).success).toBe(false);
  const publicText = JSON.stringify({
    packed: packedAcq,
    expanded: codec.sourceSemanticAccessPhases({ phases: [1, packedPrep, packedAcq, null] }).acquisition
  });
  expect(publicText).not.toMatch(/embedding/u);
  expect(publicText).not.toMatch(/Float32Array/u);
});

it("canonical native execution is exact slot equality, never inferred from generation attempts", () => {
  expect(codec.sourceSemanticExecution()).toBe("native_reasoning_only");
  expect(codec.isNativeReasoningOnlyExecution("native_reasoning_only")).toBe(true);
  const phases = codec.sourceSemanticExecutionPhases("native_reasoning_only");
  expect(phases.semantic_generation_attempts).toBe(0);
  sameCanonical(phases.query_preparation, unavailableSourceQueryPreparation("operation_does_not_prepare", "not_requested"));
  sameCanonical(phases.acquisition, notRunAcquisition());
  expect(codec.sourceSemanticExecution(phases.query_preparation, phases.acquisition)).toBe("native_reasoning_only");
  expect(codec.sourceSemanticExecution(
    unavailableSourceQueryPreparation("attestation_missing", "not_requested"))).not.toBe("native_reasoning_only");
  expect(codec.sourceSemanticExecution(phases.query_preparation, {
    ...notRunAcquisition(), budget: { work_units: 1, memory_bytes: 0 }
  })).not.toBe("native_reasoning_only");
  expect(SourceSemanticExecutionPhasesSchema.safeParse({ ...phases, semantic_generation_attempts: 1 }).success)
    .toBe(false);
  const nativeTuple = SourceSemanticExecutionSchema.parse([1,
    codec.packSourceSemanticQueryPreparation(codec.captureSourceSemanticQueryPreparation(phases.query_preparation)),
    codec.packSourceSemanticAcquisition(codec.captureSourceSemanticAcquisition(phases.acquisition))]);
  expect(nativeTuple).not.toBe("native_reasoning_only");
  if (nativeTuple === "native_reasoning_only") throw new Error("parse must not canonicalize");
  expect(codec.isNativeReasoningOnlyExecution(nativeTuple)).toBe(true);
  expect(codec.sourceSemanticExecution(nativeTuple[1], nativeTuple[2])).toBe("native_reasoning_only");
});
