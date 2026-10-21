import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { createSourceSemanticAccessPolicy, encodeSourceSemanticLibraryResponse } from "@do-soul/alaya-core";
import { sourceSemanticExecutionPhases } from "@do-soul/alaya-protocol";
import { attributeObservation } from "../../../../../bench-runner/src/runs/longmemeval-semantic/observation-attribution.js";
import { scoreConsumerMessageVisibility } from "../../../../../bench-runner/src/runs/longmemeval-semantic/message-visibility.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { acquireSourceSemanticIndex } from "../../../runtime/recall-read-worker/source-semantic-index-acquisition.js";
import { SourceSemanticObserver } from "../../../runtime/recall-read-worker/source-semantic-observation.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { WS, CLOCK, ORIGINAL, RAW, QUERY_BUDGET, SIMULATED_CONFIGURATION, digest, withIndexedSources, workerCall, type IndexFixture }
  from "./source-semantic-index-acquisition.test-support.js";

const recall = { kind: "recall" as const, accepts_unreviewed_conditional_results: true as const,
  original_query: ORIGINAL, semantic_correspondences: [], budget: QUERY_BUDGET, output_byte_limit: 1_000_000 };
function runtime(fixture: IndexFixture) { return { database: fixture.database } as RecallReadWorkerRuntime; }
function logical(work: { rss_bytes: number }) { const { rss_bytes: _rss, ...rest } = work; return rest; }
function events(row: { events: readonly { kind: string; data: unknown }[] }, kind: string) {
  return row.events.filter(event => event.kind === kind);
}
function acquire(fixture: IndexFixture, prepared: Awaited<ReturnType<IndexFixture["prepareQuery"]>>,
  observer?: SourceSemanticObserver, supplemental?: { navigation: string; vector: typeof prepared.vector }) {
  const meter = new SourceSemanticReadBudget(QUERY_BUDGET, observer);
  const metadataMeter = new SourceSemanticReadBudget(QUERY_BUDGET);
  const policy = createSourceSemanticAccessPolicy(ORIGINAL, undefined, "query-conditioned-v1", metadataMeter);
  return fixture.database.connection.transaction(() => acquireSourceSemanticIndex({
    runtime: runtime(fixture), workspace: WS, navigation: ORIGINAL, authorized: ["project"], meter, metadataMeter,
    vector: prepared.vector, supplemental, canonicalBytes: Buffer.byteLength(RAW), sourceCost: policy.sourceCost
  }))();
}

it("tags original and hint outside Core and keeps SQLite acquisition receipts identical with observer off", async () => {
  await withIndexedSources([{ id: "raw", text: RAW, vector: [1, 0, 0] }], async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: ORIGINAL, supplemental_navigation: "Harbor",
      signal: new AbortController().signal, remainingMs: () => 60_000 });
    const supplemental = { navigation: "Harbor", vector: prepared.supplemental!.vector };
    const off = acquire(fixture, prepared, undefined, supplemental);
    const observer = new SourceSemanticObserver(7, { max_events: 512, max_bytes: 262144 });
    const on = acquire(fixture, prepared, observer, supplemental);
    try {
      expect(on.phase.result).toEqual(off.phase.result);
      expect(on.nominations).toEqual(off.nominations);
      const row = observer.finish("success");
      const captured = events(row, "source_index_acquisition");
      expect(captured.some(event => (event.data as { invocation: string }).invocation === "original")).toBe(true);
      expect(captured.some(event => (event.data as { invocation: string }).invocation === "hint")).toBe(true);
      expect(captured.some(event => (event.data as { kind: string }).kind === "nomination_attempt")).toBe(true);
    } finally { off.releaseCanonical(); on.releaseCanonical(); }
  });
});

