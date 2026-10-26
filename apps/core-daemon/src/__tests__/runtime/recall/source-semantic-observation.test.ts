import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { Worker } from "node:worker_threads";
import { encodeSourceSemanticLibraryResponse, type ConditionalFieldExecutionReceipt } from "@do-soul/alaya-core";
import { SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION, sourceSemanticExecutionPhases, SoulInterpretationResponseSchema } from "@do-soul/alaya-protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAlayaMcpServer } from "../../../mcp/server/mcp-server.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { SourceSemanticObserver, readSourceSemanticObservation, type SourceSemanticObservation }
  from "../../../runtime/recall-read-worker/source-semantic-observation.js";
import { observeSourceSemanticsForRuntime } from "../../../runtime/recall/source-semantic-observation.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { withAccessLibrary, ACCESS_BUDGET } from "./source-semantic-access.test-support.js";
import { CLOCK, WS, ORIGINAL, QUERY_BUDGET, withIndexedSources, workerCall }
  from "./source-semantic-index-acquisition.test-support.js";

const recall = { kind: "recall" as const, accepts_unreviewed_conditional_results: true as const,
  original_query: ORIGINAL, semantic_correspondences: [], budget: QUERY_BUDGET, output_byte_limit: 1_000_000 };
const text = "Why delayed? Harbor opening was put off.";
const events = (row: SourceSemanticObservation, kind: string) => row.events.filter(event => event.kind === kind);
function logical(work: { rss_bytes: number }) { const { rss_bytes: _rss, ...rest } = work; return rest; }

it("records actual debits once, separately from failed capacity, holds, release and parent absorption", () => {
  const observer = new SourceSemanticObserver(17, { max_events: 0, max_bytes: 0 });
  const parent = new SourceSemanticReadBudget({ work_units: 100, memory_bytes: 1000 }, observer);
  parent.charge(3, 10, "request admission");
  const child = parent.child({ work_units: 50, memory_bytes: 500 }, "observation");
  const release = child.hold({ work_units: 8, memory_bytes: 80 });
  child.charge(4, 20, "executed retention");
  expect(() => child.reserve(99, 999, "capacity only")).toThrow();
  release(); release();
  parent.absorb(child);
  observer.event("overflow", "test", () => { throw new Error("must not construct omitted metadata"); });
  const row = observer.finish("success");
  expect(row.status).toBe("overflow");
  expect(row.totals).toEqual({ debit_work: 7, debit_bytes: 30, absorb_work: 4, absorb_bytes: 20 });
  expect(row.costs).toContainEqual({ phase: "observation", reason: "capacity only", operation: "refused", count: 1, work: 99, bytes: 999 });
  expect(row.costs.find(cost => cost.operation === "release")?.count).toBe(1);
  expect(row.meters[0]!.spent).toEqual({ work_units: 7, memory_bytes: 30 });
  expect(row.meters[1]!.held).toEqual({ work_units: 0, memory_bytes: 0 });
  expect(row.aggregates_complete).toBe(true);
  expect(row.overhead.ipc_time).toBe("not_measured");
});

it("isolates capture failures and keeps aggregates after bounded metadata overflow", () => {
  const observer = new SourceSemanticObserver(1, { max_events: 2, max_bytes: 100 });
  const meter = new SourceSemanticReadBudget({ work_units: 1000, memory_bytes: 1000 }, observer);
  observer.event("broken", "test", () => { throw new Error("diagnostic failure"); });
  for (let index = 0; index < 300; index++) {
    meter.charge(1, 1, `reason-${index}`);
    observer.event("bounded", "test", () => ({ index }));
  }
  const row = observer.finish("success");
  expect(row.status).toBe("failure"); expect(row.execution).toBe("success");
  expect(row.totals!.debit_work).toBe(300); expect(row.totals!.debit_bytes).toBe(300);
  expect(row.costs.length).toBeLessThan(270);
  expect(row.events.length).toBeLessThanOrEqual(2);
  expect(row.overhead.event_json_bytes).toBeLessThanOrEqual(100);
  expect(row.issues).toContain("observer_capture_failed");
  expect(row.meter_totals?.complete).toBe(false);
  expect(row.facts?.operation_totals?.complete).toBe(false);
  expect(meter.spentWork).toBe(300);
  expect(readSourceSemanticObservation({ request_id: 2 }, 1).status).toBe("unavailable");
});

