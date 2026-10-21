import { expect, it } from "vitest";
import { SourceSemanticAccessProfileSchema, SourceSemanticProfiledAcquisitionPhaseSchema, SourceSemanticProfiledExecutionPhasesSchema } from "../../garden/source-semantic-access-profile.js";
import { SourceSemanticProfiledCompactAcquisitionSchema, SourceSemanticProfiledAccessPhasesSchema,
  SourceSemanticProfiledExecutionSchema, SourceSemanticCompactAcquisitionSchema, SourceSemanticExecutionSchema } from "../../garden/source-semantic-phase-wire.js";
import { captureSourceSemanticAcquisition, packSourceSemanticAcquisition, sourceSemanticAccessPhases,
  sourceSemanticExecution, sourceSemanticExecutionPhases, sourceSemanticAcquisitionResources,
  isNativeReasoningOnlyExecution } from "../../garden/source-semantic-phase-codec.js";
import { SourceSemanticResourceLedger } from "../../garden/source-semantic-resources.js";
import { sourceSemanticAcquisitionNotRun } from "../../garden/source-semantic-phase-semantics.js";
import { SourceSemanticAccessReceiptSchema, SourceSemanticProfiledAccessReceiptSchema } from "../../garden/source-semantic-access.js";
import { SourceSemanticProfiledLibraryDeliverySchema } from "../../garden/source-semantic-profiled-library.js";
import { SourceSemanticLibraryDeliverySchema, SourceSemanticWorkerRequestSchema } from "../../garden/source-semantic-worker.js";
import { SoulInterpretationRequestSchema } from "../../surfaces/mcp-interpretation-types.js";
import { captureSourceSemanticQueryPreparation, packSourceSemanticQueryPreparation } from "../../garden/source-semantic-phase-codec.js";
import { unavailableSourceQueryPreparation } from "../../garden/source-semantic-phase-semantics.js";
import { prepareSourceSemanticCanonicalSubtreesForRequest } from "../../garden/source-semantic-canonical-preparation.js";
import { canonicalJson } from "../../recall/selection/capture/canonical-json.js";
import { acquired, access } from "./source-semantic-profiled-access.test-support.js";
import legacy from "./source-semantic-default-family.fixture.json" with { type: "json" };

const allowance = { max_attempts: 32, max_roots: 24, max_vector_windows: 4096 };
const profile = { contract: "source-semantic-access-v3", result_version: "source-semantic-library-v7", protocol_version: 9,
  order_policy: "native-route-round-robin-v1", acquisition_policy: "source-index-grouped-round-robin.v1",
  channels: "dual", declared_allowance: allowance } as const;
const phase = { policy: profile.acquisition_policy, channels: profile.channels, declared_allowance: allowance,
  allowance: { max_attempts: 0, max_roots: 0, max_vector_windows: 0 }, status: "not_run", reason: "underfunded_allowance",
  budget: { work_units: 0, memory_bytes: 0 }, result: null, accounting: "not_run" } as const;

it("retains independent default access, execution and library wire fixtures byte for byte", () => {
  expect(JSON.stringify(SourceSemanticAccessReceiptSchema.parse(legacy.access))).toBe(JSON.stringify(legacy.access));
  expect(JSON.stringify(SourceSemanticExecutionSchema.parse(legacy.execution))).toBe(JSON.stringify(legacy.execution));
  expect(JSON.stringify(SourceSemanticLibraryDeliverySchema.parse(legacy.library))).toBe(JSON.stringify(legacy.library));
  const oldExecution = SourceSemanticExecutionSchema.parse(legacy.execution);
  const expanded = sourceSemanticExecutionPhases(oldExecution);
  expect(expanded.contract).toBe("source-semantic-execution-v3");
  expect(Object.hasOwn(expanded.acquisition, "declared_allowance")).toBe(false);
  expect(sourceSemanticExecution(expanded.query_preparation, expanded.acquisition)).toEqual(legacy.execution);
});

it("requires an explicit profile without public policy, nulls or oversized safety ceilings", () => {
  expect(SourceSemanticAccessProfileSchema.parse(profile)).toEqual(profile);
  for (const invalid of [null, {}, { ...profile, access_policy: "query-conditioned-v1" }, { ...profile, channels: null },
    { ...profile, declared_allowance: { ...allowance, max_attempts: 129 } },
    { ...profile, declared_allowance: { ...allowance, max_vector_windows: 4097 } },
    { ...profile, declared_allowance: { ...allowance, max_roots: 33 } }]) {
    expect(SourceSemanticAccessProfileSchema.safeParse(invalid).success).toBe(false);
  }
});

