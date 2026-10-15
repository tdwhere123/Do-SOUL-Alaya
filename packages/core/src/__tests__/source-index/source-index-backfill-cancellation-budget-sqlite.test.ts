import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceIndexSelection } from "@do-soul/alaya-protocol";
import { SourceIndexBackfill } from "../../source-index/source-index-backfill.js";
import { SourceIndexLifecycle } from "../../source-index/source-index-lifecycle.js";
import type {
  SourceEmbeddingBinding, SourceEmbeddingInput, SourceEmbeddingResult
} from "../../embedding-recall/source-embedding-runtime.js";
import { SqliteFieldSourceRecordRepo } from "../../../../storage/src/repos/field/source-repo.js";
import {
  BUDGET, WORKSPACE, configuration, fieldSha256, fixture, lexicalRows, publishSource, type Fixture
} from "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";

const environments: Fixture[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const environment of environments.splice(0)) environment.database.close();
});
const digest = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => { resolve = fulfill; reject = fail; });
  return { promise, resolve, reject };
}
function embedded(inputs: readonly SourceEmbeddingInput[]): readonly SourceEmbeddingResult[] {
  return inputs.map(input => ({ status: "embedded", input_id: input.input_id, input_digest: digest(input.text),
    vector: new Float32Array([0.6, 0.8, 0]), token_count: 2, truncated: false }));
}
// Controlled fixture-only attestation; this does not run a model or contact a provider.
function controlledBinding(selection: SourceIndexSelection,
  implementation: SourceEmbeddingBinding["embedInputs"] = async inputs => embedded(inputs)) {
  return { status: "ready" as const, profile: { ...selection.configuration.profile }, profile_id: selection.profile_id,
    embedInputs: vi.fn(implementation) };
}
function setup(body = "one") {
  const environment = fixture();
  environments.push(environment);
  publishSource(environment, body);
  const lifecycle = new SourceIndexLifecycle(environment.index, fieldSha256);
  const selection = lifecycle.select(WORKSPACE, configuration());
  const generation = lifecycle.begin(selection);
  lifecycle.capture(WORKSPACE, generation.generation_id, 8, BUDGET);
  const [target] = environment.index.listTargets(WORKSPACE, generation.generation_id, null, 8);
  if (target === undefined) throw new Error("expected captured SQLite root");
  const backfill = new SourceIndexBackfill(lifecycle);
  const input = { selection, generation_id: generation.generation_id, root_key: target.root_key,
    binding: controlledBinding(selection), budget: { ...BUDGET, model_inputs: 10, input_bytes: 1024, max_body_bytes: 1024 },
    deadline_ms: Date.now() + 60_000, signal: new AbortController().signal };
  const vectors = () => environment.database.connection.prepare(`SELECT w.ordinal,v.window_id,v.embedding_blob,v.token_count
    FROM source_index_vectors v JOIN source_index_windows w USING(workspace_id,generation_id,window_id)
    ORDER BY w.ordinal`).all();
  return { ...environment, lifecycle, selection, generation, target, backfill, input, vectors };
}
function observeNativeReads() {
  // These spies call the actual retained-source SQLite reader. Its returned native bytes are the
  // independent evidence here, not counters supplied by a fake lifecycle/repository/database.
  const current = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findCurrentBounded");
  const chunks = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findByIdBounded");
  const bytes = () => [...current.mock.results, ...chunks.mock.results].reduce((total, result) => {
    if (result.type !== "return" || result.value === null) return total;
    return total + result.value.nativeBytes + result.value.metadataBytes;
  }, 0);
  return { current, chunks, bytes };
}

