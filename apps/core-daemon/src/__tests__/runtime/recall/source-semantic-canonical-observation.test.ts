import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { CoreError, createSourceSemanticAccessPolicy, fieldContractSha256 } from "@do-soul/alaya-core";
import { SourceSemanticResourceExhausted, sourceSemanticAccessPhases } from "@do-soul/alaya-protocol";
import { SqliteFieldSourceRecordRepo, SqliteSourceHintReader, sourceRecordFromRow } from "@do-soul/alaya-storage";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { observeSourceSemanticAccess } from "../../../runtime/recall-read-worker/source-semantic-candidate-access.js";
import { SourceSemanticUnionCompletion } from "../../../runtime/recall-read-worker/source-semantic-empty-population-budget.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { beginCanonicalSourceText, quoteSemanticSourceObservation, readSourceText }
  from "../../../runtime/recall-read-worker/source-semantic-source-observation.js";
import { CLOCK, ORIGINAL, QUERY_BUDGET, RAW, SCOPES, WS, withIndexedSources, workerCall, type IndexFixture }
  from "./source-semantic-index-acquisition.test-support.js";

const ALLOWANCE = { work_units: QUERY_BUDGET.work_units, memory_bytes: QUERY_BUDGET.memory_bytes };
const UTF8 = `${"雪".repeat(1500)}${"🌿".repeat(1000)}`;
const preparation = { kind: "prepare_query" as const, original_query: ORIGINAL, budget: QUERY_BUDGET };

function released(meter: SourceSemanticReadBudget) {
  expect(meter.outstandingAllowance()).toEqual({ work_units: meter.spentWork, memory_bytes: meter.spentBytes });
}
function held(meter: SourceSemanticReadBudget) {
  const outstanding = meter.outstandingAllowance();
  return { work_units: outstanding.work_units - meter.spentWork, memory_bytes: outstanding.memory_bytes - meter.spentBytes };
}
function futureCompletion(policy: ReturnType<typeof createSourceSemanticAccessPolicy>, characters: number) {
  const scoring = policy.sourceCost(characters);
  return { work_units: scoring.work_units, memory_bytes: scoring.memory_bytes + 4 * characters };
}

function extentPages(spy: {
  mock: {
    calls: unknown[][];
    invocationCallOrder: number[];
    results: { type?: string; value?: { record?: { source_body?: string | null } | null } | null }[];
  };
}) {
  return spy.mock.calls.flatMap((args: unknown[], index: number) => {
    const maxBytes = args[2], offset = args[3];
    if (typeof maxBytes !== "number" || maxBytes <= 1) return [];
    const start = typeof offset === "number" ? offset : 0;
    const result = spy.mock.results[index];
    const chunk = result?.type === "return" && result.value != null ? result.value.record?.source_body ?? null : null;
    return [{ identity: args[1], maxBytes, offset: start, order: spy.mock.invocationCallOrder[index]!, chunk }];
  });
}

async function withCanonicalSource(text: string, body: (input: {
  repo: SqliteFieldSourceRecordRepo; record: ReturnType<typeof sourceRecordFromRow>;
  parent: SourceSemanticReadBudget; meter: SourceSemanticReadBudget;
  policy: ReturnType<typeof createSourceSemanticAccessPolicy>;
  database: IndexFixture["database"];
}) => void) {
  await withIndexedSources([{ id: "seed", text: "Seed." }, { id: "raw", text, indexed: false }], async fixture => {
    const repo = new SqliteFieldSourceRecordRepo(fixture.database, fieldContractSha256);
    const current = repo.findCurrentBounded(WS, "raw", 1, 0,
      { workLimit: ALLOWANCE.work_units, nativeByteLimit: ALLOWANCE.memory_bytes });
    expect(current?.record).toBeDefined();
    const record = sourceRecordFromRow(current!.record!);
    const parent = new SourceSemanticReadBudget(ALLOWANCE), meter = new SourceSemanticReadBudget(ALLOWANCE);
    const policy = createSourceSemanticAccessPolicy(ORIGINAL, undefined, "query-conditioned-v1",
      new SourceSemanticReadBudget(ALLOWANCE));
    fixture.database.connection.transaction(() => body({ repo, record, parent, meter, policy, database: fixture.database }))();
  });
}

