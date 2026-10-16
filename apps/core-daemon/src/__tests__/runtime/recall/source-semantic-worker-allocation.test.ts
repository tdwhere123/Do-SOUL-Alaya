import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreError, createAuditedSourceAdmission, fieldContractSha256 } from "@do-soul/alaya-core";
import { SourceSemanticExecutionSchema, SourceSemanticResourceExhausted, SourceSemanticResourceLedger,
  SourceSemanticWorkerResultSchema, sourceSemanticAccessPhases, sourceSemanticExecutionPhases
} from "@do-soul/alaya-protocol";
import { closeCachedDatabase, SqliteEventLogRepo } from "@do-soul/alaya-storage";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { runOperation } from "../../../runtime/recall-read-worker/dispatch.js";
import { parseWorkerOperationResult } from "../../../runtime/recall-read-worker/operation-schemas.js";
import { serializeWorkerError } from "../../../runtime/recall-read-worker/protocol-validation.js";
import { RECALL_READ_WORKER_PROTOCOL_VERSION } from "../../../runtime/recall-read-worker/protocol.js";
import { createRecallReadWorkerRuntime, type RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { runResearchNominatedSourcePreparation, runSourceSemanticWorker } from "../../../runtime/recall-read-worker/source-semantic-reasoning.js";
import { CLOCK, ORIGINAL, QUERY_BUDGET, RAW, SCOPES, WS, withIndexedSources, type IndexFixture }
  from "./source-semantic-index-acquisition.test-support.js";

const PREFLIGHT = { schema_version: 1 as const, work_units: 8_000, memory_bytes: 24_000,
  page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 };
const VECTOR_BACKING = 65_536;
const VECTOR_ARRAY_OVERHEAD = 32;
const VECTOR_BUFFER_REFERENCES = 80;
const RECEIVED_VECTOR_BYTES = VECTOR_ARRAY_OVERHEAD + VECTOR_BACKING;
const CORE_VECTOR_PHASE = "source query vector capture, validation and norm";
const PACK_PREP = "source phase preparation packing traversal";
const EXEC_TUPLE = "source phase execution tuple allocation";
const OBSERVATION_TUPLE = "source phase observation tuple allocation";
type PreparedQuery = NonNullable<Parameters<typeof runSourceSemanticWorker>[1]["prepared_query"]>;

function payload(request: Parameters<typeof runSourceSemanticWorker>[1]["request"], prepared_query?: PreparedQuery) {
  return { workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES, request,
    ...(prepared_query === undefined ? {} : { prepared_query }) };
}
function operation(request: Parameters<typeof runSourceSemanticWorker>[1]["request"], prepared_query?: PreparedQuery) {
  return { protocol_version: RECALL_READ_WORKER_PROTOCOL_VERSION, id: 1,
    operation: "conditionalField.sourceSemantics" as const, payload: payload(request, prepared_query) };
}
function caught(run: () => unknown) {
  try { return run(); } catch (error) { return error; }
}
function expectClosed(error: unknown, work: Record<string, unknown> = {}) {
  expect(error).toBeInstanceOf(CoreError);
  const closed = error as CoreError;
  expect(closed.code).toBe("CONFLICT");
  expect(closed.subCode).toBe("RETRYABLE_BACKPRESSURE");
  expect(closed.details).toEqual({ work: expect.objectContaining(work) });
  expect(closed.details).not.toHaveProperty("execution");
  const serialized = serializeWorkerError(closed);
  expect(serialized.message).toBe(closed.message);
  expect(serialized.core?.details).toBe(closed.details);
  return closed;
}
async function withAdmittedSource(body: (runtime: RecallReadWorkerRuntime) => Promise<void> | void) {
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-allocation-")), filename = join(directory, "alaya.db");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  try {
    const admission = createAuditedSourceAdmission({
      stores: createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) }),
      eventLogRepo: new SqliteEventLogRepo(database), runtimeNotifier: { notifyEntry: async () => undefined },
      sha256: fieldContractSha256
    });
    await admission.admit({ workspace_id: WS, source_id: "raw", source_version: "1", content_bytes: RAW,
      evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
      speaker: "user", scope_class: "project", spans: [] }, { workspaceId: WS });
    await body(createRecallReadWorkerRuntime(database));
  } finally { database.close(); closeCachedDatabase(filename); await rm(directory, { recursive: true, force: true }); }
}
function viewedEmbedding(values: ArrayLike<number>) {
  const embedding = new Float32Array(new ArrayBuffer(VECTOR_BACKING), 0, values.length);
  embedding.set(values);
  expect(embedding.buffer.byteLength).toBe(VECTOR_BACKING);
  expect(embedding.byteLength).toBeLessThan(VECTOR_BACKING);
  return embedding;
}
async function viewedPrepared(fixture: IndexFixture) {
  const prepared = await fixture.prepareQuery({ navigation: ORIGINAL, supplemental_navigation: "Harbor",
    signal: new AbortController().signal, remainingMs: () => 60_000 });
  if (prepared.vector.status !== "available") throw new Error("available query vector expected");
  if (prepared.supplemental?.vector.status !== "available") throw new Error("available supplemental query vector expected");
  const original = viewedEmbedding(prepared.vector.embedding);
  const hint = viewedEmbedding(prepared.supplemental.vector.embedding);
  expect(original.buffer).not.toBe(hint.buffer);
  return {
    prepared: { ...prepared, vector: { ...prepared.vector, embedding: original },
      supplemental: { ...prepared.supplemental, vector: { ...prepared.supplemental.vector, embedding: hint } } } as PreparedQuery,
    backing: VECTOR_BACKING, receivedBytes: RECEIVED_VECTOR_BYTES, dimensions: prepared.vector.profile.dimensions
  };
}
function collectCharges<T>(run: () => T) {
  const charge = SourceSemanticResourceLedger.prototype.charge;
  const reserve = SourceSemanticResourceLedger.prototype.reserve;
  const calls: { kind: "charge" | "reserve"; work: number; bytes: number; phase: string | undefined;
    remainingBytes: number; remainingWork: number; ok: boolean }[] = [];
  const record = (kind: "charge" | "reserve", work: number, bytes: number, phase: string | undefined,
    remainingWork: number, remainingBytes: number, run: () => unknown) => {
    try {
      const result = run();
      calls.push({ kind, work, bytes, phase, remainingWork, remainingBytes, ok: true });
      return result;
    } catch (error) {
      calls.push({ kind, work, bytes, phase, remainingWork, remainingBytes, ok: false });
      throw error;
    }
  };
  const chargeSpy = vi.spyOn(SourceSemanticResourceLedger.prototype, "charge").mockImplementation(function (this: SourceSemanticResourceLedger, work, bytes, phase) {
    return record("charge", work, bytes, phase, this.work, this.bytes, () => charge.call(this, work, bytes, phase));
  });
  const reserveSpy = vi.spyOn(SourceSemanticResourceLedger.prototype, "reserve").mockImplementation(function (this: SourceSemanticResourceLedger, work, bytes, phase) {
    return record("reserve", work, bytes, phase, this.work, this.bytes, () => reserve.call(this, work, bytes, phase));
  });
  try { return { value: run(), calls }; }
  finally { chargeSpy.mockRestore(); reserveSpy.mockRestore(); }
}
function vectorCharges(calls: ReturnType<typeof collectCharges>["calls"], ok?: boolean) {
  return calls.filter(row => row.kind === "charge" && row.phase === "worker received query vector"
    && (ok === undefined || row.ok === ok));
}