describe("Source backfill native read accounting and execution budgets", () => {
  it("accounts for preparation, each pending lookup and guarded vector write with actual native reader bytes", async () => {
    const environment = setup();
    const observed = observeNativeReads();
    const preparation = vi.spyOn(environment.lifecycle, "prepare");
    const pending = vi.spyOn(environment.lifecycle, "pendingWindows");
    const write = vi.spyOn(environment.lifecycle, "acceptVector");
    const result = await environment.backfill.step(environment.input);
    expect(result).toMatchObject({ status: "root_complete", accepted_vectors: 1,
      resources: { work: 25, native_accounting: "complete", sql_internal_work: "unknown", model_inputs_submitted: 1,
        model_input_bytes_submitted: 3, token_count_observed: 2, inputs_without_token_count: 0, model_execution_work: "unknown" } });
    // Four real native reads at five work each, three erase guards, and two pending lookups.
    expect(observed.current).toHaveBeenCalledTimes(3);
    expect(observed.chunks).toHaveBeenCalledTimes(1);
    expect(observed.bytes()).toBeGreaterThan(0);
    expect(result.resources.native_bytes).toBe(observed.bytes() + 8);
    expect(result.resources.native_bytes).toBeLessThanOrEqual(environment.input.budget.native_bytes);
    const prepared = preparation.mock.results[0];
    if (prepared?.type !== "return") throw new Error("expected real preparation result");
    expect(prepared.value.resources.work).toBe(17);
    expect(pending.mock.calls[0]?.[4]).toEqual({ work: BUDGET.work - 17,
      native_bytes: BUDGET.native_bytes - prepared.value.resources.native_bytes });
    expect(write.mock.calls[0]?.[3]).toEqual({ work: BUDGET.work - 18,
      native_bytes: BUDGET.native_bytes - prepared.value.resources.native_bytes - 8 });
    expect(pending.mock.results.map(result => result.type === "return" ? result.value.resources : null)).toEqual([
      { work: 1, native_bytes: 8 }, { work: 1, native_bytes: 0 }
    ]);
    expect(environment.database.connection.inTransaction).toBe(false);
  });

  it.each([
    [0, 0, 0, 0, 0, 0], [6, 6, 0, 1, 0, 0], [11, 11, 0, 1, 1, 0],
    [17, 17, 0, 2, 1, 0], [18, 18, 0, 2, 1, 1], [23, 23, 0, 3, 1, 1],
    [24, 24, 1, 3, 1, 1], [25, 25, 1, 3, 1, 1]
  ])("honors a %s-work cap, including real refused-write costs and retained accepts", async (
    work, expectedWork, accepted, currentReads, chunkReads, submitted
  ) => {
    const environment = setup();
    const observed = observeNativeReads();
    const result = await environment.backfill.step({ ...environment.input, budget: { ...environment.input.budget, work } });
    expect(result).toMatchObject({ status: work === 25 ? "root_complete" : "resource_exhausted",
      reason: work === 25 ? "no_pending_windows" : "read_budget", accepted_vectors: accepted,
      resources: { work: expectedWork, native_accounting: "complete", model_inputs_submitted: submitted,
        model_input_bytes_submitted: 3 * submitted, token_count_observed: 2 * submitted,
        inputs_without_token_count: 0, model_execution_work: submitted === 0 ? "not_run" : "unknown" } });
    expect(observed.current).toHaveBeenCalledTimes(currentReads);
    expect(observed.chunks).toHaveBeenCalledTimes(chunkReads);
    expect(result.resources.native_bytes).toBe(observed.bytes() + (work >= 18 ? 8 : 0));
    expect(result.resources.work).toBeLessThanOrEqual(work);
    expect(environment.vectors()).toHaveLength(accepted);
    expect(environment.index.state(WORKSPACE)).toMatchObject({ active_generation_id: null });
  });

  it("refuses zero native bytes before any retained-source reads or model submission", async () => {
    const environment = setup();
    const observed = observeNativeReads();
    expect(await environment.backfill.step({ ...environment.input, budget: { ...environment.input.budget, native_bytes: 0 } }))
      .toMatchObject({ status: "resource_exhausted", reason: "read_budget", accepted_vectors: 0,
        resources: { work: 0, native_bytes: 0, model_inputs_submitted: 0, model_execution_work: "not_run" } });
    expect(observed.current).not.toHaveBeenCalled();
    expect(observed.chunks).not.toHaveBeenCalled();
    expect(environment.input.binding.embedInputs).not.toHaveBeenCalled();
  });

  it.each([
    [0, 15, "model_input_budget", 0, 0], [1, 15, "model_input_budget", 1, 8],
    [2, 7, "model_input_bytes", 0, 0], [2, 8, "model_input_bytes", 1, 8],
    [2, 14, "model_input_bytes", 1, 8], [2, 15, "no_pending_windows", 2, 15]
  ])("enforces exact model input/UTF-8 byte edges (%s inputs, %s bytes)", async (
    modelInputs, inputBytes, reason, accepted, bytes
  ) => {
    const environment = setup("Alpha猫\nβeta!");
    const result = await environment.backfill.step({ ...environment.input,
      budget: { ...environment.input.budget, model_inputs: modelInputs, input_bytes: inputBytes } });
    expect(result).toMatchObject({ status: accepted === 2 ? "root_complete" : "resource_exhausted", reason,
      accepted_vectors: accepted, resources: { model_inputs_submitted: accepted, model_input_bytes_submitted: bytes,
        model_execution_work: accepted === 0 ? "not_run" : "unknown" } });
    expect(environment.input.binding.embedInputs).toHaveBeenCalledTimes(accepted);
    expect(environment.vectors()).toHaveLength(accepted);
    expect(result.resources.model_input_bytes_submitted).toBeLessThanOrEqual(inputBytes);
  });

  it.each([14, 15])("does not treat a %s-byte complete-body cap as a clipped successful manifest", async maxBytes => {
    const environment = setup("Alpha猫\nβeta!");
    const observed = observeNativeReads();
    const result = await environment.backfill.step({ ...environment.input,
      budget: { ...environment.input.budget, max_body_bytes: maxBytes } });
    expect(result).toMatchObject(maxBytes === 14 ? { status: "resource_exhausted", reason: "body_capacity",
      accepted_vectors: 0, resources: { work: 6, model_inputs_submitted: 0 } }
      : { status: "root_complete", accepted_vectors: 2, resources: { work: 32, model_inputs_submitted: 2 } });
    expect(observed.chunks).toHaveBeenCalledTimes(maxBytes === 14 ? 0 : 1);
    expect(result.resources.native_bytes).toBe(observed.bytes() + (maxBytes === 14 ? 0 : 16));
  });

  it.each(["synchronous runtime throw", "rejected transport", "invalid input evidence", "invalid vector dimension"] as const)(
    "never reports zero submitted work on %s", async failure => {
      const environment = setup();
      const observed = observeNativeReads();
      const binding = controlledBinding(environment.selection, inputs => {
        if (failure === "synchronous runtime throw") throw new Error("fixture synchronous inference failure");
        if (failure === "rejected transport") return Promise.reject(new Error("fixture lost inference transport"));
        return Promise.resolve(embedded(inputs).map(result => failure === "invalid input evidence"
          ? { ...result, input_digest: digest("wrong input") }
          : result.status === "embedded" ? { ...result, vector: new Float32Array([1, 0]) } : result));
      });
      const result = await environment.backfill.step({ ...environment.input, binding });
      expect(result).toMatchObject({ status: "failed", accepted_vectors: 0, resources: { work: 18,
        native_accounting: "complete", model_inputs_submitted: 1, model_input_bytes_submitted: 3,
        inputs_without_token_count: 1, token_count_observed: 0, model_execution_work: "unknown" } });
      expect(result.reason).toMatch(/fixture|evidence mismatch|Invalid Source embedding attestation/u);
      expect(result.resources.native_bytes).toBe(observed.bytes() + 8);
      expect(binding.embedInputs).toHaveBeenCalledTimes(1);
      expect(environment.vectors()).toEqual([]);
    });

  it("retains known preparation read costs when a real SQLite manifest write aborts", async () => {
    const environment = setup();
    environment.database.connection.exec(`CREATE TEMP TRIGGER reject_fixture_manifest BEFORE INSERT ON source_index_windows
      BEGIN SELECT RAISE(ABORT, 'fixture manifest write failed'); END`);
    const observed = observeNativeReads();
    const result = await environment.backfill.step(environment.input);
    expect(result).toMatchObject({ status: "failed", reason: "fixture manifest write failed", accepted_vectors: 0,
      resources: { work: 17, native_accounting: "partial", model_inputs_submitted: 0, model_execution_work: "not_run" } });
    expect(observed.current).toHaveBeenCalledTimes(2);
    expect(observed.chunks).toHaveBeenCalledTimes(1);
    expect(result.resources.native_bytes).toBe(observed.bytes());
    expect(result.resources.native_bytes).toBeGreaterThan(0);
    expect(lexicalRows(environment.database)).toEqual([]);
    expect(environment.vectors()).toEqual([]);
    expect(environment.database.connection.inTransaction).toBe(false);
  });

  it("retains accepted vectors and known failed-write costs when the next actual SQLite vector insert aborts", async () => {
    const environment = setup("Alpha猫\nβeta!");
    environment.database.connection.exec(`CREATE TEMP TRIGGER reject_fixture_vector BEFORE INSERT ON source_index_vectors
      WHEN NEW.window_id IN (SELECT window_id FROM source_index_windows WHERE ordinal=1)
      BEGIN SELECT RAISE(ABORT, 'fixture vector write failed'); END`);
    const observed = observeNativeReads();
    const result = await environment.backfill.step(environment.input);
    expect(result).toMatchObject({ status: "failed", reason: "fixture vector write failed", accepted_vectors: 1,
      resources: { work: 31, native_accounting: "partial", model_inputs_submitted: 2, model_input_bytes_submitted: 15,
        token_count_observed: 4, inputs_without_token_count: 0, model_execution_work: "unknown" } });
    expect(observed.current).toHaveBeenCalledTimes(4);
    expect(observed.chunks).toHaveBeenCalledTimes(1);
    expect(result.resources.native_bytes).toBe(observed.bytes() + 16);
    const accepted = environment.vectors();
    expect(accepted).toMatchObject([{ ordinal: 0 }]);
    expect(environment.database.connection.inTransaction).toBe(false);
    environment.database.connection.exec("DROP TRIGGER reject_fixture_vector");
    const binding = controlledBinding(environment.selection);
    expect(await environment.backfill.step({ ...environment.input, binding })).toMatchObject({ status: "root_complete", accepted_vectors: 1 });
    expect(binding.embedInputs.mock.calls.map(([inputs]) => inputs.map(input => input.text))).toEqual([["\nβeta!"]]);
    expect(environment.vectors()[0]).toEqual(accepted[0]);
    expect(environment.vectors()).toHaveLength(2);
    expect(environment.index.state(WORKSPACE)).toMatchObject({ active_generation_id: null });
  });
});

