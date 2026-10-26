import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SourceSemanticResourceLedger, type SourceIndexAcquisitionInput, type SourceIndexQueryResources,
  type SourceSemanticResourceBudget
} from "@do-soul/alaya-protocol";
import { SqliteFieldSourceRecordRepo } from "../../../../storage/src/repos/field/source-repo.js";
import {
  WORKSPACE, captureDocuments, configuration, fixture, publishSource, type Fixture
} from "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";
import {
  QUERY_BUDGET, admitScope, digest, expectBounded, expectMetadataOnly, publishIndex, query, queryInput
} from "./source-index-acquisition-fixture.js";

const environments: Fixture[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const environment of environments.splice(0)) environment.database.close();
});
function setup() {
  const environment = fixture();
  environments.push(environment);
  return environment;
}
type NativeCall = { phase: "lexical" | "vector" | "admission"; budget: SourceSemanticResourceBudget;
  resources: SourceIndexQueryResources; status: string };

// Pass-through observation only: no manufactured resource counters or native results.
function observeRepository(environment: Fixture) {
  const calls: NativeCall[] = [];
  const lexical = environment.index.readLexicalCandidates.bind(environment.index);
  const vector = environment.index.readVectorCandidates.bind(environment.index);
  const admission = environment.index.admitQueryCandidate.bind(environment.index);
  const lexicalSpy = vi.spyOn(environment.index, "readLexicalCandidates").mockImplementation((...args) => {
    const result = lexical(...args);
    calls.push({ phase: "lexical", budget: { ...args[3] }, resources: result.resources, status: result.completion });
    return result;
  });
  const vectorSpy = vi.spyOn(environment.index, "readVectorCandidates").mockImplementation((...args) => {
    const result = vector(...args);
    calls.push({ phase: "vector", budget: { ...args[3] }, resources: result.resources, status: result.completion });
    return result;
  });
  const admissionSpy = vi.spyOn(environment.index, "admitQueryCandidate").mockImplementation((...args) => {
    const result = admission(...args);
    calls.push({ phase: "admission", budget: { ...args[2] }, resources: result.resources, status: result.status });
    return result;
  });
  return { calls, lexicalSpy, vectorSpy, admissionSpy };
}
function expectOneRemainder(calls: readonly NativeCall[], input: SourceIndexAcquisitionInput) {
  expect(calls.length).toBeGreaterThan(0);
  expect(calls[0]!.budget.work_units).toBeLessThan(input.budget.work_units);
  expect(calls[0]!.budget.memory_bytes).toBeLessThan(input.budget.memory_bytes);
  for (const [index, call] of calls.entries()) {
    expect(call.resources.work).toBeLessThanOrEqual(call.budget.work_units);
    expect(call.resources.memory_bytes).toBeLessThanOrEqual(call.budget.memory_bytes);
    const previous = calls[index - 1];
    if (previous === undefined) continue;
    expect(call.budget.work_units).toBeLessThanOrEqual(previous.budget.work_units - previous.resources.work);
    expect(call.budget.memory_bytes).toBeLessThanOrEqual(previous.budget.memory_bytes - previous.resources.memory_bytes);
  }
}