it("rejects malformed input at dispatch and malformed results at the real operation schema, without a second nested parse", async () => {
  await withAdmittedSource(async runtime => {
    await expect(runOperation(runtime, operation({ kind: "prepare_query", original_query: ORIGINAL, budget: QUERY_BUDGET,
      extra: true } as never))).rejects.toThrow();
    await expect(runOperation(runtime, { protocol_version: RECALL_READ_WORKER_PROTOCOL_VERSION, id: 1,
      operation: "conditionalField.sourceSemantics", payload: { workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES,
        request: { kind: "prepare_query", original_query: ORIGINAL, budget: QUERY_BUDGET },
        prepared_query: { vector: { status: "available", embedding: [1, 0, 0] } } } })).rejects.toThrow();
    expect(() => SourceSemanticWorkerResultSchema.parse({ kind: "prepare_query", candidates: [], truncated: true })).toThrow();
    const parse = vi.spyOn(SourceSemanticWorkerResultSchema, "parse");
    const result = await runOperation(runtime, operation({ kind: "prepare_source", source_id: "raw", budget: QUERY_BUDGET }));
    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse.mock.results[0]?.type).toBe("return");
    const admitted = parse.mock.results[0]?.value as { coverage: unknown; catalog: unknown; work: unknown };
    expect(result).toMatchObject({ kind: "prepare_source", execution: "native_reasoning_only" });
    const delivered = result as { coverage: unknown; catalog: unknown };
    expect(delivered.coverage).toBe(admitted.coverage);
    expect(delivered.catalog).toBe(admitted.catalog);
    expect(Object.isFrozen(result)).toBe(true);
    const recopied = parseWorkerOperationResult("conditionalField.sourceSemantics", result) as { coverage: unknown };
    expect(recopied.coverage).not.toBe((result as { coverage: unknown }).coverage);
  });
});