it("leaves public and worker ingress unable to select a candidate profile", () => {
  const fields = { original_query: "Which port?", budget: { schema_version: 1, work_units: 20000,
    memory_bytes: 8000000, page_budget: 5, finalization_reserve: 1, min_envelope: 1 } };
  for (const control of [{ candidate_profile: profile }, { access_policy: "native-route-round-robin-v1" },
    { candidate_profile: null }, { access_policy: "query-conditioned-v1", candidate_profile: profile }]) {
    expect(SoulInterpretationRequestSchema.safeParse({ operation: "prepare_query", ...fields, ...control }).success).toBe(false);
    expect(SourceSemanticWorkerRequestSchema.safeParse({ kind: "prepare_query", ...fields, ...control }).success).toBe(false);
  }
});

it("preserves the literal-one default bytes and rejects cross-family compact bodies", () => {
  const legacy = packSourceSemanticAcquisition(sourceSemanticAcquisitionNotRun("operation_does_not_acquire"));
  expect(JSON.stringify(legacy)).toBe('[1,["operation_does_not_acquire"],[1,0,[0,0,0],[0,0],null,2]]');
  const candidate = packSourceSemanticAcquisition(phase);
  expect(candidate[0]).toBe(2);
  expect(SourceSemanticProfiledCompactAcquisitionSchema.parse(candidate)).toEqual(candidate);
  expect(SourceSemanticCompactAcquisitionSchema.safeParse(candidate).success).toBe(false);
  expect(SourceSemanticProfiledCompactAcquisitionSchema.safeParse(legacy).success).toBe(false);
  const wrong = structuredClone(candidate) as unknown as unknown[];
  wrong[0] = 1;
  expect(SourceSemanticCompactAcquisitionSchema.safeParse(wrong).success).toBe(false);
  const future = [3, candidate[1], candidate[2]] as unknown as typeof candidate;
  const preparation = packSourceSemanticQueryPreparation(unavailableSourceQueryPreparation("none"));
  const execution = [2, preparation, future] as const;
  expect(SourceSemanticProfiledExecutionSchema.safeParse(execution).success).toBe(false);
  expect(() => sourceSemanticExecutionPhases(execution)).toThrow(/unsupported source acquisition version/u);
  expect(() => sourceSemanticAcquisitionResources(future)).toThrow(/unsupported source acquisition version/u);
  expect(() => isNativeReasoningOnlyExecution(execution)).toThrow(/unsupported source acquisition version/u);
});

it("captures before packing and dispatches nested versions without native-only collapse", () => {
  const original = structuredClone(phase);
  const captured = captureSourceSemanticAcquisition(original);
  const compact = packSourceSemanticAcquisition(captured);
  expect(Object.isFrozen(original)).toBe(false);
  expect(Object.isFrozen(captured.declared_allowance)).toBe(true);
  const execution = sourceSemanticExecution(undefined, compact);
  expect(execution).not.toBe("native_reasoning_only");
  expect(isNativeReasoningOnlyExecution(execution)).toBe(false);
  expect(SourceSemanticProfiledExecutionSchema.parse(execution)).toEqual(execution);
  const expanded = sourceSemanticExecutionPhases(execution);
  expect(expanded.contract).toBe("source-semantic-execution-v4");
  expect(SourceSemanticProfiledExecutionPhasesSchema.parse(expanded)).toEqual(expanded);
  expect(expanded.acquisition).toEqual(phase);
  if (execution === "native_reasoning_only") throw new Error("candidate execution required");
  const phases = [2, execution[1], compact, null] as const;
  expect(SourceSemanticProfiledAccessPhasesSchema.parse(phases)).toEqual(phases);
  expect(sourceSemanticAccessPhases({ phases }).acquisition).toEqual(phase);
  expect(sourceSemanticAcquisitionResources(compact)).toEqual([0, 0, 0]);
  const meter = new SourceSemanticResourceLedger({ work_units: 100_000, memory_bytes: 1_000_000 });
  packSourceSemanticAcquisition(captured, meter);
  expect(meter.spentWork).toBeGreaterThan(0);
  expect(meter.spentBytes).toBeGreaterThan(0);
});

it("does not represent an underfunded explicit allowance as executed", () => {
  expect(SourceSemanticProfiledAcquisitionPhaseSchema.safeParse({ ...phase, status: "executed" }).success).toBe(false);
  expect(SourceSemanticProfiledAcquisitionPhaseSchema.safeParse({ ...phase, declared_allowance: null }).success).toBe(false);
  const actual = acquired();
  expect(SourceSemanticProfiledAcquisitionPhaseSchema.safeParse({ ...actual, allowance: { ...allowance, max_roots: 16 } }).success).toBe(false);
});

