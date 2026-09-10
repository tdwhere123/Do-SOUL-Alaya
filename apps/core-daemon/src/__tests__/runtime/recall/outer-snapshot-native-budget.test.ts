import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDimension, type RequestBudget } from "@do-soul/alaya-protocol";
import { runConditionalFieldRecall, snapshotIdFromPin } from "@do-soul/alaya-core";
import { SqliteIndexedRecallProjection, type StorageDatabase } from "@do-soul/alaya-storage";
import { createConditionalFieldObserverReaders, runConditionalFieldWorkerRecall } from "../../../runtime/recall-read-worker/observer-operations.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { createBoundedActiveConstraintsReader } from "../../../runtime/recall-read-worker/active-constraints.js";
import { MEM, WS, NOW, openSourceSlice } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import { defaultBudget } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/reference/deployment.fixture.js";

const databases = new Set<StorageDatabase>();
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases) database.close();
  databases.clear();
});

describe("outer recall snapshot native allowance", () => {
  it.each([true, false])("constructs query-only cold readers without DDL when recall indexes exist=%s", async (indexed) => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await slice.writeMemory(MEM.r, "needle", MemoryDimension.FACT);
    if (!indexed) {
      slice.database.connection.exec("DROP INDEX IF EXISTS idx_relation_recall_subject; DROP INDEX IF EXISTS idx_relation_recall_predicate;");
    }
    slice.database.connection.pragma("query_only = ON");
    const executed = vi.spyOn(slice.database.connection, "exec");
    const prepared = vi.spyOn(slice.database.connection, "prepare");
    const governance = createBoundedActiveConstraintsReader(slice.database)({
      workspaceId: WS, asOf: NOW, nativeLimit: 128, byteLimit: 65536
    });
    expect(governance.completeness).toBe("complete");
    const result = runConditionalFieldWorkerRecall(runtime(slice.database), {
      ...payload(defaultBudget()), governance
    });
    expect(result.index.entries.map((entry) => entry.object_id)).toContain(MEM.r);
    expect(executed).not.toHaveBeenCalled();
    expect(prepared.mock.calls.every(([sql]) => !/^\s*(CREATE|DROP|ALTER)\b/iu.test(sql))).toBe(true);
  });

  it.each(["direct", "cold worker"] as const)("%s rejects a tiny budget before any pin or SQL work", async (route) => {
    const slice = await openSourceSlice((database) => databases.add(database));
    const readers = route === "direct" ? createConditionalFieldObserverReaders(slice.database) : undefined;
    const request = payload(defaultBudget({ work_units: 3, finalization_reserve: 0, min_envelope: 1 }));
    const prepared = vi.spyOn(slice.database.connection, "prepare");
    const executed = vi.spyOn(slice.database.connection, "exec");
    const pin = vi.spyOn(SqliteIndexedRecallProjection.prototype, "observablePin");
    const index = readers === undefined
      ? runConditionalFieldWorkerRecall(runtime(slice.database), request).index
      : runConditionalFieldRecall({ ...request, readers });
    expect(index.entries).toEqual([]);
    expect(index.completeness.logical_index).not.toBe("complete");
    expect(pin).not.toHaveBeenCalled();
    expect(prepared).not.toHaveBeenCalled();
    expect(executed).not.toHaveBeenCalled();
  });

  it.each(["direct", "cold worker"] as const)("%s rejects malformed allowance without touching storage", async (route) => {
    const slice = await openSourceSlice((database) => databases.add(database));
    const readers = route === "direct" ? createConditionalFieldObserverReaders(slice.database) : undefined;
    const prepared = vi.spyOn(slice.database.connection, "prepare");
    const executed = vi.spyOn(slice.database.connection, "exec");
    for (const work_units of [-1, Number.NaN]) {
      const request = payload(defaultBudget({ work_units }));
      let index;
      let failure;
      try {
        index = readers === undefined
          ? runConditionalFieldWorkerRecall(runtime(slice.database), request).index
          : runConditionalFieldRecall({ ...request, readers });
      } catch (error) {
        failure = error;
      }
      if (index !== undefined) {
        expect(index.entries).toEqual([]);
        expect(index.completeness.logical_index).not.toBe("complete");
      } else {
        expect(failure).toBeInstanceOf(Error);
      }
    }
    expect(prepared).not.toHaveBeenCalled();
    expect(executed).not.toHaveBeenCalled();
  });

  it.each(["direct", "cold worker"] as const)("%s executes real pin SQL and sees another source at the identical timestamp", async (route) => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await slice.writeMemory(MEM.r, "needle first", MemoryDimension.FACT);
    const readers = createConditionalFieldObserverReaders(slice.database);
    const pinCalls = vi.spyOn(SqliteIndexedRecallProjection.prototype, "observablePin");
    const native = trackNativePinQueries(slice.database);
    const run = () => {
      const snapshot_id = snapshotIdFromPin(WS, slice.indexProjection.observablePin(WS));
      const request = { ...payload(defaultBudget()), snapshot_id };
      return route === "direct" ? runConditionalFieldRecall({ ...request, readers })
        : runConditionalFieldWorkerRecall(runtime(slice.database), request).index;
    };
    const before = run();
    expect(before.entries.map((entry) => entry.object_id)).toContain(MEM.r);
    const beforePinCalls = pinCalls.mock.calls.length;
    expect(beforePinCalls).toBeGreaterThanOrEqual(3);
    expect(native).toHaveLength(beforePinCalls * 2);
    await slice.writeMemory(MEM.c, "needle second", MemoryDimension.FACT);
    const after = run();
    expect(after.entries.map((entry) => entry.object_id)).toContain(MEM.c);
    expect(after.snapshot_id).not.toBe(before.snapshot_id);
    expect(native).toHaveLength(pinCalls.mock.calls.length * 2);
    const rows = slice.database.connection.prepare("SELECT created_at FROM memory_entries WHERE object_id IN (?, ?)")
      .all(MEM.r, MEM.c) as { created_at: string }[];
    expect(rows.map((row) => row.created_at)).toEqual([NOW, NOW]);
  });
});

function payload(budget: RequestBudget) {
  return {
    workspace_id: WS, query_text: "needle", budget,
    snapshot_id: `sha256:${"a".repeat(64)}`, interpretation_clock: NOW, as_of: NOW,
    expires_at: "2027-01-01T00:00:00.000Z", lifetime_now: NOW,
    protocol_version: 1 as const,
    supports_source_evidence: true,
    supported_result_kinds: ["memory_entry", "source_evidence"] as const
  };
}

function runtime(database: StorageDatabase): RecallReadWorkerRuntime {
  return { database, closed: false } as RecallReadWorkerRuntime;
}

function trackNativePinQueries(database: StorageDatabase): string[] {
  const queries: string[] = [];
  const prepare = database.connection.prepare.bind(database.connection);
  vi.spyOn(database.connection, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (/SELECT observable_epoch|SELECT json_array\(/u.test(sql)) {
      const get = statement.get.bind(statement);
      vi.spyOn(statement, "get").mockImplementation((...params) => {
        queries.push(sql);
        return get(...params);
      });
    }
    return statement;
  });
  return queries;
}