it("charges each distinct received vector backing plus array overhead before skipped and executed index routes and a separate Core copy only when executed", async () => {
  await withIndexedSources([{ id: "raw", text: RAW, vector: [1, 0, 0] }], async fixture => {
    const { prepared, backing, receivedBytes, dimensions } = await viewedPrepared(fixture);
    const worker = { database: fixture.database } as RecallReadWorkerRuntime;
    const receivedCharge = expect.objectContaining({ work: 1, bytes: receivedBytes });
    const skipped = collectCharges(() => runSourceSemanticWorker(worker, payload({ kind: "prepare_query",
      original_query: ORIGINAL, access_policy: "canonical-v1", budget: QUERY_BUDGET }, prepared)));
    const receivedSkipped = vectorCharges(skipped.calls);
    expect(skipped.calls.filter(row => row.kind === "charge" && row.phase === "worker query vector buffer references"))
      .toEqual([expect.objectContaining({ work: 1, bytes: VECTOR_BUFFER_REFERENCES })]);
    expect(receivedSkipped).toEqual([receivedCharge, receivedCharge]);
    expect(skipped.calls.findIndex(row => row.phase === PACK_PREP)).toBeLessThan(skipped.calls.indexOf(receivedSkipped[0]!));
    expect(skipped.calls.some(row => row.phase === "source acquisition envelope and input capture")).toBe(false);
    expect(skipped.calls.some(row => row.phase === CORE_VECTOR_PHASE)).toBe(false);
    expect(skipped.value.kind).toBe("prepare_query");
    expect(sourceSemanticExecutionPhases(SourceSemanticExecutionSchema.parse(skipped.value.execution)).acquisition.status).toBe("not_run");
    const executed = collectCharges(() => runSourceSemanticWorker(worker, payload({ kind: "prepare_query",
      original_query: ORIGINAL, access_hint: "Harbor", budget: QUERY_BUDGET }, prepared)));
    const receivedExecuted = vectorCharges(executed.calls);
    expect(receivedExecuted).toEqual([receivedCharge, receivedCharge]);
    expect(executed.calls.findIndex(row => row.phase === PACK_PREP)).toBeLessThan(executed.calls.indexOf(receivedExecuted[0]!));
    const envelope = executed.calls.findIndex(row => row.phase === "source acquisition envelope and input capture");
    expect(envelope).toBeGreaterThan(executed.calls.indexOf(receivedExecuted[1]!));
    expect(executed.calls.some(row => row.phase === CORE_VECTOR_PHASE)).toBe(true);
    const core = executed.calls.find(row => row.phase === CORE_VECTOR_PHASE);
    expect(core).toMatchObject({ work: 3 * dimensions, bytes: 4 * dimensions });
    expect(core?.bytes).not.toBe(backing);
    expect(core?.bytes).not.toBe(receivedBytes);
    if (executed.value.kind !== "prepare_query" || executed.value.access === undefined) {
      throw new Error("executed preparation access expected");
    }
    expect(executed.value.execution).not.toBe("native_reasoning_only");
    expect(sourceSemanticExecutionPhases(SourceSemanticExecutionSchema.parse(executed.value.execution)).acquisition.status).toBe("executed");
    expect(sourceSemanticExecutionPhases(SourceSemanticExecutionSchema.parse(executed.value.execution)).acquisition)
      .toEqual(sourceSemanticAccessPhases(executed.value.access).acquisition);
    expect(executed.value.work.logical_work).toBeLessThanOrEqual(QUERY_BUDGET.work_units);
    expect(executed.value.work.logical_memory_bytes).toBeLessThanOrEqual(QUERY_BUDGET.memory_bytes);
  });
}, 60_000);

