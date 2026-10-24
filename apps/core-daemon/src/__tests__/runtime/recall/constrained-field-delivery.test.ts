import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecallService, capableRecallConsumerDeclaration } from "@do-soul/alaya-core";
import { MemoryDimension, type Continuation } from "@do-soul/alaya-protocol";
import { closeCachedDatabase, type StorageDatabase } from "@do-soul/alaya-storage";
import { openSourceSlice, NOW, WS } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import { createTaskSurface } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { assertBuiltWorker, builtWorkerUrl } from "./recall-read-worker-client-fixture.js";

it("acknowledges paid computation progress at 120 work through SQLite and the built worker, then delivers every member once", async () => {
  assertBuiltWorker();
  const directory = await mkdtemp(join(tmpdir(), "constrained-field-delivery-")), filename = join(directory, "alaya.db");
  let database: StorageDatabase | undefined;
  const slice = await openSourceSlice(value => { database = value; }, filename);
  const expected = Array.from({ length: 48 }, (_, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(70_000 + index).padStart(12, "0")}`);
  const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1 })!;
  try {
    for (const id of expected) await slice.writeMemory(id, "graduation degree", MemoryDimension.FACT);
    await client.ready();
    const service = new RecallService({ now: () => NOW, generateRuntimeId: () => "aaaaaaaa-aaaa-4aaa-8aaa-999999999999",
      readSnapshot: client.readSnapshot, conditionalFieldPort: client.conditionalFieldPort, activeConstraintsPort: client.activeConstraintsPort });
    const params = { workspaceId: WS, taskSurface: createTaskSurface(), strategy: "chat" as const,
      queryText: "graduation degree", result_kind_view: "memory_only" as const, ...capableRecallConsumerDeclaration(),
      budget: { schema_version: 1 as const, work_units: 120, finalization_reserve: 30, min_envelope: 1,
        page_budget: 3, memory_bytes: 10_000_000 } };
    let continuation: Continuation | null = null;
    const ids: string[] = [], cursors = new Set<string>();
    let sawControl = false, checkedRetry = false;
    for (let page = 0; page < 100; page++) {
      const incoming = continuation;
      const result = await service.recall({ ...params, continuation: incoming });
      ids.push(...result.index.entries.map(entry => entry.object_id!));
      expect(result.execution_receipt?.requested_budget.work_units).toBe(120);
      expect(result.execution_receipt?.actual?.native_visits).toBeLessThanOrEqual(120);
      expect(result.execution_receipt?.actual?.phases.index.budget_work).toBeGreaterThan(0);
      expect(result.issued_delivery_id).toBeDefined();
      continuation = result.index.continuation;
      if (result.index.entries.length === 0 && continuation !== null) {
        expect(result.index.completeness.logical_index).not.toBe("complete");
        if (result.index.representation.page_budget === 0) {
          sawControl = true;
          expect(result.index.completeness.transport).toBe("interrupted");
        }
      }
      if (incoming !== null && result.index.entries.length > 0 && !checkedRetry) {
        const replay = await service.recall({ ...params, continuation: incoming });
        expect(replay.issued_delivery_id).toBe(result.issued_delivery_id);
        expect(replay.index).toEqual({ ...result.index, page_purpose: "retry" });
        checkedRetry = true;
      }
      if (continuation === null) break;
      expect(continuation.emitted_revisions).toBeUndefined();
      expect(cursors.has(continuation.cursor)).toBe(false); cursors.add(continuation.cursor);
    }
    expect(continuation).toBeNull();
    expect(ids).toEqual(expected); expect(new Set(ids).size).toBe(48);
    expect(sawControl).toBe(true); expect(checkedRetry).toBe(true);
  } finally {
    await client.close(); database?.close(); closeCachedDatabase(filename);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
