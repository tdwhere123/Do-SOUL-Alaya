import { afterEach, expect, it } from "vitest";
import { CONDITIONAL_FIELD_SCHEMA_VERSION, MemoryDimension, memoryIndexEntry, type QueryInterpretation } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import { collectObserved } from "../../../../recall/conditional-field/observers/observe-collect.js";
import { observeConditionalField, startObserverCursor } from "../../../../recall/conditional-field/observers/observe.js";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import { RequestCostLedger } from "../../../../recall/runtime/request-cost-ledger.js";
import { meterReaders } from "../../../../recall/runtime/observer-reader-budget.js";
import { BoundedIndexPayload } from "../../../../recall/runtime/index-payload.js";
import { defaultView } from "../../../../recall/conditional-field/query/query-admission.js";
import { defaultBudget } from "../reference/deployment.fixture.js";
import { MEM, NOW, openSourceSlice, WS } from "../vertical/source-slice.js";

const databases = new Set<StorageDatabase>();
const SCHEMA = CONDITIONAL_FIELD_SCHEMA_VERSION;
const SNAPSHOT = "snapshot-source-budget";
const QUERY = "source-budget";
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

it.each(["object", "assertion"] as const)("keeps an unfunded %s source hydration behind its cursor", kind => {
  let calls = 0;
  const query: QueryInterpretation = { schema_version: SCHEMA, query_id: QUERY, status: "resolved",
    snapshot_id: SNAPSHOT, program: { schema_version: SCHEMA, kind: "epsilon" }, view: defaultView(), holes: [], hypotheses: [] };
  const readers = meterReaders({ source: () => { calls += 1; throw new Error("unfunded source read"); } },
    { remaining: 0, cachedBytes: 0 }, new Map());
  const result = collectObserved({
    lease: { schema_version: SCHEMA, lease_id: "lease", snapshot_id: SNAPSHOT, query_id: QUERY, status: "active" },
    cursor: startObserverCursor({ cursor_id: "seed", snapshot_id: SNAPSHOT, query_id: QUERY, region_id: "seed" }),
    query, workspace_id: WS, readers,
    action: { schema_version: SCHEMA, action: "seed", region_id: "seed", work_limit: 5 }
  }, { identities: [MEM.r], identityKind: kind, truncated: false, nativeVisits: 1, bytesRead: 0,
    rows: [{ assertionId: MEM.r, sourceObjectId: MEM.l, targetObjectId: MEM.r, resultObjectId: MEM.r, predicate: "owns" }] });
  expect(calls).toBe(0);
  expect(result.page.outcome.status).toBe("interrupted");
  expect(result.page.observations).toEqual([]);
  expect(result.page.cursor.committed_through).toBeNull();
  expect(result.work.native_visits).toBe(2);
});

it("keeps a completed source lane prefix when fallback memory hydration fails", () => {
  const cost = new RequestCostLedger();
  const query: QueryInterpretation = { schema_version: SCHEMA, query_id: QUERY, status: "resolved",
    snapshot_id: SNAPSHOT, program: { schema_version: SCHEMA, kind: "epsilon" },
    view: { ...defaultView(), result_kind_view: "mixed" }, holes: [], hypotheses: [] };
  const readers = meterReaders({
    sourceRoots: () => ({ rows: [], rowsRead: 0, nativeVisits: 2, nativeBytes: 0, bytesRead: 11, truncated: false }),
    lexical: () => ({ ids: [MEM.r], rowsRead: 1, nativeVisits: 1, nativeBytes: 1, bytesRead: 1, truncated: false }),
    source: () => ({ row: null, rowsRead: 5, bytesRead: 7, unavailable: true })
  }, { remaining: 10_000, cachedBytes: 0 }, new Map(), work => cost.add("seed", work));
  expect(() => observeConditionalField({
    lease: { schema_version: SCHEMA, lease_id: "lease", snapshot_id: SNAPSHOT, query_id: QUERY, status: "active" },
    cursor: startObserverCursor({ cursor_id: "seed", snapshot_id: SNAPSHOT, query_id: QUERY, region_id: "seed" }),
    query, workspace_id: WS, seed_query: "source", readers, authorized_scopes: null,
    action: { schema_version: SCHEMA, action: "seed", region_id: "seed", work_limit: 16 },
    on_failure_work: work => cost.add("seed", work)
  })).toThrowError(expect.objectContaining({ code: "OBLIGATION_VIOLATION" }));
  expect(cost.snapshot().native_visits).toBe(8);
  expect(cost.snapshot().native_bytes).toBe(19);
});