it("keeps SQLite/worker delivery and debit parity with diagnostics off and on, and retains real route/read/encoding events", async () => {
  await withIndexedSources([{ id: "harbor", text, vector: [1, 0, 0] }], async fixture => {
    // Byte-priced preparation receipts contain elapsed_ms. Pin the same independently
    // prepared simulated input on both calls instead of normalizing away a debit difference.
    const prepared = await fixture.prepareQuery({ navigation: ORIGINAL, signal: new AbortController().signal, remainingMs: () => 60_000 });
    fixture.prepareQuery.mockResolvedValue(prepared);
    const client = await fixture.openClient();
    const posts = vi.spyOn(Worker.prototype, "postMessage");
    const ordinary = await workerCall(client, recall);
    expect(posts.mock.calls.every(args => !("observation" in args[0]))).toBe(true);
    // An independent runtime starts with the same empty lease table. Reusing the
    // first runtime incurs real retention accounting for its already-issued lease.
    const observedClient = await fixture.openClient();
    const observed = await observedClient.observeSourceSemantics({}, () => workerCall(observedClient, recall));
    expect(observed.status).toBe("available");
    if (observed.outcome.status !== "success") throw observed.outcome.error;
    const diagnostic = observed.outcome.value;
    expect(diagnostic.index.entries.map(row => row.target)).toEqual(ordinary.index.entries.map(row => row.target));
    expect(diagnostic.previews).toEqual(ordinary.previews);
    expect(logical(diagnostic.work)).toEqual(logical(ordinary.work));
    // Preparation wall time and process RSS vary independently of deterministic debit/delivery.
    const stableExecution = (value: typeof diagnostic.execution) => value === undefined ? undefined : JSON.parse(JSON.stringify(sourceSemanticExecutionPhases(value),
      (key, item: unknown) => key === "elapsed_ms" ? null : item));
    expect(stableExecution(diagnostic.execution)).toEqual(stableExecution(ordinary.execution));
    const ordinaryEncoded = encodeSourceSemanticLibraryResponse(ordinary), diagnosticEncoded = encodeSourceSemanticLibraryResponse(diagnostic);
    if (ordinaryEncoded.operation !== "recall" || diagnosticEncoded.operation !== "recall") throw new Error("encoded recall expected");
    expect(diagnosticEncoded.results).toEqual(ordinaryEncoded.results);
    expect(JSON.stringify(diagnostic)).not.toContain("debit_work");
    const row = observed.observations[0]!;
    expect(row.status).toBe("observed"); expect(row.execution).toBe("success");
    expect(row.totals!.debit_work).toBe(diagnostic.work.logical_work);
    expect(row.totals!.debit_bytes).toBe(diagnostic.work.logical_memory_bytes);
    expect(row.totals!.absorb_work).toBeGreaterThan(0);
    expect(events(row, "field_nomination")[0]?.data).toMatchObject({
      result: { nominations: [expect.objectContaining({ vector: expect.objectContaining({ rank: 1 }) })] },
      beyond_observed_prefix: "unknown_not_nomination_limit" });
    expect(row.facts?.pool?.union.members).toContainEqual(expect.objectContaining({ source_id: "harbor" }));
    expect(events(row, "source_read").some(event => (event.data as { purpose: string }).purpose === "observation")).toBe(true);
    expect(events(row, "source_read").some(event => (event.data as { purpose: string }).purpose === "payload")).toBe(true);
    expect(events(row, "encoding_result").map(event => event.data)).toContainEqual(expect.objectContaining({ fits: true }));
    expect(events(row, "encoding_attempt").length).toBeGreaterThan(0);
    expect(events(row, "encoded_membership")[0]?.data).toMatchObject({
      results: [expect.objectContaining({ preview_bytes: Buffer.byteLength(text) })] });
    if (diagnostic.protocol_version !== 12) throw new Error("field recall required");
    const receipt = diagnostic.field_execution_receipt as ConditionalFieldExecutionReceipt | undefined;
    expect(receipt?.actual?.phases.index.budget_work).toBeGreaterThan(0);
    expect(diagnostic.work.native_work).toBeGreaterThan(0);
    expect(diagnostic.work.index_work).toBeGreaterThan(0);
    expect(diagnostic.work.native_accounting).toBe("partial");
    const transferred = events(row, "field_execution_cost")[0]!.data as { budget_work: number };
    expect(transferred.budget_work).toBeGreaterThan(Object.values(receipt!.actual!.phases)
      .reduce((sum, phase) => sum + phase.budget_work!, 0));
    expect(diagnostic.work.logical_work).toBeGreaterThan(transferred.budget_work);
    expect(receipt!.actual!).not.toHaveProperty("budget_work");
    // The later acknowledgment's three-read pin is reserved, not yet incurred.
    expect(diagnostic.request_budget).toBeDefined();
    expect(diagnostic.work.logical_work! + 3).toBeLessThanOrEqual(diagnostic.request_budget!.work_units);
    expect(row.overhead.capture_ms).toBeGreaterThan(0);
    expect(row.overhead.ipc_bytes).toBeNull(); // Actual structured-clone transport is not measured.
    expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(1_000_000);
  });
}, 60_000);