it("retains a bounded occurrence prefix, distinct counters and captured-page progress without inventing full membership", () => {
  const actual = acquired(), result = actual.result!;
  expect(SourceSemanticProfiledAcquisitionPhaseSchema.parse(actual)).toEqual(actual);
  const packed = packSourceSemanticAcquisition(actual);
  expect(sourceSemanticExecutionPhases(sourceSemanticExecution(undefined, packed)).acquisition).toEqual(actual);
  expect(sourceSemanticAcquisitionResources(packed)).toEqual([71, 103, 211]);
  expect(sourceSemanticAcquisitionResources(packSourceSemanticAcquisition({ ...actual, accounting: "partial" }))).toBeNull();
  expect(result.occurrence_prefix).toHaveLength(16);
  expect(result.counts.retained_occurrences).toBe(17);
  const malformed = [
    { ...result, occurrence_prefix: [...result.occurrence_prefix, result.occurrence_prefix[0]] },
    { ...result, prefix_coverage: { kind: "retained_occurrence_prefix", omitted_occurrences: 0 } },
    { ...result, counts: { ...result.counts, distinct_roots: 17 } },
    { ...result, resource_refusals: [] },
    { ...result, lanes: result.lanes.slice(0, 3) },
    { ...result, lanes: [result.lanes[0], result.lanes[0], ...result.lanes.slice(2)] },
    { ...result, occurrence_prefix: result.occurrence_prefix.map((row, i) => i ? row : { ...row, source: { ...row.source, root_key: "unbound" } }) },
    { ...result, occurrence_prefix: result.occurrence_prefix.map((row, i) => i ? row : { ...row, route: { ...row.route, hit: null } }) }
  ];
  for (const invalid of malformed) {
    expect(SourceSemanticProfiledAcquisitionPhaseSchema.safeParse({ ...actual, result: invalid }).success).toBe(false);
  }
  const body = packed[2];
  expect(SourceSemanticProfiledCompactAcquisitionSchema.safeParse([2, [], [...body.slice(0, 4), 0, ...body.slice(5)]]).success).toBe(false);
  expect(SourceSemanticProfiledCompactAcquisitionSchema.safeParse([2, packed[1], body, [packed]]).success).toBe(false);
  expect(SourceSemanticProfiledCompactAcquisitionSchema.safeParse([2, packed[1], [...body.slice(0, 7), malformed[0], body[8]]]).success).toBe(false);
});

it("preserves omission, unavailable position and captured vector window as distinct facts", () => {
  const actual = acquired(), result = actual.result!, first = result.occurrence_prefix[0]!;
  const noHit = { ...first, route: { kind: "lexical", native_rank: 1, lane: "unicode61", lane_rank: 1, bm25: -1 } };
  const omitted = { ...actual, result: { ...result, occurrence_prefix: [noHit, ...result.occurrence_prefix.slice(1)] } };
  const parsed = SourceSemanticProfiledAcquisitionPhaseSchema.parse(omitted);
  expect(Object.hasOwn(parsed.result!.occurrence_prefix[0]!.route, "hit")).toBe(false);
  const vector = { ...first, route: { kind: "vector", native_rank: 1, cosine: 0.5,
    window: { status: "available", window: { window_id: first.source.target.root_id, start_byte: 1, end_byte: 4,
      content_digest: first.source.target.content_digest } } } };
  const vectorResult = { ...result, occurrence_prefix: [vector, ...result.occurrence_prefix.slice(1)], lanes: result.lanes.map((lane, i) =>
    i === 0 ? { ...lane, consumed_occurrences: 18, remaining_captured_occurrences: 4 } : i === 1 ? { ...lane,
      availability: { status: "captured", captured_occurrences: 1 }, consumed_occurrences: 1,
      remaining_captured_occurrences: 0, last_native_rank: 1 } : lane) };
  expect(SourceSemanticProfiledAcquisitionPhaseSchema.safeParse({ ...actual, result: vectorResult }).success).toBe(true);
});

