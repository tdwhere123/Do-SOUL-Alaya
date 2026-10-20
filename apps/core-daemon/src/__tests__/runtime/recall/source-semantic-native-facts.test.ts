import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { SourceSemanticObserver, readSourceSemanticObservation } from "../../../runtime/recall-read-worker/source-semantic-observation.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { ORIGINAL, QUERY_BUDGET, withIndexedSources, workerCall } from "./source-semantic-index-acquisition.test-support.js";
import { builtWorkerUrl } from "./recall-read-worker-client-fixture.js";

const text = "Why delayed? Harbor opening was put off.";
const recall = { kind: "recall" as const, accepts_unreviewed_conditional_results: true as const,
  original_query: ORIGINAL, semantic_correspondences: [], budget: QUERY_BUDGET, output_byte_limit: 1_000_000 };

it("binds an actually ready SQLite index even when query embedding preparation is unwired", async () => {
  await withIndexedSources([{ id: "harbor", text, vector: [1, 0, 0] }], async fixture => {
    const client = createRecallReadWorkerClient({ databaseFilename: fixture.filename, workerCount: 1, workerUrl: builtWorkerUrl })!;
    try {
      await client.ready();
      const captured = await client.observeSourceSemantics({}, () => workerCall(client, recall));
      if (captured.outcome.status !== "success") throw captured.outcome.error;
      const row = captured.observations[0]!;
      expect(row.facts?.binding).toMatchObject({ operation: "recall", preparation: {
        status: "unavailable", reason: "embedding_preparation_unwired" }, index: {
        query_state: { status: "ready", binding: { generation_id: fixture.generation.generation_id, profile_id: fixture.selection.profile_id } },
        selection: fixture.selection } });
      expect(row.facts?.pool?.union).toMatchObject({ capture: "complete", source_count: 1,
        full_universe: "not_established", members: [expect.objectContaining({ source_id: "harbor" })] });
      expect(JSON.stringify(captured.outcome.value)).not.toContain("lease_reads");
      expect(fixture.prepareQuery).not.toHaveBeenCalled();
      expect(readSourceSemanticObservation(row, row.request_id).facts).toEqual(row.facts);
    } finally { await client.close(); }
  });
}, 60_000);

it("follows real prepare/query/pool/plan leases across native worker calls but not equal independent queries", async () => {
  await withIndexedSources(Array.from({ length: 6 }, (_, index) => ({ id: `harbor-${index}`, text, vector: [1, 0, 0] })), async fixture => {
    const client = await fixture.openClient();
    const prepared = await client.observeSourceSemantics({}, () => workerCall(client, {
      kind: "prepare_query", original_query: ORIGINAL, budget: QUERY_BUDGET }));
    if (prepared.outcome.status !== "success") throw prepared.outcome.error;
    const query_handle = prepared.outcome.value.query_handle!;
    const initial = await client.observeSourceSemantics({}, () => workerCall(client, { ...recall, query_handle }));
    if (initial.outcome.status !== "success") throw initial.outcome.error;
    const continuation = initial.outcome.value.index.continuation!;
    expect(continuation).not.toBeNull();
    const next = await client.observeSourceSemantics({}, () => workerCall(client, { ...recall, query_handle, continuation }));
    if (next.outcome.status !== "success") throw next.outcome.error;
    const prep = prepared.observations[0]!.facts!, first = initial.observations[0]!.facts!, second = next.observations[0]!.facts!;
    expect(first.pool).toMatchObject({ use: "reused", origin: prep.pool!.origin, union: prep.pool!.union });
    expect(first.lease_reads.find(row => row.kind === "query")?.origin)
      .toEqual(prep.lease_issues.find(row => row.kind === "query")!.origin);
    expect(second.lease_reads.find(row => row.kind === "library")).toMatchObject({
      origin: first.lease_issues.find(row => row.kind === "library")!.origin,
      pool_origin: prep.pool!.origin, plan_origin: first.lease_issues.find(row => row.kind === "library")!.plan_origin });
    expect(second.binding!.session_id).toBe(prep.binding!.session_id);
    expect(next.observations[0]!.events.filter(event => event.kind === "source_read")).toEqual([]);
    const independent = await client.observeSourceSemantics({}, () => workerCall(client, recall));
    expect(independent.observations[0]!.facts!.pool!.origin).not.toEqual(prep.pool!.origin);
    expect(independent.observations[0]!.facts!.lease_reads).toEqual([]);
    const otherClient = await fixture.openClient();
    const other = await otherClient.observeSourceSemantics({}, () => workerCall(otherClient, recall));
    expect(other.observations[0]!.facts!.binding!.session_id).not.toBe(prep.binding!.session_id);
  });
}, 60_000);

