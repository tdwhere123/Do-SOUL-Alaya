import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { SourceSemanticExecutionSchema, SourceSemanticResourceExhausted, sourceSemanticAccessPhases,
  sourceSemanticExecutionPhases } from "@do-soul/alaya-protocol";
import type { SourceSemanticWorkerResult } from "@do-soul/alaya-protocol";
import { closeCachedDatabase, SqliteFieldSourceRecordRepo, SqliteSourceHintReader } from "@do-soul/alaya-storage";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { runSourceSemanticWorker } from "../../../runtime/recall-read-worker/source-semantic-reasoning.js";
import { observeSourceSemanticAccess } from "../../../runtime/recall-read-worker/source-semantic-candidate-access.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { ACCESS_BUDGET, CLOCK, WS, accessQuery, withAccessLibrary } from "./source-semantic-access.test-support.js";
import { ORIGINAL, QUERY_BUDGET, RAW, SCOPES, withIndexedSources } from "./source-semantic-index-acquisition.test-support.js";
import { expectFirstExtentThenCensusRefusal, expectFundedExtentThenCensus, sourceObservationOrder }
  from "./source-semantic-observation-order.test-support.js";

const HINT = "x".repeat(1024);
const HINT_NAVIGATION_WORK = 64 * (HINT.length + 1);
const HINT_NAVIGATION_BYTES = 128 * (HINT.length + 1);
const orchid = "orchid irrigation";
const otherWorkspace = "other-workspace";

function navigationTrace() {
  const headers = vi.spyOn(SqliteSourceHintReader.prototype, "pageBoundInterpretationHeaders");
  const navigation = vi.spyOn(SqliteSourceHintReader.prototype, "pageInterpretationTextHints");
  const bodies = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findByIdBounded");
  const charge = vi.spyOn(SourceSemanticReadBudget.prototype, "charge");
  const reserve = vi.spyOn(SourceSemanticReadBudget.prototype, "reserve");
  return {
    headers, navigation, bodies, charge, reserve,
    snapshot() {
      const order = sourceObservationOrder({ bodies, headers, reserve, charge });
      return {
        headerReads: headers.mock.calls.length,
        navigationReads: navigation.mock.calls.length,
        headerWorkspaces: headers.mock.calls.map(([input]) => input.workspaceId),
        firstSourceBeforeHeader: bodies.mock.calls.length > 0 && headers.mock.calls.length > 0
          && bodies.mock.invocationCallOrder[0]! < headers.mock.invocationCallOrder[0]!,
        headerBeforeNavigation: navigation.mock.calls.length === 0 || headers.mock.calls.length > 0
          && headers.mock.invocationCallOrder[0]! < navigation.mock.invocationCallOrder[0]!,
        hintNavigationFeatures: charge.mock.calls.filter(([work, bytes, phase]) =>
          work === HINT_NAVIGATION_WORK && bytes === HINT_NAVIGATION_BYTES && phase === "access query features").length,
        navigationPageReserves: reserve.mock.calls.filter(([, , phase]) => phase === "access navigation page").length,
        headerPageReserves: reserve.mock.calls.filter(([, , phase]) => phase === "interpretation access header page").length,
        emptyCensusPlanning: charge.mock.calls.filter(([, , phase]) =>
          phase === "empty interpretation completion planning").length,
        ...order
      };
    },
    restore() { headers.mockRestore(); navigation.mockRestore(); bodies.mockRestore(); charge.mockRestore(); reserve.mockRestore(); }
  };
}

function asPrepared(result: SourceSemanticWorkerResult) {
  if (result.kind !== "prepare_query") throw new Error("preparation expected");
  return result;
}

function prepareAccess(runtime: RecallReadWorkerRuntime, original: string, budget: typeof ACCESS_BUDGET) {
  return asPrepared(runSourceSemanticWorker(runtime, {
    workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] },
    request: { kind: "prepare_query", original_query: original, access_hint: HINT, budget,
      query_semantics: accessQuery(original) }
  }));
}