describe("Source backfill cancellation races through SQLite with simulated inference", () => {
  let unhandled: unknown[] = [];
  const recordUnhandled = (reason: unknown) => { unhandled.push(reason); };
  beforeEach(() => {
    unhandled = [];
    // Observe in addition to Vitest's handlers: unexpected rejections must still fail the run.
    process.on("unhandledRejection", recordUnhandled);
  });
  afterEach(async () => {
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", recordUnhandled);
    }
  });

  it.each([
    { scenario: "synchronous abort then throw", stop: "caller", tokens: 0, unknownInputs: 1 },
    { scenario: "in-flight rejection on signal", stop: "caller", tokens: 0, unknownInputs: 1 },
    { scenario: "abort before late rejection", stop: "caller", tokens: 0, unknownInputs: 1 },
    { scenario: "in-flight rejection on signal", stop: "deadline", tokens: 0, unknownInputs: 1 },
    { scenario: "synchronous abort with already-fulfilled valid result", stop: "caller", tokens: 2, unknownInputs: 0 }
  ] as const)("preserves submission evidence without persistence on $scenario ($stop)", async ({
    scenario, stop, tokens, unknownInputs
  }) => {
    const environment = setup("one");
    if (stop === "deadline") vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const controller = new AbortController();
    const entered = deferred<void>();
    const gate = deferred<readonly SourceEmbeddingResult[]>();
    const failure = new Error("simulated inference rejected");
    const rejectOnAbort = vi.fn(() => gate.reject(failure));
    const accept = vi.spyOn(environment.lifecycle, "acceptVector");
    const observed = observeNativeReads();
    let runtimeSignal: AbortSignal | undefined;
    const binding = controlledBinding(environment.selection, (inputs, options) => {
      expect(environment.database.connection.inTransaction).toBe(false);
      runtimeSignal = options.signal;
      if (scenario === "synchronous abort then throw") {
        controller.abort(new Error("simulated caller cancellation"));
        throw failure;
      }
      if (scenario === "synchronous abort with already-fulfilled valid result") {
        controller.abort(new Error("simulated caller cancellation"));
        // Return the fulfilled promise directly, without an async wrapper/adoption step.
        return Promise.resolve(embedded(inputs));
      }
      if (scenario === "in-flight rejection on signal") {
        if (options.signal === undefined) throw new Error("expected inference cancellation signal");
        options.signal.addEventListener("abort", rejectOnAbort, { once: true });
      }
      entered.resolve(undefined);
      return gate.promise;
    });
    const pending = environment.backfill.step({ ...environment.input, binding, signal: controller.signal,
      deadline_ms: Date.now() + 1000 });
    if (scenario === "in-flight rejection on signal" || scenario === "abort before late rejection") {
      await entered.promise;
      expect(runtimeSignal?.aborted).toBe(false);
      expect(environment.vectors()).toEqual([]);
      if (stop === "deadline") await vi.advanceTimersByTimeAsync(1000);
      else controller.abort(new Error("simulated caller cancellation"));
    }
    const result = await pending;
    // One three-byte window was submitted; preparation costs 17 work plus one pending lookup.
    // Only the already-fulfilled valid attestation supplies its fixture's two observed tokens.
    expect(result).toMatchObject({ status: stop === "deadline" ? "deadline" : "cancelled",
      reason: stop === "deadline" ? "deadline_exceeded" : "caller_cancelled", accepted_vectors: 0,
      resources: { work: 18, native_accounting: "complete", sql_internal_work: "unknown",
        model_inputs_submitted: 1, model_input_bytes_submitted: 3, model_execution_work: "unknown",
        token_count_observed: tokens, inputs_without_token_count: unknownInputs } });
    expect(result.resources.native_bytes).toBe(observed.bytes() + 8);
    expect(binding.embedInputs.mock.calls.map(([inputs]) => inputs.map(input => input.text))).toEqual([["one"]]);
    expect(runtimeSignal?.aborted).toBe(true);
    expect(rejectOnAbort).toHaveBeenCalledTimes(scenario === "in-flight rejection on signal" ? 1 : 0);
    expect(accept).not.toHaveBeenCalled();
    expect(environment.vectors()).toEqual([]);
    if (scenario === "abort before late rejection") gate.reject(failure);
    // A real event-loop turn lets late rejection handlers and unhandledRejection detection run.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(unhandled).toEqual([]);
    expect(accept).not.toHaveBeenCalled();
    expect(environment.vectors()).toEqual([]);
    expect(result.resources).toMatchObject({ token_count_observed: tokens, inputs_without_token_count: unknownInputs });
    expect(environment.index.state(WORKSPACE)).toMatchObject({ active_generation_id: null });
    expect(environment.database.connection.inTransaction).toBe(false);
  });
});