it.each([
  { name: "ASCII", text: RAW },
  { name: "empty source", text: "" },
  { name: "UTF-8 boundary", text: UTF8 }
])("resumes one first native extent without rereading or scoring before the census callback: $name", async ({ name, text }) => {
  await withCanonicalSource(text, ({ repo, record, parent, meter, policy }) => {
    const pages = vi.spyOn(repo, "findByIdBounded"), score = vi.spyOn(policy, "source");
    const bytes = Buffer.byteLength(text);
    const read = beginCanonicalSourceText(repo, record, policy, meter, parent, bytes);
    expect(read).toBeDefined();
    expect(pages.mock.calls.length).toBe(bytes === 0 ? 1 : 2);
    expect(score).not.toHaveBeenCalled();
    const census = vi.fn(() => { expect(score).not.toHaveBeenCalled(); });
    const result = read!.resume(census);
    expect(census).toHaveBeenCalledTimes(1);
    expect(result.complete).toBe(true);
    expect(result.read_bytes).toBe(bytes);
    expect(result.body_bytes).toBe(bytes);
    expect(score).toHaveBeenCalledTimes(1);
    expect(score.mock.calls[0]![0]).toBe(text);
    const extents = extentPages(pages);
    const offsets: number[] = extents.map((row: { offset: number }) => row.offset);
    expect(new Set(offsets).size).toBe(offsets.length);
    expect(offsets.every((offset: number, index: number) => index === 0 || offset > offsets[index - 1]!)).toBe(true);
    if (name === "UTF-8 boundary") {
      expect(extents[0]?.offset).toBe(0);
      expect(extents[0]?.chunk).toEqual(expect.any(String));
      expect([...extents[0]!.chunk!].every(character => character === "雪")).toBe(true);
      expect(Buffer.byteLength(extents[0]!.chunk!)).toBeLessThanOrEqual(4096);
      expect(extents[1]?.offset).toBe(Buffer.byteLength(extents[0]!.chunk!));
    }
    released(meter);
    const spent = [meter.spentWork, meter.spentBytes], visits = pages.mock.calls.length;
    read!.close(); read!.close();
    expect([meter.spentWork, meter.spentBytes]).toEqual(spent);
    expect(pages).toHaveBeenCalledTimes(visits);
    expect(() => read!.resume()).toThrow(CoreError);
    expect(() => read!.resume()).toThrow(/closed/u);
  });
});

it("rethrows the original census callback and absorbs executed work after releasing holds", async () => {
  await withCanonicalSource(RAW, ({ repo, record, parent, meter, policy }) => {
    const pages = vi.spyOn(repo, "findByIdBounded"), score = vi.spyOn(policy, "source");
    const read = beginCanonicalSourceText(repo, record, policy, meter, parent, Buffer.byteLength(RAW));
    expect(read).toBeDefined();
    const spent: [number, number] = [meter.spentWork, meter.spentBytes], visits = pages.mock.calls.length;
    expect(meter.outstandingAllowance().memory_bytes).toBeGreaterThan(meter.spentBytes);
    expect(meter.nativeBytes).toBeGreaterThan(0);
    const failure = new Error("census refused");
    expect(() => read!.resume(() => { throw failure; })).toThrow(failure);
    expect(pages).toHaveBeenCalledTimes(visits);
    expect(score).not.toHaveBeenCalled();
    expect([meter.spentWork, meter.spentBytes]).toEqual(spent);
    released(meter);
    const before: [number, number] = [parent.spentWork, parent.spentBytes];
    parent.absorb(meter);
    expect([parent.spentWork, parent.spentBytes]).toEqual([before[0] + spent[0], before[1] + spent[1]]);
  });
});

