import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => {
  try { expect(isolation.violations).toEqual([]); }
  finally { vi.useRealTimers(); vi.restoreAllMocks(); }
});
afterAll(() => { isolation.restore(); });
import { writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { SourceSemanticWorkerRequestSchema, SoulInterpretationRequestSchema, SourceSemanticExecutionSchema,
  sourceSemanticAccessPhases, sourceSemanticExecutionPhases } from "@do-soul/alaya-protocol";
import { SourceSemanticsPublicPayloadSchema, parseWorkerOperationPayload, type SourceSemanticsPublicPayload } from
  "../../../runtime/recall-read-worker/operation-schemas.js";
import type { RecallReadWorkerRequest } from "../../../runtime/recall-read-worker/protocol.js";
import { BUDGET, CLOCK, ORIGINAL, WS, deferred, digest, embedded, initialQuery, payload, query, queryClient } from
  "./source-semantic-query-preparation-fixture.js";

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const observePosts = () => {
  const nativePost = Worker.prototype.postMessage, firstPost = deferred();
  const spy = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args) {
    nativePost.apply(this, args); firstPost.resolve();
  });
  return { spy, firstPost: firstPost.promise, calls: () => spy.mock.calls.map((args, index) => ({ request: args[0] as RecallReadWorkerRequest,
    worker: spy.mock.contexts[index] as Worker })) };
};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

// Deadlines measure explicit operation progress, not host-dependent worker import time.
// Worker messages, native exits and setImmediate remain real.
function controlDeadlineClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let now = performance.now();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  return { advance: async (ms: number) => { now += ms; await vi.advanceTimersByTimeAsync(ms); } };
}