describe("Source backfill cancellation and deadline persistence boundary", () => {
  it.each(["caller cancellation", "expired deadline"] as const)("keeps pre-submission %s distinct with no model or native cost", async stop => {
    const environment = setup();
    const controller = new AbortController();
    if (stop === "caller cancellation") controller.abort();
    const result = await environment.backfill.step({ ...environment.input, signal: controller.signal,
      deadline_ms: stop === "expired deadline" ? Date.now() - 1 : environment.input.deadline_ms });
    expect(result).toMatchObject({ status: stop === "caller cancellation" ? "cancelled" : "deadline",
      reason: stop === "caller cancellation" ? "caller_cancelled" : "deadline_exceeded", accepted_vectors: 0,
      resources: { work: 0, native_bytes: 0, native_accounting: "complete", model_inputs_submitted: 0,
        model_input_bytes_submitted: 0, model_execution_work: "not_run" } });
    expect(environment.input.binding.embedInputs).not.toHaveBeenCalled();
    expect(environment.vectors()).toEqual([]);
  });

  it.each(["caller cancellation", "deadline"] as const)(
    "retains an earlier vector and ignores a late noncooperative runtime result after %s", async stop => {
      const environment = setup("Alpha猫\nβeta!");
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const controller = new AbortController();
      const gate = deferred<readonly SourceEmbeddingResult[]>();
      const entered = deferred<void>();
      let lateInputs: readonly SourceEmbeddingInput[] = [];
      let runtimeSignal: AbortSignal | undefined;
      const binding = controlledBinding(environment.selection, async (inputs, options) => {
        expect(environment.database.connection.inTransaction).toBe(false);
        if (inputs[0]?.text === "Alpha猫") return embedded(inputs);
        lateInputs = inputs;
        runtimeSignal = options.signal;
        entered.resolve(undefined);
        return gate.promise; // Deliberately ignores AbortSignal, modelling a late transport/model result.
      });
      const observed = observeNativeReads();
      const pending = environment.backfill.step({ ...environment.input, binding, signal: controller.signal,
        deadline_ms: Date.now() + 1000 });
      await entered.promise;
      const accepted = environment.vectors();
      expect(accepted).toMatchObject([{ ordinal: 0, token_count: 2 }]);
      expect(binding.embedInputs).toHaveBeenCalledTimes(2);
      if (stop === "caller cancellation") controller.abort(new Error("fixture caller stopped"));
      else await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;
      expect(result).toMatchObject({ status: stop === "caller cancellation" ? "cancelled" : "deadline",
        reason: stop === "caller cancellation" ? "caller_cancelled" : "deadline_exceeded", accepted_vectors: 1,
        resources: { work: 25, native_accounting: "complete", model_inputs_submitted: 2, model_input_bytes_submitted: 15,
          token_count_observed: 2, inputs_without_token_count: 1, model_execution_work: "unknown" } });
      expect(result.resources.native_bytes).toBe(observed.bytes() + 16);
      expect(runtimeSignal?.aborted).toBe(true);
      expect(environment.vectors()).toEqual(accepted);
      gate.resolve(embedded(lateInputs));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(environment.vectors()).toEqual(accepted);
      expect(result.resources.inputs_without_token_count).toBe(1);
      expect(environment.index.state(WORKSPACE)).toMatchObject({ active_generation_id: null });
      vi.useRealTimers();
      const retry = controlledBinding(environment.selection);
      expect(await environment.backfill.step({ ...environment.input, binding: retry })).toMatchObject({ status: "root_complete", accepted_vectors: 1 });
      expect(retry.embedInputs.mock.calls.map(([inputs]) => inputs.map(input => input.text))).toEqual([["\nβeta!"]]);
      expect(environment.vectors()[0]).toEqual(accepted[0]);
    });
});