it("skips navigation after one workspace-empty header page while observing the first source and dropping 1024-hint features", async () => {
  expect(HINT_NAVIGATION_WORK).toBe(65_600);
  expect(HINT_NAVIGATION_BYTES).toBe(131_200);
  await withAccessLibrary([{ id: "known", text: "Orchid irrigation.", reading: orchid }], async ({ filename }) => {
    const { database } = await createRecallRealStorage(() => undefined, filename);
    const moved = database.connection.prepare("UPDATE evidence_capsules SET workspace_id=? WHERE workspace_id=?").run(otherWorkspace, WS);
    expect(moved.changes).toBe(1);
    expect(database.connection.prepare("SELECT workspace_id, COUNT(*) AS n FROM evidence_capsules GROUP BY workspace_id").all())
      .toEqual([{ workspace_id: otherWorkspace, n: 1 }]);
    const trace = navigationTrace();
    try {
      const result = prepareAccess({ database } as RecallReadWorkerRuntime, orchid, ACCESS_BUDGET);
      const snap = trace.snapshot();
      expect(snap.headerReads).toBe(1);
      expect(snap.headerPageReserves).toBe(1);
      expect(snap.headerWorkspaces).toEqual([WS]);
      expect(snap.navigationReads).toBe(0);
      expect(snap.navigationPageReserves).toBe(0);
      expect(snap.hintNavigationFeatures).toBe(0);
      expect(snap.firstSourceBeforeHeader).toBe(true);
      expect(snap.metadataReads).toBe(1);
      expect(snap.bodySpans).toHaveLength(1);
      expectFundedExtentThenCensus(snap);
      expect(snap.furtherBodyAfterCensus).toBe(0);
      expect(snap.emptyCensusPlanning).toBe(1);
      expect(result.access).toMatchObject({ observed_source_count: 1, observed_interpretation_count: 0,
        unvisited_sources: false, unvisited_interpretations: false });
      expect(result.access?.source_candidates).toEqual([expect.objectContaining({ source_id: "known", complete: true })]);
      expect(result.coverage.discovery).toBe("complete");
      expect(result.candidates).toEqual([]);
    } finally { trace.restore(); database.close(); closeCachedDatabase(filename); }
  });
});

it.each([
  { name: "nonempty active", mutate: null as string | null, interpretations: 1 },
  { name: "inactive oversized", mutate: "filtered-empty", interpretations: 0 }
])("routes $name headers through one reused page plus navigation without extra header reads", async ({ mutate, interpretations }) => {
  await withAccessLibrary([{ id: "known", text: "Orchid irrigation.", reading: orchid }], async ({ filename }) => {
    const { database } = await createRecallRealStorage(() => undefined, filename);
    if (mutate === "filtered-empty") {
      // Headers still return the withdrawn row; filtered-empty is not an authoritative raw census.
      const updated = database.connection.prepare("UPDATE evidence_capsules SET gist=?, lifecycle_state='withdrawn' WHERE workspace_id=?")
        .run("unparsed ".repeat(100_000), WS);
      expect(updated.changes).toBe(1);
    }
    const trace = navigationTrace();
    try {
      const result = prepareAccess({ database } as RecallReadWorkerRuntime, orchid, ACCESS_BUDGET);
      const snap = trace.snapshot();
      expect(snap.headerReads).toBe(1);
      expect(snap.headerPageReserves).toBe(1);
      expect(snap.navigationReads).toBe(1);
      expect(snap.navigationPageReserves).toBe(1);
      expect(snap.hintNavigationFeatures).toBe(1);
      expect(snap.firstSourceBeforeHeader).toBe(true);
      expect(snap.headerBeforeNavigation).toBe(true);
      expect(snap.metadataReads).toBe(1);
      expect(snap.bodySpans.length).toBeGreaterThan(0);
      expectFundedExtentThenCensus(snap);
      if (interpretations === 0) expect(snap.furtherBodyAfterCensus).toBe(0);
      expect(snap.emptyCensusPlanning).toBe(0);
      expect(result.access?.observed_interpretation_count).toBe(interpretations);
      expect(result.candidates).toHaveLength(interpretations);
      expect(result.access?.source_candidates).toEqual([expect.objectContaining({ source_id: "known", complete: true })]);
    } finally { trace.restore(); database.close(); closeCachedDatabase(filename); }
  });
});