it("keeps a metadata dependency refusal unknown rather than a complete empty source", async () => {
  await withCanonicalSource(RAW, ({ repo, record, parent, meter, policy }) => {
    const native = repo.findByIdBounded.bind(repo);
    const pages = vi.spyOn(repo, "findByIdBounded").mockImplementation((...args) => {
      const page = native(...args);
      return page === null ? page : { ...page, resourceLimited: true };
    });
    const score = vi.spyOn(policy, "source");
    const read = beginCanonicalSourceText(repo, record, policy, meter, parent, Buffer.byteLength(RAW));
    expect(read).toBeDefined();
    const census = vi.fn();
    const result = read!.resume(census);
    expect(census).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ read_bytes: 0, complete: false, resourceLimited: true,
      signal: { source_text_score: null } });
    expect(result.body_bytes === null || result.body_bytes === Buffer.byteLength(RAW)).toBe(true);
    expect(meter.nativeBytes).toBeGreaterThan(0);
    expect(score).not.toHaveBeenCalled();
    expect(pages.mock.calls.length).toBe(1);
    released(meter);
  });
});

it("keeps a later native refusal as a scored partial UTF-8 prefix", async () => {
  await withCanonicalSource(UTF8, ({ repo, record, parent, meter, policy }) => {
    const native = repo.findByIdBounded.bind(repo);
    let visits = 0;
    const pages = vi.spyOn(repo, "findByIdBounded").mockImplementation((...args) => {
      const page = native(...args);
      return ++visits === 3 && page !== null ? { ...page, resourceLimited: true } : page;
    });
    const score = vi.spyOn(policy, "source");
    const read = beginCanonicalSourceText(repo, record, policy, meter, parent, Buffer.byteLength(UTF8));
    expect(read).toBeDefined();
    expect(pages).toHaveBeenCalledTimes(2);
    const firstChunk = extentPages(pages)[0]?.chunk;
    expect(typeof firstChunk).toBe("string");
    const result = read!.resume();
    expect(result.complete).toBe(false);
    expect(result.resourceLimited).toBe(true);
    expect(result.read_bytes).toBe(Buffer.byteLength(firstChunk!));
    expect(score).toHaveBeenCalledTimes(1);
    expect(score.mock.calls[0]![0]).toBe(firstChunk);
    expect([...firstChunk!].every(character => character === "雪")).toBe(true);
    released(meter);
    expect(pages).toHaveBeenCalledTimes(3);
  });
});

it("keeps the ordinary census promotion seam when the first extent cannot be funded", async () => {
  await withCanonicalSource("A".repeat(5000), ({ repo, record, parent, meter, policy }) => {
    const quote = quoteSemanticSourceObservation(policy.sourceCost, 4096);
    expect(quote.memory_bytes).toBeGreaterThan(0);
    meter.bytes = quote.memory_bytes - 1;
    const pages = vi.spyOn(repo, "findByIdBounded"), score = vi.spyOn(policy, "source");
    const before = [parent.spentWork, parent.spentBytes];
    expect(beginCanonicalSourceText(repo, record, policy, meter, parent, 5000)).toBeUndefined();
    expect(pages).not.toHaveBeenCalled();
    expect(score).not.toHaveBeenCalled();
    expect([parent.spentWork, parent.spentBytes]).toEqual(before);
    const census = vi.fn(() => {
      expect(pages).toHaveBeenCalledTimes(1);
      expect(pages.mock.calls[0]![2]).toBe(1);
      expect(score).not.toHaveBeenCalled();
      meter.bytes = ALLOWANCE.memory_bytes - meter.spentBytes;
    });
    const result = readSourceText(repo, record, policy, meter, undefined, census);
    expect(census).toHaveBeenCalledTimes(1);
    expect(result.complete).toBe(true);
    expect(result.read_bytes).toBe(5000);
    expect(score).toHaveBeenCalledTimes(1);
    expect(score.mock.calls[0]![0]).toBe("A".repeat(5000));
    const offsets: number[] = extentPages(pages).map((row: { offset: number }) => row.offset);
    expect(new Set(offsets).size).toBe(offsets.length);
    released(meter);
  });
});