it("captures the finite actual union despite interrupted native reading and coalesces only chunk diagnostics", async () => {
  await withIndexedSources([{ id: "a-long", text: "Harbor ".repeat(8000), indexed: false },
    { id: "z-small", text, vector: [1, 0, 0] }], async fixture => {
    const client = await fixture.openClient();
    const captured = await client.observeSourceSemantics({}, () => workerCall(client, recall));
    if (captured.outcome.status !== "success") throw captured.outcome.error;
    const row = captured.observations[0]!;
    expect(row.facts?.pool?.union).toMatchObject({ capture: "complete", full_universe: "not_established" });
    expect(row.events.filter(event => event.kind === "observation_read_complete").map(event => event.data))
      .toContainEqual(expect.objectContaining({ source_id: "a-long", complete: false, stop: "budget" }));
    const physical = row.events.filter(event => event.kind === "source_read" &&
      (event.data as { purpose: string }).purpose === "observation");
    expect(physical.filter(event => (event.data as { source_id: string }).source_id === "a-long")).toHaveLength(1);
    expect(physical.map(event => event.data)).toContainEqual(expect.objectContaining({ source_id: "a-long",
      start: 0, read_calls: expect.any(Number), chronology: "source_extent_summary" }));
    expect(row.totals!.debit_work).toBe(captured.outcome.value.work.logical_work);
    expect(row.totals!.debit_bytes).toBe(captured.outcome.value.work.logical_memory_bytes);
    expect(row.facts!.encodings.some(encoding => encoding.encoder_invocations > 0)).toBe(true);
  });
}, 60_000);

it("keeps complete operation quantities and failures after per-meter detail is full", () => {
  const observer = new SourceSemanticObserver(7, { max_events: 0, max_bytes: 0 });
  const root = new SourceSemanticReadBudget({ work_units: 10_000, memory_bytes: 100_000 }, observer);
  const shared = { text: "same bytes" };
  for (let index = 0; index < 140; index++) {
    const child = root.child({ work_units: 100, memory_bytes: 1000 }, "planning");
    child.retain(shared, "shared retention"); root.absorb(child);
  }
  const failed = root.child({ work_units: 1, memory_bytes: 1000 }, "planning");
  expect(() => failed.retain(shared, "shared retention")).toThrow(); root.absorb(failed);
  const row = observer.finish("success");
  expect(row.facts!.operations).toHaveLength(128);
  expect(row.facts!.issues).toContain("operation_fact_limit");
  expect(row.facts!.operation_totals).toEqual({ complete: true, rows: [{ kind: "retain", count: 141,
    completed: 140, work: 281, bytes: 23624, same_object_count: 140, same_object_work: 279,
    same_object_bytes: 23456, uncompared_object_count: 0, identity_capture: "complete" }] });
  expect(root.spentWork).toBe(281); expect(root.spentBytes).toBe(23624);
  expect(readSourceSemanticObservation(row, 7).facts!.operation_totals).toEqual(row.facts!.operation_totals);
});

it("bounds object identity sampling without turning unobserved repetition into zero repetition", () => {
  const observer = new SourceSemanticObserver(7, { max_events: 0, max_bytes: 0 });
  const meter = new SourceSemanticReadBudget({ work_units: 10_000, memory_bytes: 100_000 }, observer);
  for (let index = 0; index < 140; index++) meter.retain({ index }, "retained objects");
  const uncaptured = { index: 141 };
  meter.retain(uncaptured, "retained objects"); meter.retain(uncaptured, "retained objects");
  const scanned = { value: "bounded" };
  meter.canonicalJsonLength(scanned); meter.canonicalJsonLength(scanned);
  const facts = observer.finish("success").facts!;
  expect(facts.operations).toHaveLength(2);
  expect(facts.operation_totals).toMatchObject({ complete: true, rows: [
    { kind: "retain", count: 142, completed: 142, same_object_count: 0, uncompared_object_count: 14, identity_capture: "partial" },
    { kind: "canonical_scan", count: 2, completed: 2, same_object_count: 1, uncompared_object_count: 0, identity_capture: "complete" }] });
  expect(facts.issues).toContain("operation_identity_limit");
});

it("separates proven same-object proxy accounting and exact re-encoding from merely repeated labels", () => {
  const observer = new SourceSemanticObserver(7, { max_events: 8, max_bytes: 2000 });
  const meter = new SourceSemanticReadBudget({ work_units: 10000, memory_bytes: 100000 }, observer);
  const shared = { text: "same bytes" };
  meter.retain(shared, "shared retention"); meter.retain(shared, "shared retention");
  meter.retain({ text: "same bytes" }, "same label"); meter.retain({ text: "different bytes" }, "same label");
  for (let index = 0; index < 40; index++) {
    observer.event("encoding_attempt", "selection", () => ({ offset: 0 }));
    observer.event("encoding_result", "selection", () => ({ offset: index, fits: true }));
    observer.facts.encodingInvocation("selection", "candidate_page");
    observer.facts.encoding("selection", "candidate_page", '{"preview":"same bytes"}', ["same bytes"]);
  }
  observer.event("source_read", "observation", () => ({ record_id: "root", start: 0, end: 20 }));
  const row = observer.finish("success");
  expect(row.dropped_events).toBe(0);
  expect(row.events.some(event => event.kind === "source_read")).toBe(true);
  expect(row.diagnostics).toMatchObject({ status: "overflow", omitted_events: expect.any(Number) });
  expect(row.facts!.operations.find(operation => operation.reason === "shared retention")).toMatchObject({ count: 2, same_object_count: 1 });
  expect(row.facts!.operations.find(operation => operation.reason === "same label")).toMatchObject({ count: 2, same_object_count: 0 });
  expect(row.facts!.encodings[0]).toMatchObject({ encoder_invocations: 40, count: 40,
    identical_complete_encodings: 39, repeated_component_bytes: 39 * Buffer.byteLength("same bytes") });
  expect(row.facts!.complete).toBe(true);
});