describe("one acquisition ledger across real SQLite reads, scoring and admission", () => {
  it("debits native metadata/BLOB reads, decoded vector memory, ranking and every overlapping admission from one remainder", () => {
    const environment = setup();
    publishIndex(environment);
    const observed = observeRepository(environment);
    const statement = environment.database.connection.prepare("SELECT 1");
    const all = vi.spyOn(Object.getPrototypeOf(statement) as typeof statement, "all");
    const charges = vi.spyOn(SourceSemanticResourceLedger.prototype, "charge");
    const input = queryInput();
    const result = query(environment, input, admitScope);
    expectBounded(result, input);
    expectOneRemainder(observed.calls, input);
    expect(observed.calls.map(call => call.phase)).toEqual(["lexical", "vector", ...Array<string>(7).fill("admission")]);
    const lexical = observed.calls[0]!, vector = observed.calls[1]!;
    expect(vector.budget).toEqual({ work_units: lexical.budget.work_units - lexical.resources.work,
      memory_bytes: lexical.budget.memory_bytes - lexical.resources.memory_bytes });
    expect(result.resources.native_bytes).toBe(observed.calls.reduce((sum, call) => sum + call.resources.native_bytes, 0));
    expect(result.resources.memory_bytes).toBeGreaterThan(result.resources.native_bytes);
    expect(result.resources.work).toBeGreaterThan(observed.calls.reduce((sum, call) => sum + call.resources.work, 0));
    const pages = all.mock.contexts.flatMap((context, index) => (context as typeof statement).source.includes("ORDER BY v.window_id ASC LIMIT")
      && all.mock.results[index]!.type === "return" ? [all.mock.results[index]!.value as Record<string, unknown>[]] : []);
    // One statement reads the whole window page: window fields and BLOB together, no pointer or per-window row read.
    expect(pages).toHaveLength(1);
    const windows = pages[0]!;
    expect(windows).toHaveLength(7);
    for (const row of windows) {
      expect(row).toMatchObject({ dimensions: 3 });
      expect(Buffer.isBuffer(row.embedding_blob)).toBe(true);
      expect((row.embedding_blob as Buffer).length).toBe(12);
    }
    const returnedWindowBytes = windows.reduce((sum, row) => sum + 40 + (row.window_bytes as number) + (row.embedding_blob as Buffer).length, 0);
    // Selection size/payload reads add native bytes beyond window metadata and BLOBs.
    expect(vector.resources.native_bytes).toBeGreaterThan(returnedWindowBytes);
    expect(vector.resources.memory_bytes).toBeGreaterThanOrEqual(vector.resources.native_bytes + 7 * 3 * 4);
    expect(charges.mock.calls.filter(call => call[2] === "source vector validation and cosine").map(call => call.slice(0, 2)))
      .toEqual(Array.from({ length: 7 }, () => [6, 0]));
    const comparisons = charges.mock.calls.filter(call => call[2] === "source vector root comparison");
    expect(comparisons.length).toBeGreaterThanOrEqual(4);
    expect(comparisons.every(call => call[0] === 1 && call[1] === 0)).toBe(true);
    expect(charges.mock.calls.filter(call => call[2] === "source vector rank retention").map(call => call.slice(0, 2)))
      .toEqual(Array.from({ length: 5 }, () => [1, 128]));
    expectMetadataOnly(result, ["needle a", "oceanbayoceanbay"]);
    expect(result.resources.sql_internal_work).toBe("unknown");
  });

  it.each(["work", "memory"] as const)("keeps successful and refused canonical dependency guards in the aggregate %s allowance", dimension => {
    const environment = setup();
    // Enough real dependency work to reach the later guard after lexical read
    // preflight, even when admission reuses an already validated target.
    const dependencyCount = dimension === "work" ? 48 : 1;
    const origins = ["a", "b"].map(id => Array.from({ length: dependencyCount }, (_, index) =>
      publishSource(environment, `retained origin ${id}-${index}`, `origin-${id}-${index}`,
        { source_representation: { kind: "retained_excerpt" } })));
    const projections = origins.map((rows, index) => publishSource(environment, `needle ${index}`, `canonical-${index}`, {
      source_representation: { kind: "canonical_projection", source_record_ids: rows.map(row => row.record_id) }
    }));
    const generation = environment.index.begin(environment.index.select(WORKSPACE, configuration()));
    const documents = captureDocuments(environment, generation);
    for (const projection of projections) {
      expect(projection.record_id).not.toBe(projection.source_id);
      expect(environment.records.findCurrent(WORKSPACE, projection.source_id)?.source_representation)
        .toEqual({ kind: "canonical_projection", source_record_ids: origins[projections.indexOf(projection)]!.map(row => row.record_id) });
    }
    const observed = observeRepository(environment);
    const input = queryInput(configuration(), { vector: { status: "unavailable", reason: "not_requested" },
      allowance: { max_attempts: 2, max_roots: 2, max_vector_windows: 0 } });
    const ready = query(environment, input, admitScope);
    expect(ready.accounting).toMatchObject({ attempted: 2, admitted: 2, rejected: 0 });
    expect(observed.calls.map(call => call.status)).toEqual(["partial", "ready", "ready"]);
    // The full run locates the second guard's prefix cost, not an expected answer or fabricated lineage.
    const second = observed.calls[2]!;
    const secondSource = observed.admissionSpy.mock.calls[1]![0];
    expect(documents.some(document => document.source.root_key === secondSource.root_key)).toBe(true);
    // Schema-owned targets take one checked reference, not another graph capture.
    const retained = { work_units: 1, memory_bytes: 8 };
    const budget = { ...QUERY_BUDGET };
    if (dimension === "work") {
      // Native fixed read costs five; one canonical dependency needs two further checks.
      budget.work_units -= second.budget.work_units - (retained.work_units + 6);
    } else {
      // A retained chunk (4096), metadata (8192), and one dependency fact (1024).
      budget.memory_bytes -= second.budget.memory_bytes - (retained.memory_bytes + 4096 + 8192 + 1024 - 1);
    }
    observed.calls.length = 0;
    vi.clearAllMocks();
    const current = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findCurrentBounded");
    const authorize = vi.fn(admitScope);
    const limitedInput = { ...input, budget };
    const result = query(environment, limitedInput, authorize);
    expectBounded(result, limitedInput);
    expectOneRemainder(observed.calls, limitedInput);
    expect(observed.calls.map(call => call.phase)).toEqual(["lexical", "admission", "admission"]);
    expect(observed.calls.map(call => call.status)).toEqual(["partial", "ready", "resource_limited"]);
    expect(observed.admissionSpy.mock.results[1]!.value).toMatchObject({ status: "resource_limited", reason: "read_budget",
      phase: "source currentness and erase guard" });
    expect(result.accounting).toEqual({ attempted: 2, admitted: 1, duplicate: 0, rejected: 1, scope_denied: 0,
      native_unknown: 0, resource_refused: 1, stale: 0, nomination_limit: 0 });
    expect(result.resource_refusals).toEqual([{ stage: "admission", phase: "source currentness and erase guard" }]);
    expect(result.completion).toBe("partial");
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(2);
    expect(current.mock.results[0]!.value).toMatchObject({ dependencyWork: 2 * dependencyCount });
    expect(current.mock.results[0]!.value.resourceLimited).not.toBe(true);
    expect(current.mock.results[1]!.value).toMatchObject({ resourceLimited: true });
    expect(current.mock.calls.every(call => projections.some(projection => projection.source_id === call[1]))).toBe(true);
    const admissions = observed.calls.filter(call => call.phase === "admission");
    expect(admissions[0]!.resources.work).toBe(retained.work_units + 6 + 3 * dependencyCount);
    expect(admissions[1]!.resources.work).toBeGreaterThan(retained.work_units);
    expect(admissions[1]!.resources.native_bytes).toBeGreaterThan(0);
    expect(result.resources.native_bytes).toBe(observed.calls.reduce((sum, call) => sum + call.resources.native_bytes, 0));
    expect(result.resources.work).toBeGreaterThan(observed.calls.reduce((sum, call) => sum + call.resources.work, 0));
    expect(result.resources.memory_bytes).toBeGreaterThan(result.resources.native_bytes);
    expect(result.nominations[0]!.source).toEqual(observed.admissionSpy.mock.calls[0]![0]);
    expectMetadataOnly(result, projections.map(projection => projection.source_body!));
  });

  it("reports native admission preflight exhaustion as a resource refusal, not unknown source identity", () => {
    const environment = setup();
    publishIndex(environment, [{ id: "bounded", body: "needle a", vectors: [[1, 0, 0]] }]);
    const observed = observeRepository(environment);
    const input = queryInput(configuration(), { vector: { status: "unavailable", reason: "not_requested" } });
    query(environment, input, admitScope);
    const admission = observed.calls.find(call => call.phase === "admission")!;
    // A target reference fits, but the native guard's chunk/metadata reservation
    // does not. Lexical preflight remains feasible under this memory boundary.
    const limitedInput = { ...input, budget: { ...QUERY_BUDGET,
      memory_bytes: QUERY_BUDGET.memory_bytes - admission.budget.memory_bytes + 8 + 4096 + 8192 - 1 } };
    observed.calls.length = 0;
    vi.clearAllMocks();
    const authorize = vi.fn(admitScope);
    const result = query(environment, limitedInput, authorize);
    expectBounded(result, limitedInput);
    expectOneRemainder(observed.calls, limitedInput);
    expect(observed.calls.map(call => call.status)).toEqual(["complete", "resource_limited"]);
    expect(observed.admissionSpy.mock.results[0]!.value).toMatchObject({ status: "resource_limited", reason: "read_budget",
      phase: "source currentness and erase guard" });
    expect(result.accounting).toEqual({ attempted: 1, admitted: 0, duplicate: 0, rejected: 1, scope_denied: 0,
      native_unknown: 0, resource_refused: 1, stale: 0, nomination_limit: 0 });
    expect(result.resource_refusals).toEqual([{ stage: "admission", phase: "source currentness and erase guard" }]);
    expect(result.completion).toBe("partial");
    expect(result.nominations).toEqual([]);
    expect(authorize).not.toHaveBeenCalled();
  });

  it.each([
    { outcome: "complete native page", readerRefused: false, reason: "scoring_budget" },
    { outcome: "explicit injected partial reader page", readerRefused: true, reason: "read_budget" }
  ])("preserves $reason when cosine scoring exhausts work after a $outcome", expected => {
    const environment = setup();
    const config = configuration({ dimensions: 128 });
    const axis = Array.from({ length: 128 }, (_, index) => index === 0 ? 1 : 0);
    publishIndex(environment, [{ id: "axis", body: "needle a", vectors: [axis] }], config);
    const observed = observeRepository(environment);
    const supplied = queryInput(config);
    if (supplied.vector.status !== "available") throw new Error("expected supplied query vector");
    const input = { ...supplied, navigation_text: "unmatched", vector: { ...supplied.vector,
      input_digest: digest("unmatched"), embedding: new Float32Array(axis) } };
    query(environment, input, admitScope);
    const page = observed.calls.find(call => call.phase === "vector")!;
    // The 128D score costs 256 work: enough native reservation slack, but one unit short for scoring.
    const limitedInput = { ...input, budget: { ...QUERY_BUDGET,
      work_units: QUERY_BUDGET.work_units - page.budget.work_units + page.resources.work + 1 + 255 } };
    const readerRefusal = { stage: "vector", phase: "injected reader page refusal" } as const;
    if (expected.readerRefused) {
      const scan = observed.vectorSpy.getMockImplementation()!;
      // Inject only the reader's partial/refusal outcome; candidates, bytes and reads remain native.
      observed.vectorSpy.mockImplementation((...args) => ({ ...scan(...args), completion: "partial", reason: "read_budget",
        resource_refusal: readerRefusal }));
    }
    observed.calls.length = 0;
    vi.clearAllMocks();
    const result = query(environment, limitedInput, admitScope);
    expectBounded(result, limitedInput);
    expectOneRemainder(observed.calls, limitedInput);
    expect(result.vector).toMatchObject({ completion: "partial", reason: expected.reason, state: { status: "ready" },
      inspected_windows: 1, invalid_windows: 0, validation: "validated", input: { status: "available",
        profile_id: input.vector.profile_id, input_digest: input.vector.input_digest } });
    expect(result.lexical).toMatchObject({ completion: "complete", reason: null });
    expect(result.resource_refusals).toEqual([...(expected.readerRefused ? [readerRefusal] : []),
      { stage: "vector", phase: "source vector validation and cosine" }]);
    expect(result.accounting).toEqual({ attempted: 0, admitted: 0, duplicate: 0, rejected: 0, scope_denied: 0,
      native_unknown: 0, resource_refused: 0, stale: 0, nomination_limit: 0 });
    expect(result.nominations).toEqual([]);
    expect(result.completion).toBe("partial");
    expect(result.resources.work).toBe(limitedInput.budget.work_units - 255);
    expect(result.resources.native_bytes).toBe(observed.calls.reduce((sum, call) => sum + call.resources.native_bytes, 0));
  });

  it("preserves discovery charges and partial scan state when the total remainder cannot finish vector scoring", () => {
    const environment = setup();
    publishIndex(environment);
    const observed = observeRepository(environment);
    const input = queryInput();
    query(environment, input, admitScope);
    const fullVector = observed.calls.find(call => call.phase === "vector")!;
    const oneWindow = environment.index.readVectorCandidates(WORKSPACE, null, 1, QUERY_BUDGET);
    expect(oneWindow.inspected).toBe(1);
    const work = QUERY_BUDGET.work_units - fullVector.budget.work_units + oneWindow.resources.work + 128;
    observed.calls.length = 0;
    vi.clearAllMocks();
    const limitedInput = { ...input, budget: { ...QUERY_BUDGET, work_units: work } };
    const result = query(environment, limitedInput, admitScope);
    expectBounded(result, limitedInput);
    expectOneRemainder(observed.calls, limitedInput);
    expect(result.lexical.completion).toBe("complete");
    expect(result.vector.completion).toBe("partial");
    expect(["scoring_budget", "read_budget"]).toContain(result.vector.reason);
    expect(result.vector.inspected_windows).toBeGreaterThan(0);
    expect(result.completion).toBe("partial");
    expect(result.resources.native_bytes).toBe(observed.calls.reduce((sum, call) => sum + call.resources.native_bytes, 0));
    expect(result.resources.work).toBeGreaterThanOrEqual(observed.calls.reduce((sum, call) => sum + call.resources.work, 0));
    expect(result.resources.native_bytes).toBeGreaterThan(0);
  });
});