it.each([
  { name: "1-char", text: "Q" },
  { name: "ASCII", text: RAW },
  { name: "UTF-8 boundary", text: UTF8 }
])("holds actual future scoring and assembly once at the owner quote for $name", async ({ name, text }) => {
  await withCanonicalSource(text, ({ repo, record, parent, meter, policy }) => {
    const bytes = Buffer.byteLength(text);
    const quote = quoteSemanticSourceObservation(policy.sourceCost, Math.min(4096, bytes));
    expect(quote.work_units).toBeLessThanOrEqual(meter.work);
    expect(quote.memory_bytes).toBeLessThanOrEqual(meter.bytes);
    const pages = vi.spyOn(repo, "findByIdBounded"), score = vi.spyOn(policy, "source");
    const hold = meter.hold.bind(meter);
    const holds: ReturnType<typeof futureCompletion>[] = [];
    vi.spyOn(meter, "hold").mockImplementation((cost) => {
      holds.push({ work_units: cost.work_units, memory_bytes: cost.memory_bytes });
      return hold(cost);
    });
    const read = beginCanonicalSourceText(repo, record, policy, meter, parent, bytes);
    expect(read).toBeDefined();
    const parentAfterBegin: [number, number] = [parent.spentWork, parent.spentBytes];
    const firstChunk = extentPages(pages)[0]?.chunk ?? text;
    const characters = firstChunk.length;
    const future = futureCompletion(policy, characters);
    expect(holds).toEqual([future]);
    expect(held(meter)).toEqual(future);
    if (name === "1-char") {
      expect(characters).toBe(1);
      expect(future.memory_bytes).toBe(policy.sourceCost(1).memory_bytes + 4);
      expect(future.memory_bytes).not.toBe(policy.sourceCost(1).memory_bytes);
      expect(future.memory_bytes).not.toBe(8 * 1 + 32);
    }
    expect(score).not.toHaveBeenCalled();
    const result = read!.resume();
    expect(holds).toHaveLength(1);
    expect(score).toHaveBeenCalledTimes(1);
    expect(score.mock.calls[0]![0]).toBe(text);
    expect(result.complete).toBe(true);
    released(meter);
    const childSpent: [number, number] = [meter.spentWork, meter.spentBytes];
    parent.absorb(meter);
    expect([parent.spentWork, parent.spentBytes]).toEqual(
      [parentAfterBegin[0] + childSpent[0], parentAfterBegin[1] + childSpent[1]]);
  });
});

it("returns undefined without reading when the parent cannot hold the quoted start", async () => {
  await withCanonicalSource(RAW, ({ repo, record, meter, policy }) => {
    const quote = quoteSemanticSourceObservation(policy.sourceCost, Buffer.byteLength(RAW));
    const parent = new SourceSemanticReadBudget({ work_units: quote.work_units,
      memory_bytes: Math.max(0, quote.memory_bytes - 1) });
    const pages = vi.spyOn(repo, "findByIdBounded"), score = vi.spyOn(policy, "source");
    const before: [number, number] = [parent.spentWork, parent.spentBytes];
    expect(beginCanonicalSourceText(repo, record, policy, meter, parent, Buffer.byteLength(RAW))).toBeUndefined();
    expect(pages).not.toHaveBeenCalled();
    expect(score).not.toHaveBeenCalled();
    expect([parent.spentWork, parent.spentBytes]).toEqual(before);
    const census = vi.fn(() => { expect(pages).toHaveBeenCalledTimes(1); expect(score).not.toHaveBeenCalled(); });
    const result = readSourceText(repo, record, policy, meter, undefined, census);
    expect(census).toHaveBeenCalledTimes(1);
    expect(result.complete).toBe(true);
    expect(score).toHaveBeenCalledTimes(1);
    released(meter);
  });
});

it("preserves actual bytes as UNKNOWN when completion cannot be held after the first extent", async () => {
  await withCanonicalSource("Q", ({ repo, record, parent, meter, policy }) => {
    const pages = vi.spyOn(repo, "findByIdBounded"), score = vi.spyOn(policy, "source");
    const hold = meter.hold.bind(meter);
    vi.spyOn(meter, "hold").mockImplementation((cost) => {
      expect(cost).toEqual(futureCompletion(policy, 1));
      meter.bytes = Math.max(0, cost.memory_bytes - 1);
      return hold(cost);
    });
    const read = beginCanonicalSourceText(repo, record, policy, meter, parent, 1);
    expect(read).toBeDefined();
    expect(pages.mock.calls.length).toBe(2);
    expect(pages.mock.calls.every((args: unknown[]) => args[2] === 1)).toBe(true);
    expect(score).not.toHaveBeenCalled();
    const result = read!.resume();
    expect(result).toMatchObject({ read_bytes: 1, complete: true, resourceLimited: true,
      signal: { source_text_score: null } });
    expect(score).not.toHaveBeenCalled();
    expect(pages.mock.calls.length).toBe(2);
    released(meter);
  });
});