it("keeps successful SQLite/worker recall and exact debits when route observation capture fails", async () => {
  await withIndexedSources([{ id: "harbor", text, vector: [1, 0, 0] }], async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: ORIGINAL, signal: new AbortController().signal, remainingMs: () => 60_000 });
    fixture.prepareQuery.mockResolvedValue(prepared);
    const ordinary = await workerCall(await fixture.openClient(), recall);
    const client = createRecallReadWorkerClient({ databaseFilename: fixture.filename, workerCount: 1,
      prepareSourceQuery: fixture.prepareQuery, workerUrl: new URL("./source-semantic-observation-failure-worker-fixture.mjs", import.meta.url) })!;
    try {
      await client.ready();
      const captured = await client.observeSourceSemantics({}, () => workerCall(client, recall));
      if (captured.outcome.status !== "success") throw captured.outcome.error;
      expect(captured.observations[0]).toMatchObject({ status: "failure", execution: "success", issues: ["observer_capture_failed"] });
      expect(captured.outcome.value.index.entries.map(row => row.target)).toEqual(ordinary.index.entries.map(row => row.target));
      expect(captured.outcome.value.previews).toEqual(ordinary.previews);
      expect(logical(captured.outcome.value.work)).toEqual(logical(ordinary.work));
      expect(captured.observations[0]!.totals!.debit_work).toBe(ordinary.work.logical_work);
    } finally { await client.close(); }
  });
}, 60_000);

it("attributes concurrent scopes, bounded overflow, known worker rejections and later successes independently", async () => {
  await withIndexedSources([{ id: "harbor", text, vector: [1, 0, 0] }], async fixture => {
    const client = await fixture.openClient();
    const [overflow, failure, normal] = await Promise.all([
      client.observeSourceSemantics({ max_events: 1, max_bytes: 128 }, () => workerCall(client, recall)),
      client.observeSourceSemantics({}, () => workerCall(client, { kind: "prepare_source", source_id: "absent", budget: QUERY_BUDGET })),
      client.observeSourceSemantics({}, () => workerCall(client, { ...recall, original_query: "Where is the harbor?" }))
    ]);
    expect(overflow.outcome.status).toBe("success");
    expect(overflow.observations[0]?.status).toBe("overflow");
    expect(overflow.observations[0]?.totals?.debit_work).toBeGreaterThan(0);
    expect(failure.outcome.status).toBe("failure");
    expect(failure.observations[0]).toMatchObject({ status: "partial", execution: "failure" });
    expect(normal.outcome.status).toBe("success");
    expect(normal.observations[0]?.status).toBe("observed");
    expect(new Set([overflow, failure, normal].map(run => run.observations[0]!.request_id)).size).toBe(3);
    expect(overflow.observations[0]!.events.length).toBeLessThanOrEqual(1);
    expect(events(failure.observations[0]!, "encoding_attempt")).toEqual([]);
    expect(events(normal.observations[0]!, "encoded_membership")).toHaveLength(1);
    await expect(workerCall(client, recall)).resolves.toMatchObject({ kind: "recall" });
  });
}, 60_000);

it.each(["success", "failure"] as const)("keeps a returned observation snapshot stable after %s with detached native work", async outcome => {
  await withIndexedSources([{ id: "harbor", text, vector: [1, 0, 0] }], async fixture => {
    const client = await fixture.openClient();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let late!: Promise<unknown>;
    const captured = await client.observeSourceSemantics({}, async () => {
      late = (async () => { await gate; return workerCall(client, recall); })();
      if (outcome === "failure") throw new Error("job ended before detached work");
      return "finished";
    });
    expect(captured.outcome.status).toBe(outcome);
    expect(captured.observations).toEqual([]);
    release();
    await late;
    expect(captured.observations).toEqual([]);
    expect(captured.status).toBe("not_observed");
  });
}, 60_000);