it.each([
  { name: "resource-limited", kind: "resource-limited" as const },
  { name: "truncated", kind: "truncated" as const },
  { name: "read-failure", kind: "read-failure" as const }
])("injected $name header refusal never concludes empty complete", async ({ kind }) => {
  await withAccessLibrary([{ id: "known", text: "Orchid irrigation." }], async ({ filename }) => {
    const { database } = await createRecallRealStorage(() => undefined, filename);
    expect(database.connection.prepare("SELECT COUNT(*) AS n FROM evidence_capsules").get()).toEqual({ n: 0 });
    const trace = navigationTrace();
    if (kind === "read-failure") {
      trace.headers.mockImplementation(function injectedHeaderReadFailure(): never {
        throw new Error("injected header read failure");
      });
    } else if (kind === "resource-limited") {
      trace.headers.mockImplementation(function injectedResourceLimitedHeader() {
        return { rows: [], nativeVisits: 0, bytesRead: 0, committedThrough: null, truncated: false, resourceLimited: true };
      });
    } else {
      trace.headers.mockImplementation(function injectedTruncatedHeader() {
        return { rows: [], nativeVisits: 1, bytesRead: 16, committedThrough: null, truncated: true, resourceLimited: false };
      });
    }
    try {
      const run = () => prepareAccess({ database } as RecallReadWorkerRuntime, orchid, ACCESS_BUDGET);
      if (kind === "read-failure") {
        expect(() => run()).toThrow(/injected header read failure/u);
        const snap = trace.snapshot();
        expect(trace.headers).toHaveBeenCalled();
        expectFirstExtentThenCensusRefusal(snap);
        expect(snap.bodySpans).toHaveLength(1);
        expect(snap.emptyCensusPlanning).toBe(0);
        return;
      }
      const result = run(), snap = trace.snapshot();
      expect(snap.headerReads).toBe(1);
      expect(snap.navigationReads).toBe(1);
      expect(snap.hintNavigationFeatures).toBe(1);
      expect(snap.metadataReads).toBe(1);
      expect(snap.bodySpans.length).toBeGreaterThan(0);
      expectFundedExtentThenCensus(snap);
      expect(snap.furtherBodyAfterCensus).toBe(0);
      expect(snap.emptyCensusPlanning).toBe(0);
      expect(result.access?.observed_source_count).toBe(1);
      expect(result.access?.source_candidates).toEqual([expect.objectContaining({ source_id: "known" })]);
      expect(result.access?.unvisited_interpretations).toBe(true);
      expect(result.coverage.discovery).not.toBe("complete");
      expect(result.access?.stopping_reasons).toContain("unavailable");
    } finally { trace.restore(); database.close(); closeCachedDatabase(filename); }
  });
});

it.each(["reserve", "read"] as const)("rethrows the original injected first-census %s exhaustion after charged SQLite metadata, without a fake partial body", async (failureAt) => {
  await withAccessLibrary([{ id: "raw", text: "Orchid irrigation." }], async ({ filename }) => {
    const { database } = await createRecallRealStorage(() => undefined, filename);
    const meter = new SourceSemanticReadBudget(ACCESS_BUDGET);
    const reserve = SourceSemanticReadBudget.prototype.reserve;
    const readHeaders = SqliteSourceHintReader.prototype.pageBoundInterpretationHeaders;
    const trace = navigationTrace();
    const original = new SourceSemanticResourceExhausted(`injected first census header ${failureAt}`);
    // Simulated refusal at the stated seam; source metadata (and header in the read case) still uses real SQLite.
    if (failureAt === "reserve") trace.reserve.mockImplementation(function (this: SourceSemanticReadBudget, ...args) {
      if (args[2] === "interpretation access header page") throw original;
      return reserve.apply(this, args);
    });
    else trace.headers.mockImplementation(function (this: SqliteSourceHintReader, ...args) {
      readHeaders.apply(this, args);
      throw original;
    });
    try {
      let returned: ReturnType<typeof observeSourceSemanticAccess> | undefined, caught: unknown;
      try {
        returned = database.connection.transaction(() => observeSourceSemanticAccess({ database }, {
          workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] },
          request: { kind: "prepare_query", original_query: orchid, budget: ACCESS_BUDGET }
        }, ["project"], meter, orchid, undefined, "query-conditioned-v1", ACCESS_BUDGET))();
      } catch (error) { caught = error; }
      expect(caught).toBe(original);
      expect((caught as SourceSemanticResourceExhausted).phase).toBe(`injected first census header ${failureAt}`);
      expect(returned).toBeUndefined(); // No returned body_bytes:null receipt is an error substitute.
      const snap = trace.snapshot();
      expect(snap.headerReads).toBe(failureAt === "reserve" ? 0 : 1);
      expect(snap.headerPageReserves).toBe(1);
      expectFirstExtentThenCensusRefusal(snap);
      expect(snap.bodySpans).toHaveLength(1);
      expect(snap.navigationReads).toBe(0);
      expect(snap.navigationPageReserves).toBe(0);
      expect(snap.emptyCensusPlanning).toBe(0);
      const metadata = trace.bodies.mock.results[0]!;
      if (metadata.type !== "return" || metadata.value === null) throw new Error("actual source metadata required");
      expect(metadata.value.bodyBytes).toBe(Buffer.byteLength("User: Orchid irrigation."));
      expect(metadata.value.record?.source_body).not.toBeNull();
      expect(metadata.value.resourceLimited).toBeUndefined();
      const work = 5 + (metadata.value.dependencyWork ?? 0);
      const nativeBytes = metadata.value.nativeBytes + metadata.value.metadataBytes;
      const metadataReadOrder = trace.bodies.mock.invocationCallOrder[0]!;
      const debit = trace.charge.mock.calls.findIndex(([chargedWork, chargedBytes, phase], index) =>
        trace.charge.mock.invocationCallOrder[index]! > metadataReadOrder
          && phase === "native source read" && chargedWork === work && chargedBytes === nativeBytes);
      expect(debit).toBeGreaterThanOrEqual(0);
      const census = trace.reserve.mock.calls.findIndex(([, , phase]) => phase === "interpretation access header page");
      expect(trace.charge.mock.invocationCallOrder[debit]!).toBeLessThan(trace.reserve.mock.invocationCallOrder[census]!);
      expect(meter.nativeWork).toBeGreaterThanOrEqual(work);
      expect(meter.nativeBytes).toBeGreaterThanOrEqual(nativeBytes);
      expect(meter.spentWork).toBeGreaterThanOrEqual(meter.nativeWork);
      expect(meter.spentBytes).toBeGreaterThanOrEqual(meter.nativeBytes);
    } finally { trace.restore(); database.close(); closeCachedDatabase(filename); }
  });
});

