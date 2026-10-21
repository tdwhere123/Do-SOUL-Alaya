import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { createSourceSemanticAccessPolicy, encodeSourceSemanticLibraryResponse } from "@do-soul/alaya-core";
import { sourceSemanticExecutionPhases } from "@do-soul/alaya-protocol";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { acquireSourceSemanticIndex } from "../../../runtime/recall-read-worker/source-semantic-index-acquisition.js";
import { SourceSemanticObserver } from "../../../runtime/recall-read-worker/source-semantic-observation.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { WS, ORIGINAL, RAW, QUERY_BUDGET, withIndexedSources, workerCall, type IndexFixture }
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