it("propagates opt-in scope through actual in-memory MCP transport for concurrent jobs without changing MCP output", async () => {
  await withIndexedSources([{ id: "harbor", text, vector: [1, 0, 0] }], async fixture => {
    const native = await fixture.openClient();
    const server = createAlayaMcpServer({ memoryToolHandler: createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK,
      sourceSemanticsPort: native.sourceSemanticsPort }), contextProvider: () => ({ workspaceId: WS, runId: "run-1",
      agentTarget: "codex", sessionId: "observed-mcp" }) });
    const mcp = new Client({ name: "observation-regression", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await mcp.connect(clientTransport);
      const args = { operation: "recall", accepts_unreviewed_conditional_results: true, original_query: ORIGINAL,
        semantic_correspondences: [], budget: QUERY_BUDGET, output_byte_limit: 1_000_000,
        authorized_scopes: { mode: "named", scopes: ["project"] } };
      const [indexed, canonical] = await Promise.all([
        native.observeSourceSemantics({}, () => mcp.callTool({ name: "soul.interpretation", arguments: args })),
        native.observeSourceSemantics({}, () => mcp.callTool({ name: "soul.interpretation", arguments: { ...args, access_policy: "canonical-v1" } }))
      ]);
      for (const captured of [indexed, canonical]) {
        if (captured.outcome.status !== "success") throw captured.outcome.error;
        expect(captured.outcome.value.isError).not.toBe(true);
        const envelope = captured.outcome.value.structuredContent as { ok: boolean; output: unknown };
        expect(envelope.ok).toBe(true);
        const output = SoulInterpretationResponseSchema.parse(envelope.output);
        if (output.operation !== "recall") throw new Error("MCP recall expected");
        expect(captured.observations).toHaveLength(2);
        expect(events(captured.observations[1]!, "delivery_settlement")).toHaveLength(1);
        expect(captured.observations[1]!.execution).toBe("success");
        expect(captured.observations[0]!.totals!.debit_work).toBe(output.work.logical_work);
        expect(JSON.stringify(envelope)).not.toContain("debit_work");
      }
      expect(events(indexed.observations[0]!, "field_nomination")).toHaveLength(1);
      expect(events(canonical.observations[0]!, "field_nomination")).toHaveLength(1);
      expect(indexed.observations[0]!.request_id).not.toBe(canonical.observations[0]!.request_id);
      expect(indexed.observations[0]!.totals!.debit_work).not.toBe(canonical.observations[0]!.totals!.debit_work);
    } finally { await mcp.close(); await server.close(); }
  });
}, 60_000);

it("preserves leased runtime identity across observed preparation, recall and frozen continuation", async () => {
  await withIndexedSources(Array.from({ length: 6 }, (_, index) => ({ id: `harbor-${index}`, text, vector: [1, 0, 0] })), async fixture => {
    const client = await fixture.openClient();
    const pageBudget = QUERY_BUDGET;
    const prepared = await client.observeSourceSemantics({}, () => workerCall(client, {
      kind: "prepare_query", original_query: ORIGINAL, budget: pageBudget }));
    if (prepared.outcome.status !== "success") throw prepared.outcome.error;
    const query_handle = prepared.outcome.value.query_handle;
    expect(query_handle).toBeDefined();
    const delivered = await client.observeSourceSemantics({}, () => workerCall(client, { ...recall, budget: pageBudget, query_handle }));
    if (delivered.outcome.status !== "success") throw delivered.outcome.error;
    expect(events(delivered.observations[0]!, "pool_reuse")).toHaveLength(1);
    expect(events(delivered.observations[0]!, "source_index_routes")).toHaveLength(0);
    const page = delivered.outcome.value;
    if (page.protocol_version !== SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION || page.preparation_id === undefined
      || page.previews === undefined) {
      throw new Error("expected a prepared shared field page");
    }
    await client.sourceSemanticsPort!.acknowledge!(page.preparation_id, page.index, new Map(Object.entries(page.previews)));
    const continuation = page.index.continuation;
    expect(continuation).not.toBeNull();
    const next = await client.observeSourceSemantics({}, () => workerCall(client, { ...recall, budget: pageBudget, query_handle, continuation: continuation! as never }));
    if (next.outcome.status !== "success") throw next.outcome.error;
    // The shared field emits all six slots under this large page allowance;
    // its frozen continuation proves the empty tail without rediscovery.
    expect(delivered.outcome.value.index.entries).toHaveLength(6);
    expect(next.outcome.value.index.entries).toHaveLength(0);
    expect(next.outcome.value.index.completeness).toMatchObject({ logical_index: "complete", observed_coverage: "complete" });
    expect(events(next.observations[0]!, "source_read").filter(event =>
      (event.data as { purpose: string }).purpose === "observation")).toHaveLength(0);
    expect(events(next.observations[0]!, "encoding_attempt")).toHaveLength(1);
  });
}, 60_000);