it("refuses one-byte-short backing and charges both complete backings before refusing further work", async () => {
  await withIndexedSources([{ id: "raw", text: RAW, vector: [1, 0, 0] }], async fixture => {
    const { prepared, receivedBytes } = await viewedPrepared(fixture);
    const worker = { database: fixture.database } as RecallReadWorkerRuntime;
    const request = { kind: "prepare_query" as const, original_query: ORIGINAL, access_policy: "canonical-v1" as const,
      budget: QUERY_BUDGET };
    const ample = collectCharges(() => runSourceSemanticWorker(worker, payload(request, prepared)));
    const received = vectorCharges(ample.calls)[0];
    if (received === undefined) throw new Error("received vector charge expected");
    expect(received).toMatchObject({ work: 1, bytes: receivedBytes });
    const spentBefore = QUERY_BUDGET.memory_bytes - received.remainingBytes;
    const bothBackings = received.bytes * 2;
    const adjacent = collectCharges(() => caught(() => runSourceSemanticWorker(worker, payload({ ...request,
      budget: { ...QUERY_BUDGET, memory_bytes: spentBefore + received.bytes - 1 } }, prepared))));
    expect(vectorCharges(adjacent.calls, true)).toEqual([]);
    expect(vectorCharges(adjacent.calls, false)).toEqual([expect.objectContaining({
      work: 1, bytes: received.bytes, remainingBytes: received.bytes - 1, ok: false })]);
    // executionOf runs before buffer charges, so vector exhaustion keeps inference evidence.
    expect(adjacent.value).toMatchObject({ kind: "prepare_query", outcome: { status: "resource_exhausted" },
      candidates: [], truncated: true });
    expect((adjacent.value as { work: { native_work: number; native_bytes: number; logical_memory_bytes: number } }).work)
      .toMatchObject({ native_work: 0, native_bytes: 0, logical_memory_bytes: spentBefore });
    const exact = collectCharges(() => caught(() => runSourceSemanticWorker(worker, payload({ ...request,
      budget: { ...QUERY_BUDGET, memory_bytes: spentBefore + bothBackings } }, prepared))));
    const exactVectors = vectorCharges(exact.calls, true);
    expect(exactVectors).toEqual([
      expect.objectContaining({ work: 1, bytes: received.bytes, remainingBytes: bothBackings, ok: true }),
      expect.objectContaining({ work: 1, bytes: received.bytes, remainingBytes: received.bytes, ok: true })]);
    const exhausted = SourceSemanticWorkerResultSchema.parse(exact.value);
    expect(exhausted).toMatchObject({ kind: "prepare_query", outcome: { status: "resource_exhausted" },
      candidates: [], truncated: true, work: {
        logical_memory_bytes: spentBefore + bothBackings, native_work: 0, native_bytes: 0 } });
    expect(sourceSemanticExecutionPhases(SourceSemanticExecutionSchema.parse(exhausted.execution)).query_preparation)
      .toMatchObject({ status: "ready", supplemental: [{ status: "ready" }] });
    expect(exact.calls.some(row => row.phase === CORE_VECTOR_PHASE)).toBe(false);
  });
}, 60_000);

