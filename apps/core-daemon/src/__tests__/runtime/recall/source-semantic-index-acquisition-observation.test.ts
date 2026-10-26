import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { createSourceSemanticAccessPolicy, encodeSourceSemanticLibraryResponse, SourceIndexAcquisition } from "@do-soul/alaya-core";
import { SqliteSourceIndexRepository } from "@do-soul/alaya-storage";
import { sourceSemanticExecutionPhases, SourceSemanticResourceExhausted, SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { attributeObservation } from "../../../../../bench-runner/src/runs/longmemeval-semantic/observation-attribution.js";
import { scoreConsumerMessageVisibility } from "../../../../../bench-runner/src/runs/longmemeval-semantic/message-visibility.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { acquireSourceSemanticIndex } from "../../../runtime/recall-read-worker/source-semantic-index-acquisition.js";
import { SourceSemanticObserver, readSourceSemanticObservation } from "../../../runtime/recall-read-worker/source-semantic-observation.js";
import { readSourceIndexSnapshotFact } from "../../../runtime/recall-read-worker/source-index-measurement.js";
import { sourceSemanticRevision } from "../../../runtime/recall-read-worker/source-semantic-leases.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { WS, CLOCK, ORIGINAL, RAW, QUERY_BUDGET, SIMULATED_CONFIGURATION, digest, withIndexedSources, workerCall, type IndexFixture }
  from "./source-semantic-index-acquisition.test-support.js";

const recall = { kind: "recall" as const, accepts_unreviewed_conditional_results: true as const,
  original_query: ORIGINAL, semantic_correspondences: [], budget: QUERY_BUDGET, output_byte_limit: 1_000_000 };
function runtime(fixture: IndexFixture) { return { database: fixture.database } as RecallReadWorkerRuntime; }
function logical(work: { rss_bytes: number }) { const { rss_bytes: _rss, ...rest } = work; return rest; }
function bindAcquisition(fixture: IndexFixture, observer?: SourceSemanticObserver) {
  // Bind the direct native call after acquisition pinned this caller-owned snapshot,
  // just as the worker entry does; an unbound event must not become bench evidence.
  observer?.context(fixture.database, () => ({ operation: "recall", workspace_id: WS, as_of: CLOCK,
    preparation: null, snapshot_revision: sourceSemanticRevision(runtime(fixture)),
    index: readSourceIndexSnapshotFact(fixture.database, WS) }));
}
function jsonObservation(row: ReturnType<SourceSemanticObserver["finish"]>) {
  return readSourceSemanticObservation(JSON.parse(JSON.stringify(row)), row.request_id);
}
function events(row: { events: readonly { kind: string; data: unknown }[] }, kind: string) {
  return row.events.filter(event => event.kind === kind);
}
function acquire(fixture: IndexFixture, prepared: Awaited<ReturnType<IndexFixture["prepareQuery"]>>,
  observer?: SourceSemanticObserver, supplemental?: { navigation: string; vector: typeof prepared.vector }) {
  const meter = new SourceSemanticReadBudget(QUERY_BUDGET, observer);
  const metadataMeter = new SourceSemanticReadBudget(QUERY_BUDGET);
  const policy = createSourceSemanticAccessPolicy(ORIGINAL, undefined, "query-conditioned-v1", metadataMeter);
  return fixture.database.connection.transaction(() => {
    const acquired = acquireSourceSemanticIndex({
      runtime: runtime(fixture), workspace: WS, navigation: ORIGINAL, authorized: ["project"], meter, metadataMeter,
      vector: prepared.vector, supplemental, canonicalBytes: Buffer.byteLength(RAW), sourceCost: policy.sourceCost
    });
    bindAcquisition(fixture, observer);
    return acquired;
  })();
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

it("transports native stale and resource_limited admission through observer JSON into the bench route", async () => {
  const sources = [
    { id: "harbor-0", text: `${ORIGINAL} harbor 0`, vector: [1, 0, 0] as const },
    { id: "harbor-1", text: `${ORIGINAL} harbor 1`, vector: [1, 0, 0] as const }
  ];
  await withIndexedSources(sources, async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: ORIGINAL, signal: new AbortController().signal,
      remainingMs: () => 60_000 });
    const admit = SqliteSourceIndexRepository.prototype.admitQueryCandidate;
    let ready = 0;
    vi.spyOn(SqliteSourceIndexRepository.prototype, "admitQueryCandidate").mockImplementation(function (
      this: SqliteSourceIndexRepository, source, binding, budget) {
      const native = admit.call(this, source, binding, budget);
      if (native.status !== "ready") return native;
      ready += 1;
      if (ready === 1) return { status: "stale", reason: "target_identity", resources: native.resources };
      return { status: "resource_limited", reason: "read_budget", phase: "source currentness and erase guard",
        resources: native.resources };
    });
    const observer = new SourceSemanticObserver(13, { max_events: 512, max_bytes: 262144 });
    const on = acquire(fixture, prepared, observer);
    try {
      const row = jsonObservation(observer.finish("success"));
      const attempts = events(row, "source_index_acquisition")
        .map(event => event.data as Record<string, unknown>)
        .filter(data => data.kind === "nomination_attempt");
      expect(attempts.some(data => data.disposition === "stale" && data.admission !== undefined
        && (data.admission as { status: string; reason: string }).status === "stale"
        && (data.admission as { reason: string }).reason === "target_identity")).toBe(true);
      expect(attempts.some(data => data.disposition === "resource_refused"
        && (data.admission as { status: string; reason: string; phase: string }).status === "resource_limited"
        && (data.admission as { reason: string }).reason === "read_budget"
        && (data.admission as { phase: string }).phase === "source currentness and erase guard")).toBe(true);
      const stale = attempts.find(data => data.disposition === "stale");
      expect(stale?.target).toEqual(expect.objectContaining({ workspace_id: WS }));
      const identity = stale!.target as typeof fixture.targets[number]["target"];
      const source = fixture.targets.find(target => target.target.root_id === identity.root_id)!;
      const snapshot = digest("observer-json-admission");
      const call = { kind: "recall" as const, request_id: row.request_id, session_id: row.facts!.binding!.session_id,
        query_key: ORIGINAL, snapshot_id: snapshot, workspace_id: WS, as_of: CLOCK };
      const { evidence_object_id: _evidence, kind: _kind, ...gold } = source.target;
      const answer = { unit: "published_body_utf8_bytes" as const, annotated_turns: 1, complete: true,
        spans: [{ session_index: 0, message_index: 0, source_id: source.source_id, target: gold, start: 0, end: 4 }] };
      const visibility = scoreConsumerMessageVisibility({ gold: answer, pages: [{ page: 1, status: "observed",
        reason: null, occupied_slots: 0, complete: true, continuation: "none", intervals: [],
        terminal_tail: { status: "unknown", reason: "native_access_or_computation_unresolved" } }] });
      const attribution = attributeObservation({ question_id: "admission-json", k: 5, call,
        frames: [{ call, observation: row }], frozen_index: null, admitted_roots_complete: true,
        admitted_roots: new Map(), answer_gold: answer, visibility });
      const projected = attribution.messages[0]!.routes.flatMap(route => route.native?.attempts ?? []);
      expect(projected.some(attempt => attempt.disposition === "stale" && attempt.admission?.status === "stale"
        && attempt.admission.reason === "target_identity" && attempt.admission.phase === undefined)).toBe(true);
      expect(projected.some(attempt => attempt.disposition === "resource_refused"
        && attempt.admission?.status === "resource_limited" && attempt.admission.reason === "read_budget"
        && attempt.admission.phase === "source currentness and erase guard")).toBe(true);
      expect(attribution.messages[0]?.routes.every(route => route.native === null || route.native.lexical_window === null)).toBe(true);
    } finally { on.releaseCanonical(); }
  });
});