describe("truthful budget preflight and bounded caller allowances", () => {
  it.each([
    { work: 0, memory: QUERY_BUDGET.memory_bytes, spentWork: 0, spentMemory: 0,
      phase: "source acquisition result envelope", navigationDigest: null },
    { work: QUERY_BUDGET.work_units, memory: 2048 + 8 * 2 - 1, spentWork: 0, spentMemory: 0,
      phase: "source acquisition result envelope", navigationDigest: null },
    { work: QUERY_BUDGET.work_units, memory: 2048 + 8 * 2 + 24 + 4 * 6 - 1, spentWork: 1, spentMemory: 2048 + 8 * 2,
      phase: "source navigation capture", navigationDigest: null },
    { work: 2, memory: QUERY_BUDGET.memory_bytes, spentWork: 2, spentMemory: 2048 + 8 * 2 + 24 + 4 * 6,
      phase: "source navigation digest", navigationDigest: null },
    { work: 8, memory: QUERY_BUDGET.memory_bytes, spentWork: 8, spentMemory: 2048 + 8 * 2 + 24 + 4 * 6,
      phase: "source query profile", navigationDigest: digest("needle") }
  ])("stops before unadmitted work at work=$work memory=$memory without calling it complete", expected => {
    const environment = setup();
    const read = vi.spyOn(environment.index, "readLexicalCandidates");
    const scan = vi.spyOn(environment.index, "readVectorCandidates");
    const admission = vi.spyOn(environment.index, "admitQueryCandidate");
    const input = queryInput(configuration(), { allowance: { max_attempts: 2, max_roots: 2, max_vector_windows: 0 },
      budget: { work_units: expected.work, memory_bytes: expected.memory } });
    if (input.vector.status !== "available") throw new Error("expected supplied query vector");
    const result = query(environment, input, admitScope);
    expectBounded(result, input);
    expect(result.resources).toEqual({ work: expected.spentWork, memory_bytes: expected.spentMemory,
      native_bytes: 0, sql_internal_work: "unknown" });
    expect(result.completion).toBe("partial");
    expect(result.lexical.completion).toBe("not_run");
    expect(result.vector).toMatchObject({ completion: "not_run", reason: "read_budget", validation: "not_run", state: null,
      inspected_windows: 0, invalid_windows: 0, input: { status: "available",
        profile_id: input.vector.profile_id, input_digest: input.vector.input_digest } });
    expect(result.resource_refusals).toEqual([{ stage: "input", phase: expected.phase }]);
    expect(result.navigation_digest).toBe(expected.navigationDigest);
    expect(result.nominations).toEqual([]);
    expect(result.accounting).toEqual({ attempted: 0, admitted: 0, duplicate: 0, rejected: 0, scope_denied: 0,
      native_unknown: 0, resource_refused: 0, stale: 0, nomination_limit: 0 });
    expect(read).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled();
  });

  it.each([
    { max_attempts: 0 }, { max_attempts: 129 }, { max_attempts: 1.5 },
    { max_roots: 0 }, { max_roots: 17 }, { max_roots: 3, max_attempts: 2 },
    { max_vector_windows: -1 }, { max_vector_windows: 4097 }, { max_vector_windows: NaN }
  ])("rejects invalid safety allowance %j before native reads", changes => {
    const environment = setup();
    const read = vi.spyOn(environment.index, "readLexicalCandidates");
    const input = queryInput();
    expect(() => query(environment, { ...input, allowance: { ...input.allowance, ...changes } }, admitScope))
      .toThrow(/allowance/u);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([{ work_units: -1 }, { memory_bytes: -1 }, { work_units: Infinity }, { memory_bytes: 0.5 }])
    ("rejects invalid total budget %j before native reads", changes => {
      const environment = setup();
      const read = vi.spyOn(environment.index, "readLexicalCandidates");
      const input = queryInput(configuration(), { budget: { ...QUERY_BUDGET, ...changes } });
      expect(() => query(environment, input, admitScope)).toThrow(/allowance/u);
      expect(read).not.toHaveBeenCalled();
    });
});