it("emits admitted, duplicate and nomination_limit facts through SQLite without changing budget debits", async () => {
  const sources = Array.from({ length: 18 }, (_, index) => ({
    id: `harbor-${index}`, text: `${ORIGINAL} harbor ${index}`, vector: [1, 0, 0] as const
  }));
  await withIndexedSources(sources, async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: ORIGINAL, signal: new AbortController().signal,
      remainingMs: () => 60_000 });
    const off = acquire(fixture, prepared);
    const observer = new SourceSemanticObserver(9, { max_events: 2048, max_bytes: 524288 });
    const on = acquire(fixture, prepared, observer);
    try {
      expect(on.phase.result).toEqual(off.phase.result);
      expect(on.phase.result?.resources).toEqual(off.phase.result?.resources);
      expect(on.phase.result?.accounting.nomination_limit).toBeGreaterThan(0);
      const row = observer.finish("success");
      const captured = events(row, "source_index_acquisition");
      const dispositions = new Set(captured.filter(event => (event.data as { kind: string }).kind === "nomination_attempt")
        .map(event => (event.data as { disposition: string }).disposition));
      expect(dispositions.has("admitted")).toBe(true);
      expect(dispositions.has("duplicate")).toBe(true);
      expect(dispositions.has("nomination_limit")).toBe(true);
      const overflow = new SourceSemanticObserver(10, { max_events: 0, max_bytes: 0 });
      const dropped = acquire(fixture, prepared, overflow);
      try {
        expect(dropped.phase.result).toEqual(off.phase.result);
        const overflowed = overflow.finish("success");
        expect(events(overflowed, "source_index_acquisition")).toEqual([]);
      } finally { dropped.releaseCanonical(); }
    } finally { off.releaseCanonical(); on.releaseCanonical(); }
  });
});

it("bounds candidate diagnostics without consuming later nomination and delivery capacity", () => {
  const observer = new SourceSemanticObserver(11, { max_events: 512, max_bytes: 262144 });
  let constructed = 0;
  for (let index = 0; index < 4096; index++) {
    observer.omitDiagnostic("source_index_original_vector_inspected");
    observer.event("source_index_acquisition", "observation", () => {
      constructed++;
      return { kind: "vector_ranked", rank: index + 1 };
    }, "source_index_original_vector_ranked");
  }
  for (const kind of ["source_index_acquisition", "source_index_routes", "source_read", "encoded_membership"]) {
    observer.event(kind, "observation", () => ({ kind: "nomination_attempt", disposition: "nomination_limit" }));
  }
  const row = observer.finish("success");
  expect(constructed).toBe(128);
  expect(row.events.slice(-4).map(event => event.kind)).toEqual([
    "source_index_acquisition", "source_index_routes", "source_read", "encoded_membership"]);
  expect(row.dropped_events).toBe(0);
  expect(row.diagnostics).toMatchObject({ status: "overflow", omitted_events: 8064,
    counts: { source_index_original_vector_inspected: 4096, source_index_original_vector_ranked: 4096 },
    omitted_counts: { source_index_original_vector_inspected: 4096, source_index_original_vector_ranked: 3968 } });
  const disabled = new SourceSemanticObserver(12, { max_events: 0, max_bytes: 0 });
  disabled.event("source_index_acquisition", "observation", () => { throw new Error("omitted payload constructed"); },
    "source_index_original_vector_ranked");
  expect(disabled.finish("success").issues).toEqual([]);
});