it("reserves the actual four-visit SQLite source read before issuing hydration", async () => {
  const slice = await openSourceSlice(database => databases.add(database));
  await slice.writeMemory(MEM.r, "source body", MemoryDimension.FACT);
  let calls = 0;
  const source = (input: { workspaceId: string; objectId: string; byteLimit?: number }) => {
    calls += 1;
    return slice.memoryReader.source(input.workspaceId, input.objectId, input.byteLimit);
  };
  const query: QueryInterpretation = { schema_version: SCHEMA, query_id: QUERY, status: "resolved",
    snapshot_id: SNAPSHOT, program: { schema_version: SCHEMA, kind: "epsilon" }, view: defaultView(), holes: [], hypotheses: [] };
  const common = {
    lease: { schema_version: SCHEMA, lease_id: "lease", snapshot_id: SNAPSHOT, query_id: QUERY, status: "active" as const },
    cursor: startObserverCursor({ cursor_id: "seed", snapshot_id: SNAPSHOT, query_id: QUERY, region_id: "seed" }),
    query, workspace_id: WS, seed_query: "source body", authorized_scopes: null, as_of: NOW, readers: { source }
  };
  const native = { identities: [MEM.r], truncated: false, nativeVisits: 1, bytesRead: 0, identityKind: "object" as const };
  const action = { schema_version: SCHEMA, action: "seed" as const, region_id: "seed" };
  const short = collectObserved({ ...common, action: { ...action, work_limit: 4 } }, native);
  expect(calls).toBe(0);
  expect(short.page.outcome.status).toBe("interrupted");
  expect(short.work.native_visits).toBe(1);
  const enough = collectObserved({ ...common, action: { ...action, work_limit: 5 } }, native);
  expect(calls).toBe(1);
  expect(enough.work.native_visits).toBe(5);
  expect(enough.page.observations.map(value => value.object_id)).toContain(MEM.r);
  const page = slice.memoryReader.source(WS, MEM.r);
  expect(page.rowsRead).toBe(4);
  if (page.row === null) throw new Error("expected source row");
  const { sourceRevision: _sourceRevision, sourceEventRevision, ...memory } = page.row;
  const hydratedBytes = Buffer.byteLength(JSON.stringify([memory]), "utf8") +
    Buffer.byteLength(JSON.stringify([{ revision: sourceEventRevision }]), "utf8");
  expect(page.bytesRead).toBeGreaterThan(hydratedBytes);
});

it("reserves every SQLite source visit before settling a bound fact demand", async () => {
  const slice = await openSourceSlice(database => databases.add(database));
  await slice.writeMemory(MEM.r, "bound source body", MemoryDimension.FACT);
  const query: QueryInterpretation = { schema_version: SCHEMA, query_id: QUERY, status: "resolved",
    snapshot_id: SNAPSHOT, program: { schema_version: SCHEMA, kind: "epsilon" }, view: defaultView(), holes: [], hypotheses: [] };
  const common = { workspace_id: WS, query_text: "absent", as_of: NOW, authorized_scopes: null };
  const initial = observeField(query, { ...common, budget: defaultBudget(), readers: {} });
  const pending = { ...initial,
    source_fact_demands: new PersistentStringMap<"pending" | "done">().with(MEM.r, "pending"),
    source_fact_pending_count: 1, source_fact_scan_offset: 0, source_fact_demand_bytes: 128 };
  const visits: number[] = [];
  const readers = { source: ({ workspaceId, objectId }: { workspaceId: string; objectId: string }) => {
    const page = slice.memoryReader.source(workspaceId, objectId);
    visits.push(page.rowsRead);
    return page;
  } };
  const short = observeField(query, { ...common, readers, resume_field: pending,
    budget: defaultBudget({ work_units: 6, finalization_reserve: 0, min_envelope: 0 }) });
  expect(visits).toEqual([]);
  expect(short.last_observer_status).toBe("interrupted");
  expect(short.source_fact_demands.get(MEM.r)).toBe("pending");
  const cost = new RequestCostLedger();
  const enough = observeField(query, { ...common, readers, resume_field: short, cost,
    budget: defaultBudget({ work_units: 7, finalization_reserve: 0, min_envelope: 0 }) });
  expect(visits).toEqual([4]);
  expect(enough.source_fact_demands.get(MEM.r)).toBe("done");
  expect(enough.source_facts?.get(MEM.r)).toMatchObject({ content: "bound source body" });
  expect(enough.remaining_exploration).toBe(0);
  expect(cost.snapshot().phases.observe).toMatchObject({ native_visits: 4, native_rows: 1, joins: 3 });
});