it("keeps an injected ordinary body-reservation exhaustion partial with its known SQLite extent", async () => {
  await withAccessLibrary([{ id: "raw", text: "Orchid irrigation." }], async ({ filename }) => {
    const { database } = await createRecallRealStorage(() => undefined, filename);
    const reserve = SourceSemanticReadBudget.prototype.reserve;
    const trace = navigationTrace();
    trace.reserve.mockImplementation(function (this: SourceSemanticReadBudget, ...args) {
      if (args[2] === "access source extent") throw new SourceSemanticResourceExhausted("injected source body reserve");
      return reserve.apply(this, args);
    });
    try {
      const result = prepareAccess({ database } as RecallReadWorkerRuntime, orchid, ACCESS_BUDGET);
      expect(result.access?.source_candidates).toEqual([expect.objectContaining({ source_id: "raw",
        read_bytes: 0, body_bytes: Buffer.byteLength("User: Orchid irrigation."), complete: false })]);
      expect(result.access?.stopping_reasons).toEqual(expect.arrayContaining(["budget", "source_tail"]));
      expect(result.coverage.discovery).toBe("truncated");
      const snap = trace.snapshot();
      expect(snap.metadataReads).toBe(1);
      expect(snap.headerReads).toBe(1);
      expect(snap.metadataBeforeCensus).toBe(true);
      expect(snap.firstExtentBeforeCensus).toBe(0);
      expect(snap.furtherBodyAfterCensus).toBe(0);
      expect(snap.bodySpans).toEqual([]);
      expect(snap.navigationReads).toBe(0);
      expect(snap.emptyCensusPlanning).toBe(1);
    } finally { trace.restore(); database.close(); closeCachedDatabase(filename); }
  });
});

it("preserves source-index acquisition and public empty completion without 1024-hint navigation work", async () => {
  await withIndexedSources([{ id: "raw", text: RAW, vector: [1, 0, 0] }], async fixture => {
    expect(fixture.database.connection.prepare("SELECT COUNT(*) AS n FROM evidence_capsules").get()).toEqual({ n: 0 });
    const prepared = await fixture.prepareQuery({ navigation: HINT, signal: new AbortController().signal, remainingMs: () => 60_000 });
    const trace = navigationTrace();
    try {
      const result = asPrepared(runSourceSemanticWorker({ database: fixture.database } as RecallReadWorkerRuntime, {
        workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES, prepared_query: prepared,
        request: { kind: "prepare_query", original_query: ORIGINAL, access_hint: HINT, budget: QUERY_BUDGET }
      }));
      const snap = trace.snapshot();
      expect(snap.headerReads).toBe(1);
      expect(snap.headerPageReserves).toBe(1);
      expect(snap.navigationReads).toBe(0);
      expect(snap.navigationPageReserves).toBe(0);
      expect(snap.hintNavigationFeatures).toBe(0);
      expect(snap.firstSourceBeforeHeader).toBe(true);
      expect(snap.metadataReads).toBe(1);
      expect(snap.bodySpans.length).toBeGreaterThan(0);
      expectFundedExtentThenCensus(snap);
      expect(snap.furtherBodyAfterCensus).toBe(0);
      expect(snap.emptyCensusPlanning).toBe(1);
      expect(result.access).toMatchObject({ observed_source_count: 1, observed_interpretation_count: 0,
        unvisited_sources: false, unvisited_interpretations: false });
      expect(result.coverage.discovery).toBe("complete");
      expect(result.access?.source_candidates).toContainEqual(expect.objectContaining({ source_id: "raw", complete: true,
        read_bytes: Buffer.byteLength(RAW), body_bytes: Buffer.byteLength(RAW) }));
      expect(sourceSemanticAccessPhases(result.access!).acquisition).toMatchObject({ status: "executed", accounting: "complete" });
      expect(sourceSemanticExecutionPhases(SourceSemanticExecutionSchema.parse(result.execution)).acquisition)
        .toEqual(sourceSemanticAccessPhases(result.access!).acquisition);
      expect(sourceSemanticAccessPhases(result.access!).acquisition.result?.nominations.length).toBeGreaterThan(0);
    } finally { trace.restore(); }
  });
});