it("keeps SQLite/worker delivery and debit parity with acquisition observation off, on and overflowed", async () => {
  const sources = Array.from({ length: 18 }, (_, index) => ({
    id: `harbor-${index}`, text: `${ORIGINAL} harbor ${index}`, vector: [1, 0, 0] as const
  }));
  await withIndexedSources(sources, async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: ORIGINAL, signal: new AbortController().signal,
      remainingMs: () => 60_000 });
    fixture.prepareQuery.mockResolvedValue(prepared);
    const client = await fixture.openClient();
    const ordinary = await workerCall(client, recall);
    const observed = await client.observeSourceSemantics({}, () => workerCall(client, recall));
    expect(observed.status).toBe("available");
    if (observed.outcome.status !== "success") throw observed.outcome.error;
    const diagnostic = observed.outcome.value;
    expect(diagnostic.index.entries.map(row => row.target)).toEqual(ordinary.index.entries.map(row => row.target));
    expect(diagnostic.previews).toEqual(ordinary.previews);
    expect(logical(diagnostic.work)).toEqual(logical(ordinary.work));
    const stable = (value: typeof diagnostic.execution) => value === undefined ? undefined : JSON.parse(JSON.stringify(
      sourceSemanticExecutionPhases(value), (key, item: unknown) => key === "elapsed_ms" ? null : item));
    expect(stable(diagnostic.execution)).toEqual(stable(ordinary.execution));
    const ordinaryEncoded = encodeSourceSemanticLibraryResponse(ordinary);
    const diagnosticEncoded = encodeSourceSemanticLibraryResponse(diagnostic);
    if (ordinaryEncoded.operation !== "recall" || diagnosticEncoded.operation !== "recall") throw new Error("encoded recall expected");
    expect(diagnosticEncoded.results).toEqual(ordinaryEncoded.results);
    const row = observed.observations[0]!;
    const captured = events(row, "source_index_acquisition");
    expect(captured.some(event => (event.data as { invocation: string }).invocation === "original")).toBe(true);
    const dispositions = new Set(captured.filter(event => (event.data as { kind: string }).kind === "nomination_attempt")
      .map(event => (event.data as { disposition: string }).disposition));
    expect(dispositions.has("admitted")).toBe(true);
    expect(dispositions.has("duplicate")).toBe(true);
    expect(dispositions.has("nomination_limit")).toBe(true);
    const overflow = await client.observeSourceSemantics({ max_events: 0, max_bytes: 0 }, () => workerCall(client, recall));
    if (overflow.outcome.status !== "success") throw overflow.outcome.error;
    expect(overflow.outcome.value.index.entries.map(row => row.target)).toEqual(ordinary.index.entries.map(row => row.target));
    expect(logical(overflow.outcome.value.work)).toEqual(logical(ordinary.work));
    expect(events(overflow.observations[0]!, "source_index_acquisition")).toEqual([]);
  });
}, 60_000);