it("keeps canonical_projection dependency refusal unknown without rereading or scoring", async () => {
  await withCanonicalSource(RAW, ({ repo, record, parent, meter, policy, database }) => {
    const updated = database.connection.prepare("UPDATE source_records SET source_representation_json=? WHERE record_id=?")
      .run(JSON.stringify({ kind: "canonical_projection", source_record_ids: [`sha256:${"0".repeat(64)}`] }), record.identity);
    expect(updated.changes).toBe(1);
    const pages = vi.spyOn(repo, "findByIdBounded"), score = vi.spyOn(policy, "source");
    const read = beginCanonicalSourceText(repo, record, policy, meter, parent, Buffer.byteLength(RAW));
    expect(read).toBeDefined();
    const result = read!.resume();
    expect(result).toMatchObject({ read_bytes: 0, complete: false, signal: { source_text_score: null } });
    expect(result.complete).toBe(false);
    expect(score).not.toHaveBeenCalled();
    expect(pages.mock.calls.every((args: unknown[]) => args[2] === 1)).toBe(true);
    released(meter);
  });
});

it("releases deferred holds on close without resume and absorbs executed native work", async () => {
  await withCanonicalSource(RAW, ({ repo, record, parent, meter, policy }) => {
    const read = beginCanonicalSourceText(repo, record, policy, meter, parent, Buffer.byteLength(RAW));
    expect(read).toBeDefined();
    expect(meter.outstandingAllowance().memory_bytes).toBeGreaterThan(meter.spentBytes);
    expect(meter.nativeBytes).toBeGreaterThan(0);
    const spent: [number, number] = [meter.spentWork, meter.spentBytes];
    read!.close(); read!.close();
    released(meter);
    expect([meter.spentWork, meter.spentBytes]).toEqual(spent);
    expect(() => read!.resume()).toThrow(/closed/u);
    const before: [number, number] = [parent.spentWork, parent.spentBytes];
    parent.absorb(meter);
    expect([parent.spentWork, parent.spentBytes]).toEqual([before[0] + spent[0], before[1] + spent[1]]);
  });
});

it("executes the funded first native extent before admitting acquisition metadata", async () => {
  await withIndexedSources([{ id: "raw", text: RAW, vector: [1, 0, 0] }], async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: ORIGINAL, signal: new AbortController().signal,
      remainingMs: () => 60_000 });
    const bodies = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findByIdBounded");
    const admitted = vi.spyOn(SourceSemanticUnionCompletion.prototype, "metadata");
    const headers = vi.spyOn(SqliteSourceHintReader.prototype, "pageBoundInterpretationHeaders");
    const meter = new SourceSemanticReadBudget(QUERY_BUDGET);
    const pool = fixture.database.connection.transaction(() => observeSourceSemanticAccess(
      { database: fixture.database } as RecallReadWorkerRuntime, {
        workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES, prepared_query: prepared, request: preparation
      }, ["project"], meter, ORIGINAL, undefined, "query-conditioned-v1", QUERY_BUDGET))();
    const pages = bodies.mock.calls.map((args, index) => ({
      identity: args[1], maxBytes: args[2] as number, offset: (args[3] as number | undefined) ?? 0,
      order: bodies.mock.invocationCallOrder[index]!
    }));
    const metadataRead = pages.find(row => row.maxBytes === 1 && row.offset === 0);
    expect(metadataRead).toBeDefined();
    const firstExtent = pages.find(row => row.identity === metadataRead!.identity && row.maxBytes > 1
      && row.offset === 0 && row.order > metadataRead!.order);
    expect(firstExtent).toBeDefined();
    const acquisitionOrder = admitted.mock.calls.findIndex(args => Array.isArray(args[0]));
    expect(acquisitionOrder).toBeGreaterThanOrEqual(0);
    expect(firstExtent!.order).toBeLessThan(admitted.mock.invocationCallOrder[acquisitionOrder]!);
    expect(firstExtent!.order).toBeLessThan(headers.mock.invocationCallOrder[0]!);
    expect(pages.some(row => row.identity === firstExtent!.identity && row.maxBytes > 1 && row.offset === 0
      && row.order > firstExtent!.order)).toBe(false);
    expect(pool.access.source_candidates).toContainEqual(expect.objectContaining({ source_id: "raw", complete: true,
      read_bytes: Buffer.byteLength(RAW), body_bytes: Buffer.byteLength(RAW) }));
    expect(sourceSemanticAccessPhases(pool.access).acquisition.status).toBe("executed");
    expect(meter.spentWork).toBeLessThanOrEqual(QUERY_BUDGET.work_units);
    expect(meter.spentBytes).toBeLessThanOrEqual(QUERY_BUDGET.memory_bytes);
    released(meter);
  });
});