it("records a real interrupted SQLite source observation and refused native encoding without inventing an unread-tail rank", async () => {
  await withIndexedSources([{ id: "a-long", text: "Harbor ".repeat(8000), indexed: false },
    { id: "z-small", text, vector: [1, 0, 0] }], async fixture => {
    const client = await fixture.openClient();
    const result = await client.observeSourceSemantics({}, () => workerCall(client, {
      kind: "prepare_query", original_query: ORIGINAL, budget: QUERY_BUDGET }));
    if (result.outcome.status !== "success") throw result.outcome.error;
    const observed = result.observations[0]!;
    expect(events(observed, "observation_read_complete").map(event => event.data)).toContainEqual(expect.objectContaining({
      source_id: "a-long", complete: false, resource_limited: true, stop: "budget" }));
    expect(observed.costs.some(cost => cost.operation === "refused" && cost.phase === "observation")).toBe(true);
    const narrow = await client.observeSourceSemantics({}, () => workerCall(client, { ...recall, output_byte_limit: 1024 }));
    expect(events(narrow.observations[0]!, "encoding_result").map(event => event.data)).toContainEqual(expect.objectContaining({ fits: false }));
    expect(events(narrow.observations[0]!, "encoding_attempt").length).toBeGreaterThan(0);
    expect(narrow.observations[0]!.totals!.debit_work).toBeGreaterThan(0);
  });
}, 60_000);

it("distinguishes physical verification reads from reusing their bytes for a source beyond the catalog prefix", async () => {
  await withAccessLibrary([...Array.from({ length: 512 }, (_, index) => ({ id: `a-${String(index).padStart(3, "0")}`,
    text: "Private granite.", scope: "global_core" as const })),
    { id: "z-harbor", text: "Harbor opening was delayed.", reading: "Harbor" }], async fixture => {
    const client = createRecallReadWorkerClient({ databaseFilename: fixture.filename, workerCount: 1 })!;
    try {
      await client.ready();
      const observed = await client.observeSourceSemantics({}, () => workerCall(client, { kind: "prepare_query",
        original_query: "Harbor", access_policy: "canonical-v1", budget: ACCESS_BUDGET }));
      if (observed.outcome.status !== "success") throw observed.outcome.error;
      const row = observed.observations[0]!;
      expect(row.status).toBe("observed");
      expect(events(row, "source_read").map(event => event.data)).toContainEqual(expect.objectContaining({ purpose: "verification", source_id: "z-harbor" }));
      expect(events(row, "verification_reuse").map(event => event.data)).toContainEqual(expect.objectContaining({ source_id: "z-harbor", start: 0 }));
      expect(events(row, "union_admission").map(event => event.data)).toContainEqual(expect.objectContaining({ route: "interpretation_verification", source_id: "z-harbor" }));
      expect(row.totals!.debit_work).toBe(observed.outcome.value.work.logical_work);
    } finally { await client.close(); }
  });
}, 60_000);

it("retains request attribution when a worker exits with an in-flight observation", async () => {
  // Synthetic waiting transport only; native SQLite/decision evidence is covered above.
  const client = createRecallReadWorkerClient({ databaseFilename: "observation.capture", workerCount: 1, requestTimeoutMs: 5000,
    workerUrl: new URL("./source-semantic-query-worker-fixture.mjs", import.meta.url) })!;
  try {
    await client.ready();
    const post = Worker.prototype.postMessage;
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args: Parameters<typeof post>) {
      const result = post.apply(this, args);
      if ((args[0] as { operation?: string }).operation === "conditionalField.sourceSemantics") void this.terminate();
      return result;
    });
    const observed = await client.observeSourceSemantics({}, () => client.sourceSemanticsPort!.execute({
      workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] },
      request: { kind: "prepare_query", original_query: ORIGINAL, access_hint: "fixture-hold", budget: QUERY_BUDGET } }));
    expect(observed.outcome.status).toBe("failure");
    expect(observed.observations).toHaveLength(1);
    expect(observed.observations[0]).toMatchObject({ status: "unavailable", execution: "unknown", totals: null,
      overhead: { capture_ms: null, ipc_bytes: null }, issues: ["worker_execution_or_transport_unknown"] });
  } finally { await client.close(); }
});

it("does not interpret an unbound runtime or a call without source dispatch as an observed empty recall", async () => {
  expect(await observeSourceSemanticsForRuntime({}, {}, async () => "ordinary")).toEqual({
    outcome: { status: "success", value: "ordinary" }, observations: [], status: "unavailable" });
  await withIndexedSources([{ id: "harbor", text, vector: [1, 0, 0] }], async fixture => {
    const client = await fixture.openClient();
    expect(await client.observeSourceSemantics({}, async () => "no dispatch")).toEqual({
      outcome: { status: "success", value: "no dispatch" }, observations: [], status: "not_observed" });
  });
});