// These expectations are new behavior, independent of the existing response-fixture migrations.
describe("Source query preparation before native snapshots", () => {
  it.each(["prepare_query", "recall"] as const)("prepares standalone %s outside the built worker's actual SQLite transaction", async kind => {
    const h = await queryClient();
    const posts = observePosts();
    try {
      const input = kind === "prepare_query" ? initialQuery() : payload({ kind, original_query: ORIGINAL,
        query_semantics: query(), accepts_unreviewed_conditional_results: true, budget: BUDGET, output_byte_limit: 1_000_000 });
      h.bind.mockImplementationOnce(async () => {
        expect(h.database.connection.inTransaction).toBe(false);
        expect(h.observations().at(-1)?.in_transaction).toBe(false);
        expect(posts.calls()).toEqual([]);
        return { ...h.binding, embedInputs: async (inputs, options) => {
          expect(h.database.connection.inTransaction).toBe(false);
          expect(h.observations().at(-1)?.in_transaction).toBe(false);
          expect(posts.calls()).toEqual([]);
          expect(inputs).toEqual([{ input_id: digest(ORIGINAL), text: ORIGINAL }]);
          expect(options.signal?.aborted).toBe(false);
          return embedded(inputs);
        } };
      });
      const start = h.observations().length;
      const result = await h.client.sourceSemanticsPort!.execute(input);
      expect(result.kind).toBe(kind);
      expect(sourceSemanticExecutionPhases(SourceSemanticExecutionSchema.parse(result.execution)).query_preparation).toMatchObject({ status: "ready", navigation_digest: digest(ORIGINAL),
        selected: { profile_id: h.selection.profile_id }, submitted_inputs: 1, token_count: 2,
        binding_work: "unknown", execution_work: "unknown" });
      expect(sourceSemanticExecutionPhases(SourceSemanticExecutionSchema.parse(result.execution)).acquisition).toMatchObject({ status: "executed", result: { vector: {
        completion: "complete", validation: "validated", state: { status: "ready" }, inspected_windows: 1 } } });
      expect(h.prepare).toHaveBeenCalledTimes(1);
      const sql = h.observations().slice(start);
      expect(sql.filter(row => /^BEGIN/u.test(row.sql))).toEqual([{ sql: "BEGIN", in_transaction: true }]);
      expect(sql.some(row => /FROM source_(?:index|records)/u.test(row.sql) && row.in_transaction)).toBe(true);
      expect(sql.filter(row => row.sql === "COMMIT")).toEqual([{ sql: "COMMIT", in_transaction: false }]);
      expect(sql.filter(row => row.sql === "ROLLBACK")).toEqual([]);
      expect(posts.calls().map(row => row.request.operation)).toEqual(["conditionalField.sourceSemantics"]);
    } finally { await h.cleanup(); }
  });

  it("prepares in a caller-owned unbegun scope, then executes once inside that caller's real snapshot", async () => {
    const h = await queryClient({ workerCount: 2 });
    const posts = observePosts();
    try {
      await h.client.readSnapshot.isolate!(async () => {
        const start = h.observations().length;
        await h.client.sourceSemanticsPort!.withPreparedExecution(initialQuery(), async execute => {
          expect(h.bind).toHaveBeenCalledTimes(1);
          expect(posts.calls()).toEqual([]);
          expect(h.observations().slice(start)).toEqual([]);
          await h.client.readSnapshot.beginDeferred();
          expect(h.observations().at(-1)).toEqual({ sql: "BEGIN DEFERRED", in_transaction: true });
          try {
            const result = await execute();
            expect(sourceSemanticExecutionPhases(SourceSemanticExecutionSchema.parse(result.execution)).query_preparation.status).toBe("ready");
            expect(h.observations().at(-1)?.in_transaction).toBe(true);
            await expect(execute()).rejects.toThrow("can only be dispatched once");
            expect(h.observations().slice(start).filter(row => /^(?:BEGIN|COMMIT|ROLLBACK)/u.test(row.sql)))
              .toEqual([{ sql: "BEGIN DEFERRED", in_transaction: true }]);
          } finally { await h.client.readSnapshot.rollback(); }
        });
      });
      expect(posts.calls().map(row => row.request.operation)).toEqual([
        "snapshot.beginDeferred", "conditionalField.sourceSemantics", "snapshot.rollback"
      ]);
      expect(new Set(posts.calls().map(row => row.worker)).size).toBe(1);
      expect(h.observations().at(-1)).toEqual({ sql: "ROLLBACK", in_transaction: false });
    } finally { await h.cleanup(); }
  });

  it.each(["prepare_query", "recall"] as const)("reports snapshot_already_begun for unprepared %s without inference, replacement or commit", async kind => {
    const h = await queryClient({ workerCount: 2 });
    const posts = observePosts();
    try {
      await h.client.readSnapshot.isolate!(async () => {
        await h.client.readSnapshot.beginDeferred();
        try {
          const input = kind === "prepare_query" ? initialQuery() : payload({ kind, original_query: ORIGINAL,
            query_semantics: query(), accepts_unreviewed_conditional_results: true, budget: BUDGET, output_byte_limit: 1_000_000 });
          const result = await h.client.sourceSemanticsPort!.execute(input);
          expect(sourceSemanticExecutionPhases(SourceSemanticExecutionSchema.parse(result.execution)).query_preparation).toMatchObject({ status: "unavailable", reason: "snapshot_already_begun",
            selected: null, submitted_inputs: 0, external_api_attempts: 0, binding_work: "not_run", execution_work: "not_run" });
          expect(sourceSemanticExecutionPhases(SourceSemanticExecutionSchema.parse(result.execution)).acquisition.result?.vector).toMatchObject({ completion: "unavailable",
            reason: "snapshot_already_begun", input: { status: "unavailable", reason: "snapshot_already_begun" } });
          expect(h.prepare).not.toHaveBeenCalled();
          expect(h.bind).not.toHaveBeenCalled();
          expect(h.observations().at(-1)?.in_transaction).toBe(true);
          expect(h.observations().filter(row => row.sql === "COMMIT")).toEqual([]);
        } finally { await h.client.readSnapshot.rollback(); }
      });
      expect(new Set(posts.calls().map(row => row.worker)).size).toBe(1);
      expect(posts.calls().map(row => row.request.operation)).toEqual([
        "snapshot.beginDeferred", "conditionalField.sourceSemantics", "snapshot.rollback"
      ]);
    } finally { await h.cleanup(); }
  });

  it("uses access hints only for navigation while retaining original query identity and admitted Q", async () => {
    const h = await queryClient();
    try {
      const first = await h.client.sourceSemanticsPort!.execute(initialQuery());
      const changed = initialQuery();
      if (changed.request.kind !== "prepare_query") throw new Error("query expected");
      const second = await h.client.sourceSemanticsPort!.execute({ ...changed,
        request: { ...changed.request, access_hint: "Alice tools navigation" } });
      if (first.kind !== "prepare_query" || second.kind !== "prepare_query") throw new Error("query expected");
      expect(h.prepare.mock.calls.map(([input]) => input.navigation)).toEqual([ORIGINAL, "Alice tools navigation"]);
      expect(first.query_semantics_status.status).toBe("admitted");
      expect(second.query_semantics_id).toBe(first.query_semantics_id);
      expect(second.query_semantics_status).toEqual(first.query_semantics_status);
      expect(sourceSemanticAccessPhases(second.access!).preparation.navigation_digest).toBe(digest("Alice tools navigation"));
      expect(second.access?.input_id).not.toBe(first.access?.input_id);
      expect(second.access?.source_candidates).toEqual(first.access?.source_candidates);
    } finally { await h.cleanup(); }
  });

  it("reuses a prepared query's access pool without new inference on reason and recall", async () => {
    const h = await queryClient({ workerCount: 2, publishInterpretation: true });
    const posts = observePosts();
    try {
      const prepared = await h.client.sourceSemanticsPort!.execute(initialQuery());
      if (prepared.kind !== "prepare_query" || prepared.query_handle === undefined) throw new Error("query handle expected");
      const owner = posts.calls().at(-1)!.worker;
      expect(prepared.candidates.map(row => row.interpretation_id)).toEqual([h.sourceInterpretationId]);
      const reason = await h.client.sourceSemanticsPort!.execute(payload({ kind: "reason", query_handle: prepared.query_handle,
        source_interpretation_id: prepared.candidates[0]!.interpretation_id,
        accepts_unreviewed_conditional_results: true, budget: BUDGET, output_byte_limit: 1_000_000 }));
      const recalled = await h.client.sourceSemanticsPort!.execute(payload({ kind: "recall", query_handle: prepared.query_handle,
        accepts_unreviewed_conditional_results: true, budget: BUDGET, output_byte_limit: 1_000_000 }));
      expect(reason.kind).toBe("reason");
      if (recalled.kind !== "recall") throw new Error("recall expected");
      expect(prepared.access).toBeDefined();
      expect(recalled.discovery.access?.pool_id).toBe(prepared.access?.pool_id);
      expect(recalled.discovery.access?.phases[1]).toEqual(prepared.access?.phases[1]);
      expect(sourceSemanticExecutionPhases(SourceSemanticExecutionSchema.parse(recalled.execution)).query_preparation).toMatchObject({ status: "not_requested", submitted_inputs: 0 });
      expect(h.prepare).toHaveBeenCalledTimes(1);
      expect(h.bind).toHaveBeenCalledTimes(1);
      expect(posts.calls().every(row => row.worker === owner)).toBe(true);
      const source = await h.client.sourceSemanticsPort!.execute(payload({ kind: "prepare_source", source_id: "query-source", budget: BUDGET }));
      if (source.kind !== "prepare_source") throw new Error("source handle expected");
      await h.client.sourceSemanticsPort!.execute(payload({ kind: "prepare_query", source_handle: source.source_handle,
        original_query: ORIGINAL, query_semantics: query(), budget: BUDGET }));
      expect(h.prepare).toHaveBeenCalledTimes(1);
      expect(h.bind).toHaveBeenCalledTimes(1);
    } finally { await h.cleanup(); }
  });
});