it("keeps resource_exhausted spend, zero native observation, and execution preparation facts under 8000 work and 24000 bytes", async () => {
  await withAdmittedSource(async runtime => {
    const result = await runOperation(runtime, operation({ kind: "prepare_query", original_query: "orchid irrigation",
      budget: PREFLIGHT }));
    expect(result).toMatchObject({ kind: "prepare_query", outcome: { status: "resource_exhausted" },
      candidates: [], truncated: true });
    expect((result as { execution: unknown }).execution).toBe("native_reasoning_only");
    const work = (result as { work: { native_work: number; native_bytes: number; logical_work: number;
      logical_memory_bytes: number } }).work;
    expect(work.native_work).toBe(0);
    expect(work.native_bytes).toBe(0);
    expect(work.logical_work).toBeGreaterThan(0);
    expect(work.logical_work).toBeLessThanOrEqual(PREFLIGHT.work_units);
    expect(work.logical_memory_bytes).toBeLessThanOrEqual(PREFLIGHT.memory_bytes);
    expect(sourceSemanticExecutionPhases((result as { execution: "native_reasoning_only" }).execution).query_preparation)
      .toMatchObject({ status: "not_requested", reason: "operation_does_not_prepare" });
  });
});

it("rebuilds metered execution when acquisition replaces the initial evidence and reuses unchanged phase owners", async () => {
  await withIndexedSources([{ id: "raw", text: RAW, vector: [1, 0, 0] }], async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: ORIGINAL, signal: new AbortController().signal,
      remainingMs: () => 60_000 });
    const worker = { database: fixture.database } as RecallReadWorkerRuntime;
    const charge = SourceSemanticReadBudget.prototype.charge;
    const owners: { preparation: unknown; acquisition: unknown }[] = [];
    vi.spyOn(SourceSemanticReadBudget.prototype, "charge").mockImplementation(function (this: SourceSemanticReadBudget, work, bytes, phase) {
      if (phase === EXEC_TUPLE) {
        owners.push({ preparation: this.preparation, acquisition: this.acquisition });
      }
      return charge.call(this, work, bytes, phase);
    });
    const reused = runSourceSemanticWorker(worker, payload({ kind: "prepare_source", source_id: "raw", budget: QUERY_BUDGET }));
    expect(reused).toMatchObject({ kind: "prepare_source", execution: "native_reasoning_only" });
    expect(reused.execution).toBe("native_reasoning_only");
    expect(owners).toEqual([]);
    const executed = runSourceSemanticWorker(worker, payload({ kind: "prepare_query", original_query: ORIGINAL,
      budget: QUERY_BUDGET }, prepared));
    expect(owners.length).toBeGreaterThanOrEqual(2);
    expect(owners[0]?.acquisition).toBeUndefined();
    expect(owners.at(-1)?.acquisition).toBeDefined();
    expect(owners.at(-1)?.acquisition).not.toBe(owners[0]?.acquisition);
    if (executed.kind !== "prepare_query" || executed.access === undefined) throw new Error("executed preparation access expected");
    expect(executed.execution).not.toBe("native_reasoning_only");
    const acquisition = sourceSemanticExecutionPhases(SourceSemanticExecutionSchema.parse(executed.execution)).acquisition;
    expect(acquisition.status).toBe("executed");
    expect(acquisition).toEqual(sourceSemanticAccessPhases(executed.access).acquisition);
    expect(acquisition.reason).not.toBe("operation_does_not_acquire");
  });
}, 60_000);

it("fails closed when source-phase capture exhausts after an available vector without admitting execution", async () => {
  await withIndexedSources([{ id: "raw", text: RAW, vector: [1, 0, 0] }], async fixture => {
    const { prepared } = await viewedPrepared(fixture);
    const retain = SourceSemanticReadBudget.prototype.retain;
    vi.spyOn(SourceSemanticReadBudget.prototype, "retain").mockImplementation(function (this: SourceSemanticReadBudget, value, phase, ownership) {
      if (phase === "source phase semantic preparation capture") {
        throw new SourceSemanticResourceExhausted("source phase semantic preparation capture");
      }
      return retain.call(this, value, phase, ownership);
    });
    const closed = expectClosed(caught(() => runSourceSemanticWorker({ database: fixture.database } as RecallReadWorkerRuntime,
      payload({ kind: "prepare_query", original_query: ORIGINAL, budget: QUERY_BUDGET }, prepared))), {
      native_work: 0, native_bytes: 0, logical_memory_bytes: expect.any(Number) });
    expect(closed.message).toContain("source phase semantic preparation capture");
    expect(closed.details).not.toHaveProperty("execution");
  });
}, 60_000);