it("correlates access/profile/phase families and rejects legacy outer-layout reinterpretation", () => {
  const receipt = access();
  expect(SourceSemanticProfiledAccessReceiptSchema.parse(receipt)).toEqual(receipt);
  expect(SourceSemanticAccessReceiptSchema.safeParse(receipt).success).toBe(false);
  expect(SourceSemanticProfiledAccessReceiptSchema.safeParse({ ...receipt,
    profile: { ...receipt.profile, channels: "vector" } }).success).toBe(false);
  expect(SourceSemanticProfiledAccessReceiptSchema.safeParse({ ...receipt,
    phases: [2, receipt.phases[1], packSourceSemanticAcquisition(sourceSemanticAcquisitionNotRun("none")), null] }).success).toBe(false);
  expect(SourceSemanticProfiledAccessReceiptSchema.safeParse({ ...receipt, policy: "query-conditioned-v1" }).success).toBe(false);
});

it("quotes and expands the same candidate canonical preimage through the existing owner", () => {
  const budget = { work_units: 1_000_000, memory_bytes: 8_000_000 };
  const preparation = captureSourceSemanticQueryPreparation(unavailableSourceQueryPreparation("none"));
  const acquisition = captureSourceSemanticAcquisition(acquired());
  const phases = [2, packSourceSemanticQueryPreparation(preparation), packSourceSemanticAcquisition(acquisition), null] as const;
  const prepared = prepareSourceSemanticCanonicalSubtreesForRequest(phases, () => preparation, () => acquisition,
    new SourceSemanticResourceLedger(budget));
  try {
    const expanded = prepared.accessPhases({ phases }, new SourceSemanticResourceLedger(budget));
    const expected = canonicalJson(sourceSemanticAccessPhases({ phases }));
    expect(expanded.acquisition).toBe(acquisition);
    const sizes = [...prepared.quote(expanded, new SourceSemanticResourceLedger(budget), new SourceSemanticResourceLedger(budget))];
    const chunks = [...prepared.chunks(expanded, new SourceSemanticResourceLedger(budget))];
    expect(chunks.join("")).toBe(expected);
    expect(sizes).toEqual(chunks.map(chunk => Buffer.byteLength(chunk, "utf8")));
  } finally { prepared.close(); }
});

it("requires correlated candidate library versions, retained access and request-local execution", () => {
  const receipt = access();
  const delivery = { delivery_id: "delivery", request_identity: receipt.input_id,
    query_semantics_status: { status: "unavailable", reason: "absent" }, protocol_version: 9, total_count: 0,
    index: { schema_version: 1, query_id: "query", snapshot_id: receipt.pool_id, result_version: "source-semantic-library-v7",
      entries: [], completeness: { schema_version: 1, logical_index: "complete", observed_coverage: "open",
        transport: "complete", payload: "complete", representation: "complete" }, continuation: null,
      representation: { schema_version: 1, policy: "construct_index_then_page_then_payload", page_budget: 5, identity_tie_break: "serialization" },
      page_purpose: "membership" },
    page_purpose: "membership", discovery: { access: receipt, eligible_source_count: 0, visited_source_pages: 1,
      visited_source_interpretation_pages: 1, visited_source_interpretation_descriptors: 0, candidate_prefix: [],
      examined_source_interpretation_ids: [], unexamined_source_interpretation_count: 0, omitted_duplicate_bindings: 0,
      examination_cap: 32, open_residuals: true, truncated: false },
    order: { enumeration_policy: "evidence_support", tie_policy: "canonical_identity", occupancy: "source_gold_root_identity",
      occupancy_prefix: 5, page_budget: 5 }, slot_qualifiers: [], source_disclosures: {}, execution: "native_reasoning_only" };
  expect(SourceSemanticProfiledLibraryDeliverySchema.parse(delivery)).toEqual(delivery);
  const execution = sourceSemanticExecution(undefined, receipt.phases[2]);
  expect(SourceSemanticProfiledLibraryDeliverySchema.safeParse({ ...delivery, execution }).success).toBe(true);
  const mismatched = sourceSemanticExecution(undefined, { ...phase, channels: "lexical" });
  expect(SourceSemanticProfiledLibraryDeliverySchema.safeParse({ ...delivery, execution: mismatched }).success).toBe(false);
  for (const invalid of [{ ...delivery, protocol_version: 8 }, { ...delivery, index: { ...delivery.index, result_version: "source-semantic-library-v6" } },
    { ...delivery, execution: sourceSemanticExecution(undefined, sourceSemanticAcquisitionNotRun("none")) },
    { ...delivery, discovery: { ...delivery.discovery, access: undefined } }]) {
    expect(SourceSemanticProfiledLibraryDeliverySchema.safeParse(invalid).success).toBe(false);
  }
  expect(SourceSemanticLibraryDeliverySchema.safeParse(delivery).success).toBe(false);
});