it("retains finalized ranks, attempts and delivery after more SQLite windows than default worker observation events", async () => {
  // 18 roots x 33 ASCII windows exceeds the real default 512-event envelope.
  // The simulated profile keeps this a provider-free boundary test, not a model benchmark.
  const configuration = { ...SIMULATED_CONFIGURATION,
    profile: { ...SIMULATED_CONFIGURATION.profile, window_bytes: 128 } };
  const sources = Array.from({ length: 18 }, (_, index) => ({ id: `harbor-${index}`,
    text: `${ORIGINAL} harbor ${index} `.padEnd(33 * 128, "x"), vector: [1, 0, 0] as const }));
  // Fund the existing scan envelope identically in both calls; observer limits remain default.
  const request = { ...recall, budget: { ...QUERY_BUDGET, work_units: 4_000_000, memory_bytes: 16_000_000 } };
  await withIndexedSources(sources, async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: ORIGINAL, signal: new AbortController().signal,
      remainingMs: () => 60_000 });
    fixture.prepareQuery.mockResolvedValue(prepared);
    // Fresh clients have the same retained-lease state: continuation issuance otherwise
    // charges each subsequent call for existing leases, independently of observation.
    const offClient = await fixture.openClient(), client = await fixture.openClient();
    const ordinary = await workerCall(offClient, request);
    const observed = await client.observeSourceSemantics({}, () => workerCall(client, request));
    if (observed.outcome.status !== "success") throw observed.outcome.error;
    const diagnostic = observed.outcome.value, row = observed.observations[0]!;
    const acquisition = sourceSemanticExecutionPhases(diagnostic.execution!).acquisition.result!;
    expect(acquisition.vector).toMatchObject({ inspected_windows: 594, invalid_windows: 0, completion: "complete" });
    expect(acquisition.accounting).toMatchObject({ admitted: 16, duplicate: 16, nomination_limit: 4 });
    expect(logical(diagnostic.work)).toEqual(logical(ordinary.work));
    expect(diagnostic.previews).toEqual(ordinary.previews);
    expect(diagnostic.index.entries.map(entry => entry.target)).toEqual(ordinary.index.entries.map(entry => entry.target));
    expect(diagnostic.execution).toEqual(ordinary.execution);
    expect(diagnostic.discovery.access).toEqual(ordinary.discovery.access);
    const encoded = encodeSourceSemanticLibraryResponse(diagnostic), offEncoded = encodeSourceSemanticLibraryResponse(ordinary);
    if (encoded.operation !== "recall" || offEncoded.operation !== "recall") throw new Error("encoded recall expected");
    expect(encoded.results).toEqual(offEncoded.results);
    const captured = events(row, "source_index_acquisition");
    expect(captured.filter(event => (event.data as { kind: string }).kind === "vector_inspected")).toEqual([]);
    expect(captured.filter(event => (event.data as { kind: string }).kind === "vector_ranked")).toHaveLength(18);
    expect(captured.filter(event => (event.data as { kind: string }).kind === "nomination_attempt")).toHaveLength(36);
    for (const kind of ["source_index_routes", "source_read", "frozen_membership", "encoded_membership"]) {
      expect(events(row, kind).length, kind).toBeGreaterThan(0);
    }
    expect(row.status).toBe("observed");
    expect(row.dropped_events).toBe(0);
    expect(row.events.length).toBeLessThanOrEqual(512);
    expect(row.overhead.event_json_bytes).toBeLessThanOrEqual(262144);
    expect(row.diagnostics).toMatchObject({ status: "overflow",
      omitted_counts: { source_index_original_vector_inspected: 594 } });

    const native = row.facts!.binding!, snapshot = digest("sealed-capacity-fixture");
    const call = { kind: "recall" as const, request_id: row.request_id, session_id: native.session_id,
      query_key: ORIGINAL, snapshot_id: snapshot, workspace_id: WS, as_of: CLOCK };
    const source = fixture.targets.find(target => target.source_id === "harbor-17")!;
    const { evidence_object_id: _evidence, kind: _kind, ...identity } = source.target;
    const answer = { unit: "published_body_utf8_bytes" as const, annotated_turns: 1, complete: true,
      spans: [{ session_index: 0, message_index: 0, source_id: source.source_id, target: identity, start: 4096, end: 4100 }] };
    const visibility = scoreConsumerMessageVisibility({ gold: answer, pages: [{ page: 1, status: "observed",
      reason: null, occupied_slots: encoded.results!.length, complete: true,
      continuation: diagnostic.index.continuation === null ? "none" : "present",
      intervals: encoded.results!.flatMap((result, position) => result.target.kind === "source_evidence"
        ? [{ rank: position + 1, target: result.target, start: 0, end: Buffer.byteLength(result.content_preview) }] : []),
      terminal_tail: { status: diagnostic.index.continuation === null ? "unknown" : "open",
        reason: diagnostic.index.continuation === null ? "native_access_or_computation_unresolved" : "native_continuation" } }] });
    expect(visibility.any_at_5).toEqual({ status: "miss", reason: null });
    const attribution = attributeObservation({ question_id: "capacity", k: 5, call, frames: [{ call, observation: row }],
      frozen_index: null, admitted_roots_complete: true, admitted_roots: new Map([[identity.root_id,
        { record_id: identity.root_id, source_id: source.source_id, snapshot_id: snapshot, identity }]]),
      answer_gold: answer, visibility });
    expect(attribution.observation).toMatchObject({ complete: false, progress_complete: true, finite_union_complete: true });
    expect(attribution.layer).toBe("L4");
    const message = attribution.messages[0]!;
    expect(message).toMatchObject({ candidate: "present", read: "whole", visibility: { delivery: "failed" } });
    expect(message.read_intervals.some(interval => interval.start <= 4096 && interval.end >= 4100)).toBe(true);
    expect(message.routes.find(route => route.route === "index:original:vector")?.unknowns)
      .toContainEqual({ stage: "nomination", reason: "vector_inspection_detail_unavailable" });
    expect(message.unknowns.some(unknown => unknown.reason === "causal_observation_incomplete"
      || unknown.reason === "observation_incomplete")).toBe(false);
  }, configuration);
}, 60_000);