it("keeps both SQLite unicode61 and trigram lexical facts after vector interleave consumes the attempt cap", async () => {
  const navigation = "alpha 部署流水线";
  const goldText = "alpha 部署流水线配置说明 Harbor opening was put off.";
  const sources = [
    { id: "gold-mixed", text: goldText, vector: [1, 0, 0] as const },
    { id: "harbor-0", text: `${ORIGINAL} harbor 0`, vector: [1, 0, 0] as const },
    { id: "harbor-1", text: `${ORIGINAL} harbor 1`, vector: [1, 0, 0] as const }
  ];
  const nominate = SourceIndexAcquisition.prototype.nominateWithWitness;
  vi.spyOn(SourceIndexAcquisition.prototype, "nominateWithWitness").mockImplementation(function (
    this: SourceIndexAcquisition, input, admitScope, view, observer) {
    return nominate.call(this, { ...input, allowance: { ...input.allowance, max_attempts: 2, max_roots: 2 } },
      admitScope, view, observer);
  });
  await withIndexedSources(sources, async fixture => {
    const prepared = await fixture.prepareQuery({ navigation, signal: new AbortController().signal, remainingMs: () => 60_000 });
    const observer = new SourceSemanticObserver(21, { max_events: 2048, max_bytes: 524288 });
    const meter = new SourceSemanticReadBudget(QUERY_BUDGET, observer);
    const metadataMeter = new SourceSemanticReadBudget(QUERY_BUDGET);
    const policy = createSourceSemanticAccessPolicy(navigation, undefined, "query-conditioned-v1", metadataMeter);
    const on = fixture.database.connection.transaction(() => {
      const acquired = acquireSourceSemanticIndex({
        runtime: runtime(fixture), workspace: WS, navigation, authorized: ["project"], meter, metadataMeter,
        vector: prepared.vector, canonicalBytes: Buffer.byteLength(goldText), sourceCost: policy.sourceCost
      });
      bindAcquisition(fixture, observer);
      return acquired;
    })();
    try {
      const row = jsonObservation(observer.finish("success"));
      const source = fixture.targets.find(target => target.source_id === "gold-mixed")!;
      const lexicalHits = events(row, "source_index_acquisition")
        .map(event => event.data as Record<string, unknown>)
        .filter(data => data.kind === "lexical_candidate"
          && (data.target as { root_id?: string } | undefined)?.root_id === source.target.root_id);
      expect(lexicalHits.map(data => data.lane).sort()).toEqual(["trigram", "unicode61"]);
      expect(lexicalHits).toHaveLength(2);
      const receipt = (events(row, "source_index_routes")[0]?.data as {
        original?: { result?: { nominations?: readonly {
          source: { target: { root_id: string } }; lexical: readonly Record<string, unknown>[] }[];
          accounting?: { attempted: number } } } } | undefined)?.original?.result;
      const receiptLexical = receipt?.nominations?.find(row => row.source.target.root_id === source.target.root_id)?.lexical ?? [];
      expect(receipt?.accounting?.attempted).toBe(2);
      expect(receiptLexical).toHaveLength(1);
      const snapshot = digest("multi-lane-collector-json");
      const call = { kind: "recall" as const, request_id: row.request_id, session_id: row.facts!.binding!.session_id,
        query_key: navigation, snapshot_id: snapshot, workspace_id: WS, as_of: CLOCK };
      const { evidence_object_id: _evidence, kind: _kind, ...gold } = source.target;
      const answer = { unit: "published_body_utf8_bytes" as const, annotated_turns: 1, complete: true,
        spans: [{ session_index: 0, message_index: 0, source_id: source.source_id, target: gold, start: 0, end: 5 }] };
      const visibility = scoreConsumerMessageVisibility({ gold: answer, pages: [{ page: 1, status: "observed",
        reason: null, occupied_slots: 0, complete: true, continuation: "none", intervals: [],
        terminal_tail: { status: "unknown", reason: "native_access_or_computation_unresolved" } }] });
      const attribution = attributeObservation({ question_id: "multi-lane-json", k: 5, call,
        frames: [{ call, observation: row }], frozen_index: null, admitted_roots_complete: true,
        admitted_roots: new Map([[gold.root_id, { record_id: gold.root_id, source_id: source.source_id,
          snapshot_id: snapshot, identity: gold }]]), answer_gold: answer, visibility });
      const projected = attribution.messages[0]!.routes.find(route => route.route === "index:original:lexical")
        ?.native?.lexical_ranks ?? [];
      const keyOf = (value: { rank?: unknown; lane?: unknown; lane_rank?: unknown; bm25?: unknown }) =>
        `${String(value.lane)}:${String(value.rank)}:${String(value.lane_rank)}:${String(value.bm25)}`;
      expect(new Set(projected.map(value => keyOf(value)))).toEqual(new Set([
        ...lexicalHits, ...receiptLexical].map(value => keyOf(value))));
      expect(attribution.messages[0]!.routes.find(route => route.route === "index:original:lexical")
        ?.nomination).not.toBe("failed");
    } finally { on.releaseCanonical(); }
  });
});