it("rethrows an original census failure after the funded first extent instead of returning unknown source body", async () => {
  await withIndexedSources([{ id: "raw", text: RAW, vector: [1, 0, 0] }], async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: ORIGINAL, signal: new AbortController().signal,
      remainingMs: () => 60_000 });
    const failure = new Error("injected census read failure");
    const bodies = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findByIdBounded");
    const headers = vi.spyOn(SqliteSourceHintReader.prototype, "pageBoundInterpretationHeaders")
      .mockImplementation(() => { throw failure; });
    const meter = new SourceSemanticReadBudget(QUERY_BUDGET);
    let caught: unknown, returned: unknown;
    try {
      returned = fixture.database.connection.transaction(() => observeSourceSemanticAccess(
        { database: fixture.database } as RecallReadWorkerRuntime, {
          workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES, prepared_query: prepared, request: preparation
        }, ["project"], meter, ORIGINAL, undefined, "query-conditioned-v1", QUERY_BUDGET))();
    } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect(returned).toBeUndefined();
    expect(headers).toHaveBeenCalled();
    const pages = bodies.mock.calls.map((args, index) => ({
      maxBytes: args[2] as number, offset: (args[3] as number | undefined) ?? 0,
      order: bodies.mock.invocationCallOrder[index]!
    }));
    const metadataRead = pages.find(row => row.maxBytes === 1 && row.offset === 0);
    const firstExtent = pages.find(row => row.maxBytes > 1 && row.offset === 0 && metadataRead !== undefined
      && row.order > metadataRead.order);
    expect(firstExtent).toBeDefined();
    expect(firstExtent!.order).toBeLessThan(headers.mock.invocationCallOrder[0]!);
    expect(meter.nativeBytes).toBeGreaterThan(0);
    released(meter);
  });
});

it("does not reuse a request-local observation across a real source version on the built worker", async () => {
  await withIndexedSources([{ id: "raw", text: RAW, vector: [1, 0, 0] }], async fixture => {
    const client = await fixture.openClient();
    const first = await workerCall(client, preparation);
    const observed = first.access?.source_candidates.find(row => row.source_id === "raw");
    expect(observed).toMatchObject({ complete: true, read_bytes: Buffer.byteLength(RAW),
      body_bytes: Buffer.byteLength(RAW) });
    expect(observed?.record_id).toEqual(expect.any(String));
    const replacement = "Replaced original bytes.";
    await fixture.admit({ id: "raw", text: replacement }, "2");
    const second = await workerCall(client, preparation);
    const next = second.access?.source_candidates.find(row => row.source_id === "raw");
    expect(next?.record_id).not.toBe(observed!.record_id);
    expect(next).toMatchObject({ complete: true, read_bytes: Buffer.byteLength(replacement),
      body_bytes: Buffer.byteLength(replacement) });
    expect(second.access?.source_candidates.some(row => row.record_id === observed!.record_id)).toBe(false);
    expect(fixture.queryBinding.embedInputs).toHaveBeenCalledTimes(2);
    expect(second.work.logical_work).toBeLessThanOrEqual(QUERY_BUDGET.work_units);
    expect(second.work.logical_memory_bytes).toBeLessThanOrEqual(QUERY_BUDGET.memory_bytes);
  });
}, 60_000);