describe("captured Source execution and the single inherited deadline (synthetic worker replies)", () => {
  it("captures the entire input before bind awaits and cannot retarget or replay captured execution", async () => {
    const opened = deferred(), release = deferred();
    const h = await queryClient({ capture: true, bind: async binding => { opened.resolve(); await release.promise; return binding; } });
    const posts = observePosts();
    try {
      const input = structuredClone({ ...initialQuery(), expires_at: "2026-09-18T00:05:00.000Z" }) as Mutable<SourceSemanticsPublicPayload>;
      const expected = structuredClone(input);
      const pending = h.client.sourceSemanticsPort!.withPreparedExecution(input, async execute => {
        // JavaScript arguments cannot retarget this no-argument captured closure.
        const result = await Reflect.apply(execute, undefined, [payload({ kind: "prepare_source", source_id: "retargeted", budget: BUDGET })]);
        await expect(execute()).rejects.toThrow("can only be dispatched once");
        return result;
      });
      await opened.promise;
      input.workspace_id = "mutated-workspace"; input.as_of = "2026-09-19T00:00:00.000Z"; input.lifetime_now = input.as_of;
      input.principal = "mutated-principal"; input.expires_at = "2026-09-19T00:05:00.000Z";
      if (input.authorized_scopes.mode === "named") input.authorized_scopes.scopes.push("global");
      if (input.request.kind !== "prepare_query" || input.request.query_semantics === undefined) throw new Error("query expected");
      input.request.original_query = "mutated query"; input.request.budget.work_units = 1;
      input.request.query_semantics.variables[0]!.id = "mutated";
      input.request.query_semantics.alternatives[0]!.frames[0]!.role_requirements[0]!.support.excerpt = "mutated";
      input.request.query_semantics.return_variables.push("mutated");
      expect(posts.calls()).toEqual([]);
      release.resolve(); await pending;
      expect(posts.calls()).toHaveLength(1);
      expect(posts.calls()[0]!.request.payload).toMatchObject({ ...expected, prepared_query: {
        receipt: { status: "ready", navigation_digest: digest(ORIGINAL) }, vector: { input_digest: digest(ORIGINAL) } } });
      expect(Object.isFrozen(input.request)).toBe(false);
      expect(Object.isFrozen(input.request.query_semantics.variables)).toBe(false);
    } finally { release.resolve(); await h.cleanup(); }
  });

  it.each([["bind", "resolved"], ["model", "resolved"], ["model", "rejected"]] as const)(
    "discards late %s %s outcomes without dispatching, unhandled rejection or a replacement deadline", async (phase, outcome) => {
    const clock = controlDeadlineClock();
    const opened = deferred(), release = deferred();
    let calls = 0;
    const h = await queryClient({ capture: true, requestTimeoutMs: 120,
      ...(phase === "bind" ? { bind: async binding => { opened.resolve(); await release.promise; return binding; } }
        : { embed: async inputs => {
          if (calls++ === 0) {
            opened.resolve(); await release.promise;
            if (outcome === "rejected") throw new Error("fixture model rejected after deadline");
          }
          return embedded(inputs);
        } }) });
    const posts = observePosts(), unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    let latePreparation: Promise<unknown> | undefined;
    try {
      const pending = h.client.sourceSemanticsPort!.execute(initialQuery());
      const rejected = expect(pending).rejects.toThrow("timed out after 120ms");
      await opened.promise;
      latePreparation = h.prepare.mock.results[0]!.value;
      await clock.advance(120);
      await rejected;
      expect(h.prepare.mock.calls[0]![0].signal.aborted).toBe(true);
      expect(posts.calls()).toEqual([]);
      release.resolve(); await latePreparation; await tick(); await tick();
      expect(posts.calls()).toEqual([]);
      expect(unhandled).toEqual([]);
      await expect(h.client.sourceSemanticsPort!.execute(initialQuery())).resolves.toMatchObject({ kind: "prepare_query" });
      expect(posts.calls()).toHaveLength(1);
      expect(unhandled).toEqual([]);
    } finally {
      release.resolve();
      try { await Promise.allSettled([latePreparation]); await tick(); await tick(); await h.cleanup(); }
      finally { process.off("unhandledRejection", onUnhandled); }
    }
  });

  it("includes model time and worker queue time in one deadline and never dispatches an expired queued call", async () => {
    const clock = controlDeadlineClock();
    const opened = deferred(), release = deferred(), model = deferred();
    const h = await queryClient({ capture: true, requestTimeoutMs: 250, embed: async inputs => { await model.promise; return embedded(inputs); } });
    const posts = observePosts();
    let holder: Promise<unknown> | undefined;
    try {
      const request = h.client.sourceSemanticsPort!.execute(initialQuery());
      const rejected = expect(request).rejects.toThrow("timed out after 250ms");
      await clock.advance(90);
      holder = h.client.readSnapshot.isolate!(async () => { opened.resolve(); await release.promise; });
      await opened.promise; model.resolve();
      await tick(); await clock.advance(160);
      await rejected; release.resolve(); await holder; await tick();
      expect(h.prepare).toHaveBeenCalledTimes(1);
      expect(posts.calls()).toEqual([]);
    } finally { model.resolve(); release.resolve(); await holder; await h.cleanup(); }
  });

  it("does not reset the bind/model deadline when dispatch finally starts", async () => {
    const clock = controlDeadlineClock();
    const wait = () => new Promise<void>(resolve => setTimeout(resolve, 80));
    let modelTimeout: number | undefined;
    const h = await queryClient({ capture: true, requestTimeoutMs: 400,
      bind: async binding => { await wait(); return { ...binding, embedInputs: async (inputs, options) => {
        modelTimeout = options.timeoutMs; await wait(); return embedded(inputs);
      } }; } });
    const posts = observePosts();
    try {
      const input = initialQuery();
      if (input.request.kind !== "prepare_query") throw new Error("query expected");
      // Release a real reply at the original deadline; a fresh dispatch deadline would admit it.
      const pending = h.client.sourceSemanticsPort!.execute({ ...input,
        request: { ...input.request, access_hint: "fixture-hold" } });
      const rejected = expect(pending).rejects.toThrow("timed out after 400ms");
      await tick(); await clock.advance(80); await clock.advance(80);
      await posts.firstPost; await clock.advance(240);
      writeFileSync(`${h.filename}.capture.release`, "");
      await rejected;
      expect(modelTimeout).toBeGreaterThan(0);
      expect(modelTimeout).toBeLessThan(400);
      expect(posts.calls()).toHaveLength(1);
      expect(h.prepare.mock.calls[0]![0].signal.aborted).toBe(true);
    } finally { await h.cleanup(); }
  });

  it("quarantines a dispatched timeout until actual worker exit, ignoring late success", async () => {
    const clock = controlDeadlineClock();
    const h = await queryClient({ capture: true, publishInterpretation: true, requestTimeoutMs: 150 });
    const posts = observePosts();
    const nativeTerminate = Worker.prototype.terminate;
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    // Hold the termination request so a real late fixture message can reach the quarantined transport.
    const exit = deferred();
    terminate.mockImplementation(async function (this: Worker) { await exit.promise; return await nativeTerminate.call(this); });
    try {
      const input = initialQuery();
      if (input.request.kind !== "prepare_query") throw new Error("query expected");
      const pending = h.client.sourceSemanticsPort!.execute({ ...input, request: { ...input.request, access_hint: "fixture-hold" } });
      const rejected = expect(pending).rejects.toThrow("timed out after 150ms");
      await posts.firstPost; await clock.advance(150); await rejected;
      const owner = posts.calls()[0]!.worker;
      expect(terminate).toHaveBeenCalledTimes(1);
      let settled = false;
      const next = h.client.sourceSemanticsPort!.execute(initialQuery()).finally(() => { settled = true; });
      const result = expect(next).resolves.toMatchObject({ kind: "prepare_query" });
      // Gate the late success so waiting for it does not spend the next request's replacement budget.
      const late = new Promise<{ result: { query_handle: string } }>(resolve => owner.once("message", resolve));
      writeFileSync(`${h.filename}.capture.release`, "");
      const lateResult = await late;
      expect(settled).toBe(false);
      expect(posts.calls()).toHaveLength(1);
      expect(owner.threadId).toBeGreaterThan(0);
      exit.resolve(); await result;
      expect(owner.threadId).toBe(-1);
      expect(posts.calls()).toHaveLength(2);
      expect(posts.calls()[1]!.worker).not.toBe(owner);
      const staleReason = payload({ kind: "reason", query_handle: lateResult.result.query_handle,
        source_interpretation_id: h.sourceInterpretationId,
        accepts_unreviewed_conditional_results: true, budget: BUDGET, output_byte_limit: 1_000_000 });
      expect(() => SourceSemanticsPublicPayloadSchema.parse(staleReason)).not.toThrow();
      await expect(h.client.sourceSemanticsPort!.execute(staleReason)).rejects.toThrow("Recall delivery worker unavailable");
      expect(posts.calls()).toHaveLength(2);
    } finally { exit.resolve(); terminate.mockRestore(); await h.cleanup(); }
  });
});