it("keeps original CoreError work when acquisition changes then observation leaves too little rebuild room", async () => {
  await withIndexedSources([{ id: "raw", text: RAW, vector: [1, 0, 0] }], async fixture => {
    const { prepared } = await viewedPrepared(fixture);
    const charge = SourceSemanticResourceLedger.prototype.charge;
    const calls: { phase: string | undefined; ok: boolean; remainingWork: number; remainingBytes: number;
      acquisition: unknown }[] = [];
    vi.spyOn(SourceSemanticResourceLedger.prototype, "charge").mockImplementation(function (this: SourceSemanticResourceLedger, work, bytes, phase) {
      const meter = this as SourceSemanticReadBudget;
      if (phase === OBSERVATION_TUPLE && meter.acquisition !== undefined) {
        // Named injection: leave <33 work and <24 bytes, below execution-tuple rebuild room.
        if (this.work >= 33) charge.call(this, this.work - 32, 0, phase);
        if (this.bytes >= 24) charge.call(this, 0, this.bytes - 23, phase);
      }
      try {
        const result = charge.call(this, work, bytes, phase);
        calls.push({ phase, ok: true, remainingWork: this.work + work, remainingBytes: this.bytes + bytes,
          acquisition: meter.acquisition });
        return result;
      } catch (error) {
        calls.push({ phase, ok: false, remainingWork: this.work, remainingBytes: this.bytes,
          acquisition: meter.acquisition });
        throw error;
      }
    });
    const closed = expectClosed(caught(() => runSourceSemanticWorker({ database: fixture.database } as RecallReadWorkerRuntime,
      payload({ kind: "prepare_query", original_query: ORIGINAL, budget: QUERY_BUDGET }, prepared))), {
      logical_work: expect.any(Number), logical_memory_bytes: expect.any(Number) });
    expect(closed.message).toBe(`source semantic ${OBSERVATION_TUPLE} budget exhausted`);
    const failed = calls.find(row => row.phase === OBSERVATION_TUPLE && row.ok === false);
    const firstTuple = calls.find(row => row.phase === EXEC_TUPLE);
    const failedIndex = calls.findIndex(row => row.phase === OBSERVATION_TUPLE && row.ok === false);
    expect(firstTuple).toBeDefined();
    expect(failed).toBeDefined();
    expect(failed?.remainingWork).toBeLessThan(33);
    expect(failed?.remainingBytes).toBeLessThan(24);
    expect(failed?.acquisition).toBeDefined();
    expect(firstTuple?.acquisition).toBeUndefined();
    expect(failed?.acquisition).not.toBe(firstTuple?.acquisition);
    expect(failedIndex).toBeGreaterThan(calls.findIndex(row => row.phase === EXEC_TUPLE));
    let lastTuple = -1;
    for (let i = calls.length - 1; i >= 0; i -= 1) {
      if (calls[i]!.phase === EXEC_TUPLE) { lastTuple = i; break; }
    }
    expect(lastTuple).toBeLessThan(failedIndex);
  });
}, 60_000);

it("returns resource_exhausted native evidence when early research read exhausts without a phase change", async () => {
  await withAdmittedSource(async runtime => {
    const ids = ["raw"] as const;
    const work = 1 + ids.length;
    const bytes = ids.reduce((sum, id) => sum + Buffer.byteLength(id, "utf8"), 0);
    const charged = collectCharges(() => runResearchNominatedSourcePreparation(runtime,
      payload({ kind: "prepare_query", original_query: ORIGINAL, budget: { ...PREFLIGHT, work_units: work - 1 } }), ids));
    expect(charged.value).toMatchObject({ kind: "prepare_query", outcome: { status: "resource_exhausted" },
      candidates: [], truncated: true });
    expect((charged.value as { execution: unknown }).execution).toBe("native_reasoning_only");
    expect(charged.value.work).toMatchObject({ native_work: 0, native_bytes: 0, logical_work: 0 });
    expect(charged.calls.filter(row => row.kind === "charge" && row.phase === "research source index query output")).toEqual([
      expect.objectContaining({ work, bytes, ok: false })]);
    expect(charged.calls.some(row => row.phase === "research source index query output" && row.ok)).toBe(false);
    expect(charged.calls.some(row => row.phase === EXEC_TUPLE)).toBe(false);
  });
});