it("preserves a thrown resource-exhaustion phase on the collector JSON route attempt without inventing native admission", async () => {
  const sources = [
    { id: "harbor-0", text: `${ORIGINAL} harbor 0`, vector: [1, 0, 0] as const },
    { id: "harbor-1", text: `${ORIGINAL} harbor 1`, vector: [1, 0, 0] as const }
  ];
  const phase = "source nomination reference retention";
  const charge = SourceSemanticResourceLedger.prototype.charge;
  vi.spyOn(SourceSemanticResourceLedger.prototype, "charge").mockImplementation(
    function (this: SourceSemanticResourceLedger, work, bytes, reason) {
      if (reason === phase) throw new SourceSemanticResourceExhausted(phase);
      return charge.call(this, work, bytes, reason);
    });
  await withIndexedSources(sources, async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: ORIGINAL, signal: new AbortController().signal,
      remainingMs: () => 60_000 });
    const observer = new SourceSemanticObserver(22, { max_events: 512, max_bytes: 262144 });
    const on = acquire(fixture, prepared, observer);
    try {
      const row = jsonObservation(observer.finish("success"));
      const captured = events(row, "source_index_acquisition")
        .map(event => event.data as Record<string, unknown>)
        .filter(data => data.kind === "nomination_attempt");
      expect(captured.some(data => data.disposition === "resource_refused" && data.admission == null
        && (data.resource_refusal as { stage?: unknown; phase?: unknown } | undefined)?.stage === "nomination"
        && (data.resource_refusal as { phase?: unknown }).phase === phase)).toBe(true);
      expect(captured.every(data => data.admission == null)).toBe(true);
      const refusals = (events(row, "source_index_routes")[0]?.data as {
        original?: { result?: { resource_refusals?: readonly { stage: string; phase: string }[] } }
      } | undefined)?.original?.result?.resource_refusals ?? [];
      expect(refusals).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "nomination", phase })]));
      const refusedEvent = captured.find(data => data.disposition === "resource_refused")!;
      const identity = refusedEvent.target as typeof fixture.targets[number]["target"];
      const source = fixture.targets.find(target => target.target.root_id === identity.root_id)!;
      const snapshot = digest("thrown-refusal-collector-json");
      const call = { kind: "recall" as const, request_id: row.request_id, session_id: row.facts!.binding!.session_id,
        query_key: ORIGINAL, snapshot_id: snapshot, workspace_id: WS, as_of: CLOCK };
      const { evidence_object_id: _evidence, kind: _kind, ...gold } = source.target;
      const answer = { unit: "published_body_utf8_bytes" as const, annotated_turns: 1, complete: true,
        spans: [{ session_index: 0, message_index: 0, source_id: source.source_id, target: gold, start: 0, end: 4 }] };
      const visibility = scoreConsumerMessageVisibility({ gold: answer, pages: [{ page: 1, status: "observed",
        reason: null, occupied_slots: 0, complete: true, continuation: "none", intervals: [],
        terminal_tail: { status: "unknown", reason: "native_access_or_computation_unresolved" } }] });
      const attribution = attributeObservation({ question_id: "thrown-refusal-json", k: 5, call,
        frames: [{ call, observation: row }], frozen_index: null, admitted_roots_complete: true,
        admitted_roots: new Map([[gold.root_id, { record_id: gold.root_id, source_id: source.source_id,
          snapshot_id: snapshot, identity: gold }]]), answer_gold: answer, visibility });
      const refused = attribution.messages[0]!.routes.flatMap(route => route.native?.attempts ?? [])
        .filter(attempt => attempt.disposition === "resource_refused");
      expect(refused.length).toBeGreaterThan(0);
      for (const attempt of refused) {
        expect(attempt.admission).toBeNull();
        expect(attempt.admission?.status === "resource_limited").toBe(false);
        expect(attempt.resource_refusal).toEqual({ stage: "nomination", phase });
      }
    } finally { on.releaseCanonical(); }
  });
});