it("reserves SQLite source hydration plus payload bookkeeping before publishing a preview", async () => {
  const slice = await openSourceSlice(database => databases.add(database));
  await slice.writeMemory(MEM.r, "payload source body", MemoryDimension.FACT);
  const source = slice.memoryReader.source(WS, MEM.r);
  if (source.row === null) throw new Error("expected retained memory source");
  const entry = memoryIndexEntry({ workspace_id: WS, object_id: MEM.r,
    source_revision: source.row.sourceRevision, association_milligrades: 1000 });
  let calls = 0;
  const payload = new BoundedIndexPayload({ workspaceId: WS, asOf: NOW,
    remainingMemoryBytes: 100_000, manifestationFor: () => "excerpt", readers: {
      source: ({ workspaceId, objectId }) => { calls += 1; return slice.memoryReader.source(workspaceId, objectId); }
    } });
  expect(payload.finalize([entry], 5)).toMatchObject({ remaining: 5, complete: false });
  expect(calls).toBe(0);
  expect(payload.previews.size).toBe(0);
  expect(payload.finalize([entry], 6)).toMatchObject({ remaining: 0, complete: true });
  expect(calls).toBe(1);
  expect(payload.previews.get(MEM.r)).toBe("payload source body");
  expect(payload.takeWork()).toMatchObject({ native_visits: 4, native_rows: 1 });
});

it("pays cached source lookup and payload work without inventing native visits or rows", () => {
  const payload = new BoundedIndexPayload({ workspaceId: WS, remainingMemoryBytes: 10_000,
    manifestationFor: () => "excerpt", readers: { source: () => ({
      row: { object_id: MEM.r, sourceRevision: "rev", content: "cached source" },
      rowsRead: 0, bytesRead: 0, unavailable: false
    }) } });
  const entry = memoryIndexEntry({ workspace_id: WS, object_id: MEM.r, source_revision: "rev", association_milligrades: 1000 });
  expect(payload.finalize([entry], 6)).toMatchObject({ remaining: 3, complete: true });
  expect(payload.takeWork()).toMatchObject({ native_visits: 0, native_rows: 0, native_bytes: 0 });
  expect(payload.previews.get(MEM.r)).toBe("cached source");
});

it("preserves an oversized source receipt as failure evidence without publishing payload", () => {
  const cost = new RequestCostLedger();
  const payload = new BoundedIndexPayload({ workspaceId: WS, remainingMemoryBytes: 1000,
    manifestationFor: () => "excerpt", onSourceReadFailure: work => cost.add("payload", work),
    readers: { source: () => ({ row: null, rowsRead: 5, bytesRead: 7, unavailable: true }) } });
  const entry = memoryIndexEntry({ workspace_id: WS, object_id: MEM.r, source_revision: "rev", association_milligrades: 1000 });
  expect(() => payload.finalize([entry], 6)).toThrowError(expect.objectContaining({ code: "OBLIGATION_VIOLATION",
    details: { source_read: { native_visits: 5, native_bytes: 7 } } }));
  expect(payload.previews.size).toBe(0);
  expect(cost.snapshot().phases.payload).toMatchObject({ native_visits: 5, native_bytes: 7 });
});