it("accepts the private prepared envelope only at the worker boundary and rejects public vector/profile/generation injection", async () => {
  const h = await queryClient({ capture: true });
  const posts = observePosts();
  try {
    await h.client.sourceSemanticsPort!.execute(initialQuery());
    const captured = posts.calls()[0]!.request.payload as Record<string, unknown>;
    expect(() => parseWorkerOperationPayload("conditionalField.sourceSemantics", captured)).not.toThrow();
    expect(SourceSemanticsPublicPayloadSchema.safeParse(captured).success).toBe(false);
    const prepared = captured.prepared_query as { receipt: unknown; vector: unknown };
    expect(() => parseWorkerOperationPayload("conditionalField.sourceSemantics", {
      ...captured, prepared_query: { vector: prepared.vector }
    })).toThrow();
    expect(() => parseWorkerOperationPayload("conditionalField.sourceSemantics", {
      ...captured, prepared_query: { receipt: prepared.receipt }
    })).toThrow();
    for (const field of ["prepared_query", "vector", "profile", "profile_id", "generation_id", "embedding"]) {
      const injected = { ...initialQuery(), [field]: field === "prepared_query" ? captured.prepared_query : "injected" };
      expect(SourceSemanticsPublicPayloadSchema.safeParse(injected).success).toBe(false);
      await expect(h.client.sourceSemanticsPort!.execute(injected)).rejects.toMatchObject({ name: "ZodError" });
      expect(SourceSemanticWorkerRequestSchema.safeParse({ ...initialQuery().request, [field]: "injected" }).success).toBe(false);
      expect(SoulInterpretationRequestSchema.safeParse({ operation: "prepare_query", original_query: ORIGINAL,
        budget: BUDGET, [field]: "injected" }).success).toBe(false);
    }
    expect(posts.calls()).toHaveLength(1);
  } finally { await h.cleanup(); }
});