it("keeps SQLite/worker delivery and debit parity with acquisition observation off, on and overflowed", async () => {
  const sources = Array.from({ length: 18 }, (_, index) => ({
    id: `harbor-${index}`, text: `${ORIGINAL} harbor ${index}`, vector: [1, 0, 0] as const
  }));
  await withIndexedSources(sources, async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: ORIGINAL, signal: new AbortController().signal,
      remainingMs: () => 60_000 });
    fixture.prepareQuery.mockResolvedValue(prepared);
    // Each arm starts without another arm's retained continuation leases.
    const offClient = await fixture.openClient(), client = await fixture.openClient(), overflowClient = await fixture.openClient();
    const ordinary = await workerCall(offClient, recall);
    const observed = await client.observeSourceSemantics({}, () => workerCall(client, recall));
    expect(observed.status).toBe("available");
    if (observed.outcome.status !== "success") throw observed.outcome.error;
    const diagnostic = observed.outcome.value;
    expect(diagnostic.index.entries.map(row => row.target)).toEqual(ordinary.index.entries.map(row => row.target));
    expect(diagnostic.previews).toEqual(ordinary.previews);
    expect(logical(diagnostic.work)).toEqual(logical(ordinary.work));
    // The same prepared receipt, including its measured time and byte price, serves
    // every arm. Observer wall time/RSS remain separate from deterministic debits.
    expect(diagnostic.execution).toEqual(ordinary.execution);
    expect(sourceSemanticExecutionPhases(diagnostic.execution!).query_preparation).toEqual(prepared.receipt);
    const ordinaryEncoded = encodeSourceSemanticLibraryResponse(ordinary);
    const diagnosticEncoded = encodeSourceSemanticLibraryResponse(diagnostic);
    if (ordinaryEncoded.operation !== "recall" || diagnosticEncoded.operation !== "recall") throw new Error("encoded recall expected");
    expect(diagnosticEncoded.results).toEqual(ordinaryEncoded.results);
    const row = jsonObservation(observed.observations[0]!);
    expect(row.overhead.capture_ms).toBeGreaterThan(0);
    const captured = events(row, "source_index_acquisition");
    expect(captured.some(event => (event.data as { invocation: string }).invocation === "original")).toBe(true);
    const dispositions = new Set(captured.filter(event => (event.data as { kind: string }).kind === "nomination_attempt")
      .map(event => (event.data as { disposition: string }).disposition));
    expect(dispositions.has("admitted")).toBe(true);
    expect(dispositions.has("duplicate")).toBe(true);
    expect(dispositions.has("nomination_limit")).toBe(true);
    const overflow = await overflowClient.observeSourceSemantics({ max_events: 0, max_bytes: 0 }, () => workerCall(overflowClient, recall));
    if (overflow.outcome.status !== "success") throw overflow.outcome.error;
    expect(overflow.outcome.value.index.entries.map(row => row.target)).toEqual(ordinary.index.entries.map(row => row.target));
    expect(logical(overflow.outcome.value.work)).toEqual(logical(ordinary.work));
    expect(overflow.outcome.value.execution).toEqual(ordinary.execution);
    expect(overflow.outcome.value.previews).toEqual(ordinary.previews);
    const overflowRow = jsonObservation(overflow.observations[0]!);
    expect(events(overflowRow, "source_index_acquisition")).toEqual([]);
    expect(overflowRow.status).toBe("overflow");
    expect(overflowRow.overhead.capture_ms).toBeGreaterThan(0);
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
    const diagnostic = observed.outcome.value, row = jsonObservation(observed.observations[0]!);
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
    expect(captured.filter(event => (event.data as { kind: string }).kind === "lexical_candidate").length).toBeGreaterThan(0);
    expect(row.diagnostics?.omitted_counts?.source_index_original_lexical_candidate ?? 0).toBe(0);
    for (const kind of ["source_index_routes", "source_read", "field_nomination", "encoded_membership"]) {
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
    // The ordinary reader returns a 4096-byte prefix, not this root's full 4224 bytes.
    // Keep both sides of that boundary: unavailable tail visibility is not a known miss.
    const answer = { unit: "published_body_utf8_bytes" as const, annotated_turns: 2, complete: true,
      spans: [
        { session_index: 0, message_index: 0, source_id: source.source_id, target: identity, start: 4096, end: 4100 },
        { session_index: 0, message_index: 1, source_id: source.source_id, target: identity, start: 4092, end: 4096 }
      ] };
    const visibility = scoreConsumerMessageVisibility({ gold: answer, pages: [{ page: 1, status: "observed",
      reason: null, occupied_slots: encoded.results!.length, complete: true,
      continuation: diagnostic.index.continuation === null ? "none" : "present",
      intervals: encoded.results!.flatMap((result, position) => result.target.kind === "source_evidence"
        ? [{ rank: position + 1, target: result.target, start: 0, end: Buffer.byteLength(result.content_preview) }] : []),
      terminal_tail: { status: diagnostic.index.continuation === null ? "unknown" : "open",
        reason: diagnostic.index.continuation === null ? "native_access_or_computation_unresolved" : "native_continuation" } }] });
    const attribution = attributeObservation({ question_id: "capacity", k: 5, call, frames: [{ call, observation: row }],
      frozen_index: null, admitted_roots_complete: true, admitted_roots: new Map([[identity.root_id,
        { record_id: identity.root_id, source_id: source.source_id, snapshot_id: snapshot, identity }]]),
      answer_gold: answer, visibility });
    expect(diagnostic.protocol_version).toBe(12);
    expect(diagnostic.index.result_version).toBe("ordinary-native-field.v4");
    expect(encoded.results).toHaveLength(1);
    expect(diagnostic.index.continuation).not.toBeNull();
    expect(visibility.any_at_5).toEqual({ status: "unknown", reason: "second_page_not_observed" });
    expect(attribution.observation).toMatchObject({ complete: false, progress_complete: true, finite_union_complete: true });
    expect(attribution.layer).toBe("U");
    const message = attribution.messages[0]!;
    expect(message).toMatchObject({ candidate: "present", read: "none", visibility: { delivery: "unknown" } });
    expect(message.read_intervals).toHaveLength(2);
    expect(message.read_intervals.every(interval => interval.start === 0 && interval.end === 4096)).toBe(true);
    expect(attribution.messages[1]).toMatchObject({ candidate: "present", read: "whole", visibility: { delivery: "unknown" } });
    expect(message.routes.find(route => route.route === "index:original:vector")?.unknowns)
      .toContainEqual({ stage: "nomination", reason: "vector_inspection_detail_unavailable" });
    expect(message.unknowns.some(unknown => unknown.reason === "vector_inspection_detail_unavailable"
      || unknown.reason === "causal_observation_incomplete" || unknown.reason === "observation_incomplete")).toBe(false);
    expect(message.first_unknown?.reason).not.toBe("vector_inspection_detail_unavailable");
    expect(message.routes.find(route => route.route === "index:original:vector")?.native?.lexical_window).toBeNull();
    const capturedAttempts = captured.filter(event => {
      const data = event.data as { kind?: string; target?: { root_id?: string }; disposition?: string };
      return data.kind === "nomination_attempt" && data.target?.root_id === identity.root_id;
    }).map(event => event.data as { channel: string; disposition: string });
    const workerAttempts = message.routes.flatMap(route => (route.native?.attempts ?? []).map(attempt => ({
      channel: route.native!.channel, disposition: attempt.disposition })));
    expect(captured.some(event => (event.data as { disposition?: string }).disposition === "nomination_limit")).toBe(true);
    const keyed = (row: { channel: string; disposition: string }) => `${row.channel}:${row.disposition}`;
    expect(workerAttempts.map(keyed).sort()).toEqual(capturedAttempts.map(row => keyed({
      channel: row.channel, disposition: row.disposition })).sort());
    expect(workerAttempts.length).toBeGreaterThan(0);
  }, configuration);
}, 60_000);
