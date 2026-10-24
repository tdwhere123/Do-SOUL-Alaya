import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => isolation.restore());
import { MemoryDimension, SNAPSHOT_PIN_NATIVE_WORK, sourceGoldRootIdentity, sourceRecallTarget,
  type InformationIndex, type Continuation } from "@do-soul/alaya-protocol";
import { SqliteFieldSourceRecordRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { runConditionalFieldRecallWithReceipt, captureIndexPreviews, type ConditionalFieldRecallRequest } from "@do-soul/alaya-core";
import { readersFor } from "../../../../../../packages/core/src/__tests__/recall/conditional-field-oracle/bound-producer.js";
import { FAR_FUTURE_EXPIRY, defaultBudget } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/reference/deployment.fixture.js";
import { MEM, NOW, WS, openSourceSlice } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import { fieldSha256, hashedRecord } from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";
import { createConditionalFieldObserverReaders } from "../../../runtime/recall-read-worker/observer-operations.js";
import { commitIssuedDelivery, replayIssuedSurfaces } from "../../../../../../packages/core/src/recall/runtime/recall-index-commit.js";
import { evictIssuedDeliveries, replayIssuedDelivery } from "../../../../../../packages/core/src/recall/runtime/index-continuation.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const db of databases) db.close(); databases.clear(); });

it.each(["settled", "unserviceable"] as const)("keeps the %s empty tail page retry identity", async (kind) => {
  const { slice, input: base } = await fixture(true);
  const record = hashedRecord(WS, "needle only", "only");
  new SqliteFieldSourceRecordRepo(slice.database, fieldSha256).insert(record);
  // A source-only page is nominated through the native inventory, not through the
  // retired exhaustive source-root enumeration.
  const input = nominated(base, [record]);
  const first = runConditionalFieldRecallWithReceipt(input);
  expect(first.index.continuation).not.toBeNull();
  const request = { ...input, continuation: first.index.continuation,
    ...(kind === "unserviceable" ? { budget: { ...input.budget,
      work_units: SNAPSHOT_PIN_NATIVE_WORK * 3 + 1, finalization_reserve: 0, min_envelope: 1 } } : {}) };
  const closed = runConditionalFieldRecallWithReceipt(request, { issue: "defer" });
  expect(closed.index.entries).toHaveLength(0);
  expect(closed.index.continuation).toBeNull();
  expect(closed.delivery_id).toBeDefined();
  const id = closed.issue!({ index: closed.index, previews: new Map(), metadata: {} });
  const retry = runConditionalFieldRecallWithReceipt(request, { issue: "defer" });
  expect(retry.delivery_id).toBe(id);
  expect(retry.index.entries).toEqual(closed.index.entries);
  expect(retry.index.continuation).toBeNull();
  expect(retry.issue!({ index: retry.index, previews: new Map(), metadata: {} })).toBe(id);
});

it("reports a constrained unfinished page as retryable progress, not a size impossibility", async () => {
  const { slice, input: base } = await fixture(true);
  // Unlike the settled tail above, this page still owes an undelivered source.
  const records = [hashedRecord(WS, "needle first", "first"), hashedRecord(WS, "needle second", "second")];
  const repo = new SqliteFieldSourceRecordRepo(slice.database, fieldSha256);
  for (const record of records) repo.insert(record);
  const input = nominated(base, records);
  const first = runConditionalFieldRecallWithReceipt(input);
  expect(first.index.continuation).not.toBeNull();
  // A budget that only covers the pin plus a fragment of the page work.
  const constrained = { ...input, continuation: first.index.continuation, budget: { ...input.budget,
    work_units: SNAPSHOT_PIN_NATIVE_WORK * 3 + 1, finalization_reserve: 0, min_envelope: 1 } };
  // Unlike a measured size refusal, insufficient framing work cannot establish
  // fit. It must refuse without acknowledging or consuming the original token.
  expect(() => runConditionalFieldRecallWithReceipt(constrained, { issue: "defer" }))
    .toThrow(expect.objectContaining({ code: "CONFLICT", details: expect.objectContaining({
      resource: "framing_work", execution_receipt: expect.objectContaining({ actual: expect.any(Object) }) }) }));
  const recovered = runConditionalFieldRecallWithReceipt({ ...input, continuation: first.index.continuation });
  expect(recovered.index.completeness.logical_index).not.toBe("invalidated");
  expect(recovered.index.entries).toHaveLength(1);
  expect(recovered.index.entries[0]!.target).not.toEqual(first.index.entries[0]!.target);
});

it("refuses interrupted framing without issuing its unfitted members and recovers on retry", async () => {
  const { slice, input } = await fixture();
  await slice.writeMemory(MEM.r, "needle member", MemoryDimension.FACT);
  const encode = vi.fn(() => ({ large: "x".repeat(100_000) }));
  expect(() => runConditionalFieldRecallWithReceipt({ ...input, encode_page: encode,
    budget: { ...input.budget, work_units: 120, finalization_reserve: 30 } }, { issue: "defer" }))
    .toThrow(expect.objectContaining({ code: "CONFLICT", details: expect.objectContaining({
      resource: "framing_work", execution_receipt: expect.objectContaining({ actual: expect.any(Object) }) }) }));
  expect(encode).toHaveBeenCalledTimes(1);
  const recovered = runConditionalFieldRecallWithReceipt({ ...input, encode_page: encode });
  expect(recovered.index.entries.map(entry => entry.object_id)).toEqual([MEM.r]);
  expect(recovered.index.completeness.transport).not.toBe("interrupted");
  expect(encode).toHaveBeenCalledTimes(2);
});

/** Native inventory for fixtures that used to rely on exhaustive source enumeration. */
function nominated(input: ConditionalFieldRecallRequest, records: readonly ReturnType<typeof hashedRecord>[]) {
  const roots = records.map(record => sourceRecallTarget({ workspace_id: record.workspace_id,
    root_kind: "source_record", root_id: record.record_id, source_version: record.source_version,
    content_digest: record.content_digest, evidence_object_id: record.evidence_object_id }));
  const positions = Object.fromEntries(roots.map((root, index) => [sourceGoldRootIdentity(root), index]));
  const nominate = input.readers.nominateSources!;
  return { ...input, readers: { ...input.readers, nominateSources: (seed: Parameters<typeof nominate>[0]) => {
    const captured = nominate(seed);
    return { ...captured, admitted_roots: roots, catalog_positions: positions };
  } } };
}

async function fixture(source = false) {
  const slice = await openSourceSlice((db) => databases.add(db));
  const readers = source ? createConditionalFieldObserverReaders(slice.database) : readersFor(slice);
  const budget = defaultBudget({ work_units: 2_000, page_budget: 1, finalization_reserve: 50, min_envelope: 1 });
  const input: ConditionalFieldRecallRequest = { workspace_id: WS, query_text: "needle", budget,
    requested_budget: budget, snapshot_id: `sha256:${"a".repeat(64)}`, interpretation_clock: NOW,
    as_of: NOW, expires_at: FAR_FUTURE_EXPIRY, lifetime_now: NOW, readers, protocol_version: 1,
    supports_source_evidence: true, supported_result_kinds: ["memory_entry", "source_evidence"],
    authorized_scopes: null, ...(source ? { result_kind_view: "source_only" as const } : {}) };
  return { slice, input };
}

it("retries unissued preparation and prevents stale acknowledgment from overwriting its successor", async () => {
  const { slice, input } = await fixture();
  for (const [i, id] of [MEM.r, MEM.c, MEM.h, MEM.s].entries()) await slice.writeMemory(id, `needle ${i}`, MemoryDimension.FACT);
  const first = runConditionalFieldRecallWithReceipt(input);
  const request = { ...input, continuation: first.index.continuation };
  const abandoned = runConditionalFieldRecallWithReceipt(request, { issue: "defer" });
  expect(() => abandoned.issue!({ index: { ...abandoned.index, entries: [] }, previews: new Map(), metadata: {} }))
    .toThrow("Recall envelope changed prepared membership");
  const retry = runConditionalFieldRecallWithReceipt(request, { issue: "defer" });
  expect(retry.index.entries).toEqual(abandoned.index.entries);
  expect(retry.index.completeness.logical_index).not.toBe("invalidated");
  retry.issue!({ index: retry.index, previews: new Map(), metadata: {} });
  expect(() => abandoned.issue!({ index: abandoned.index, previews: new Map(), metadata: {} })).toThrow("stale prepared");
  const successor = runConditionalFieldRecallWithReceipt({ ...input, continuation: retry.index.continuation });
  retry.issue!({ index: retry.index, previews: new Map(), metadata: {} });
  const next = runConditionalFieldRecallWithReceipt({ ...input, continuation: successor.index.continuation });
  expect(next.index.completeness.logical_index).not.toBe("invalidated");
});

it("hydrates only the delivered target within the requested byte range and preserves the next member", async () => {
  const { slice, input: base } = await fixture(true);
  const repo = new SqliteFieldSourceRecordRepo(slice.database, fieldSha256);
  const records = [hashedRecord(WS, "needle first", "first"), hashedRecord(WS, "needle second", "second")];
  for (const record of records) repo.insert(record);
  const input = nominated(base, records);
  const first = runConditionalFieldRecallWithReceipt(input).index;
  expect(first.entries).toHaveLength(1);
  const target = first.entries[0]!.target;
  const request: ConditionalFieldRecallRequest = { ...input, continuation: first.continuation,
    payload_continuation: { schema_version: 1, purpose: "payload_expansion", target, start_offset: 0, byte_budget: 4 } };
  const expanded = runConditionalFieldRecallWithReceipt(request).index;
  expect(expanded.page_purpose).toBe("payload");
  expect(expanded.entries).toHaveLength(1);
  expect(expanded.entries[0]!.target).toMatchObject({ ...target, span: { content_start: 0, content_end: 4, content_complete: false } });
  const previews = captureIndexPreviews(expanded, input.readers, WS);
  expect([...previews.values()].some((value) => value === "need")).toBe(true);
  expect([...previews.values()].reduce((bytes, text) => bytes + Buffer.byteLength(text), 0)).toBeLessThanOrEqual(4);
  const replayed = runConditionalFieldRecallWithReceipt(request).index;
  expect(replayed.entries).toEqual(expanded.entries);
  expect(replayed.page_purpose).toBe("retry");
  const differentRange = runConditionalFieldRecallWithReceipt({ ...request,
    payload_continuation: { ...request.payload_continuation!, start_offset: 4, byte_budget: 3 } }).index;
  expect(differentRange.entries[0]!.target).toMatchObject({ span: { content_start: 4, content_end: 7 } });
  const zero = runConditionalFieldRecallWithReceipt({ ...request,
    payload_continuation: { ...request.payload_continuation!, byte_budget: 0 } }).index;
  expect(zero.entries[0]!.target).not.toHaveProperty("span");
  expect(captureIndexPreviews(zero, input.readers, WS).size).toBe(0);
  expect(zero.completeness.payload).not.toBe("complete");
  const next = runConditionalFieldRecallWithReceipt({ ...input, continuation: first.continuation }).index;
  expect(next.entries).toHaveLength(1);
  expect(next.entries[0]!.target).not.toMatchObject({ root_id: target.kind === "source_evidence" ? target.root_id : "" });
});

it("rejects unissued targets, forged source epochs, and changed scope or snapshot", async () => {
  const { slice, input: base } = await fixture(true);
  const repo = new SqliteFieldSourceRecordRepo(slice.database, fieldSha256);
  const records = [hashedRecord(WS, "needle first", "first"), hashedRecord(WS, "needle second", "second")];
  for (const record of records) repo.insert(record);
  const input = nominated(base, records);
  const first = runConditionalFieldRecallWithReceipt(input).index;
  const target = first.entries[0]!.target;
  if (target.kind !== "source_evidence") throw new Error("source expected");
  const unissued = records.find((record) => record.record_id !== target.root_id)!;
  const request: ConditionalFieldRecallRequest = { ...input, continuation: first.continuation,
    payload_continuation: { schema_version: 1, purpose: "payload_expansion", target, byte_budget: 4 } };
  for (const candidate of [
    { ...request, payload_continuation: { ...request.payload_continuation!, target: { ...target,
      root_id: unissued.record_id, content_digest: unissued.content_digest } } },
    { ...request, payload_continuation: { ...request.payload_continuation!, target: { ...target, root_id: "forged" } } },
    { ...request, payload_continuation: { ...request.payload_continuation!, target: { ...target, source_version: "forged" } } },
    { ...request, payload_continuation: { ...request.payload_continuation!, target: { ...target, evidence_object_id: MEM.r } } },
    { ...request, authorized_scopes: [] },
    { ...request, snapshot_id: `sha256:${"b".repeat(64)}` }
  ]) expect(runConditionalFieldRecallWithReceipt(candidate).index.completeness.logical_index).toBe("invalidated");
});

it("does not repeat membership when a source payload remains incomplete", async () => {
  const { slice, input: base } = await fixture(true);
  const record = hashedRecord(WS, `needle ${"x".repeat(9000)}`, "large");
  new SqliteFieldSourceRecordRepo(slice.database, fieldSha256).insert(record);
  const input = nominated(base, [record]);
  const first = runConditionalFieldRecallWithReceipt(input).index;
  expect(first.entries).toHaveLength(1);
  expect(first.continuation).not.toBeNull();
  const next = runConditionalFieldRecallWithReceipt({ ...input, continuation: first.continuation }).index;
  expect(next.entries).toHaveLength(0);
});

it("bounds source surfaces with issued pages and deletes them on query eviction", () => {
  const index = { query_id: "eviction", snapshot_id: "snapshot", entries: [] } as unknown as InformationIndex;
  for (let i = 0; i < 33; i++) commitIssuedDelivery({ query_key: i === 32 ? "other" : "eviction",
    request_digest: `eviction-${i}`, index, request: { continuation_id: `eviction-${i}` } as Continuation,
    previews: new Map([["key", "protected source bytes"]]), metadata: { key: {} } });
  expect(replayIssuedDelivery("eviction-0")).toBeUndefined();
  expect(replayIssuedSurfaces("eviction-0")).toBeUndefined();
  evictIssuedDeliveries("eviction");
  for (let i = 0; i < 32; i++) expect(replayIssuedSurfaces(`eviction-${i}`)).toBeUndefined();
  expect(replayIssuedSurfaces("eviction-32")?.previews.get("key")).toBe("protected source bytes");
  evictIssuedDeliveries("other");
  expect(replayIssuedSurfaces("eviction-32")).toBeUndefined();
});
