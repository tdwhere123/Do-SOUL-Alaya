import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDimension, type InformationIndex, type RequestBudget } from "@do-soul/alaya-protocol";
import type { ConditionalFieldRecallPortResult, ObserverReaders } from "@do-soul/alaya-core";
import { type StorageDatabase } from "@do-soul/alaya-storage";
import { runConditionalFieldWorkerRecall } from "../../../runtime/recall-read-worker/observer-operations.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import {
  RSS_SAMPLING_METHOD,
  withWorkerActualCost,
  workerActualCostOf,
  type WorkerActualCost
} from "../../../runtime/recall/worker-actual-cost.js";
import { MEM, NOW, WS, openSourceSlice } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import {
  FAR_FUTURE_EXPIRY,
  defaultBudget
} from "../../../../../../packages/core/src/__tests__/recall/conditional-field/reference/deployment.fixture.js";

const databases = new Set<StorageDatabase>();
const directories: string[] = [];
afterEach(async () => {
  for (const database of databases) database.close();
  databases.clear();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("native worker actual cost", () => {
  it("charges reader pages instead of copying the requested work_units", () => {
    const readers: ObserverReaders = {
      lexical: () => ({
        ids: ["a"], nativeVisits: 4, nativeBytes: 12, rowsRead: 4, bytesRead: 12, truncated: false
      })
    };
    const executed = withWorkerActualCost(readers, (instrumented) => {
      instrumented.lexical!({
        workspaceId: WS, query: "needle", limit: 8, nativeLimit: 8, afterObjectId: null
      });
      return { execution_receipt: compileReceipt(defaultBudget({ work_units: 10_000 })) };
    });
    const cost = workerActualCostOf(executed.execution_receipt);
    expect(cost.native_visits).toBe(4);
    expect(cost.row_visits).toBe(4);
    expect(cost.bytes_read).toBe(12);
    expect(cost.native_visits).not.toBe(10_000);
    expect(cost.rss_sampling_method).toBe(RSS_SAMPLING_METHOD);
    expect(cost.rss_bytes).toBeGreaterThan(0);
    expect(cost.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it("charges nativeWork when nativeVisits is explicitly 0", () => {
    const readers: ObserverReaders = {
      sourceRoots: () => ({
        rows: [], nativeVisits: 0, nativeBytes: 0, rowsRead: 0, bytesRead: 0, nativeWork: 1, truncated: false
      })
    };
    const executed = withWorkerActualCost(readers, (instrumented) => {
      instrumented.sourceRoots!({
        workspaceId: WS, query: "needle", limit: 8, nativeLimit: 8, afterCursor: null
      });
      return { execution_receipt: compileReceipt(defaultBudget({ work_units: 10_000 })) };
    });
    expect(workerActualCostOf(executed.execution_receipt).native_visits).toBe(1);
  });

  it("reports measured visits/rows/bytes bounded by work_units on the shipped worker dispatch", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    for (const [id, text] of [[MEM.r, "needle first"], [MEM.c, "needle second"], [MEM.h, "needle third"]]) {
      await slice.writeMemory(id!, text!, MemoryDimension.FACT);
    }
    const budget = defaultBudget({ work_units: 240, finalization_reserve: 20, min_envelope: 1, page_budget: 10 });
    const result = runConditionalFieldWorkerRecall(runtime(slice.database), payload(budget, "needle"));
    const cost = assertMeasuredWork(result, budget);
    expect(result.index.entries.map((entry) => entry.object_id).sort())
      .toEqual([MEM.c, MEM.h, MEM.r].sort());
    expect(cost.native_visits).toBeGreaterThan(0);
    expect(cost.row_visits).toBeGreaterThan(0);
    expect(cost.bytes_read).toBeGreaterThan(0);
    expect(cost.native_visits).not.toBe(budget.work_units);
    expect(cost.native_visits).not.toBe(result.execution_receipt!.requested_budget.work_units);
    expect(cost.native_visits).not.toBe(result.execution_receipt!.compile_input.budget.work_units);
  });

  it("samples live process RSS via process.memoryUsage().rss", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await slice.writeMemory(MEM.r, "needle", MemoryDimension.FACT);
    const result = runConditionalFieldWorkerRecall(runtime(slice.database), payload(defaultBudget(), "needle"));
    const cost = workerActualCostOf(result.execution_receipt);
    expect(cost.rss_sampling_method).toBe("process.memoryUsage().rss");
    expect(cost.rss_bytes).toBeGreaterThan(0);
    expect(cost.rss_bytes).not.toBe(result.execution_receipt!.requested_budget.memory_bytes);
  });

  it("records chain, hub, and multi-page continuation with cold vs repeat cost on one SQLite file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alaya-worker-cost-"));
    directories.push(directory);
    const filename = join(directory, "field.sqlite");
    const slice = await openSourceSlice((database) => databases.add(database), filename);
    const relationQuery = "find observed_log from x to y";
    const hub = MEM.r;
    const chain = [MEM.c, MEM.h, MEM.u];
    const spokes = [MEM.l, MEM.s, MEM.p, MEM.sb];
    await slice.writeMemory(hub, relationQuery, MemoryDimension.FACT);
    for (const [index, id] of chain.entries()) {
      await slice.writeMemory(id, `chain node ${index}`, MemoryDimension.FACT);
    }
    for (const [index, id] of spokes.entries()) {
      await slice.writeMemory(id, `hub spoke ${index}`, MemoryDimension.FACT);
    }
    await link(slice, hub, chain[0]!, 1);
    await link(slice, chain[0]!, chain[1]!, 2);
    await link(slice, chain[1]!, chain[2]!, 3);
    for (const [index, spoke] of spokes.entries()) await link(slice, hub, spoke, 10 + index);
    const lexicalIds = Array.from({ length: 18 }, (_, index) =>
      `aaaaaaaa-aaaa-4aaa-8aaa-${String(30_000 + index).padStart(12, "0")}`);
    for (const id of lexicalIds) await slice.writeMemory(id, "needle page", MemoryDimension.FACT);

    const graphBudget = defaultBudget({
      work_units: 2_000, memory_bytes: 1_000_000, page_budget: 20, finalization_reserve: 80, min_envelope: 1
    });
    const coldGraph = collectPages(slice.database, graphBudget, relationQuery, 20);
    const repeatGraph = collectPages(slice.database, graphBudget, relationQuery, 20);
    expect(members(repeatGraph)).toEqual(members(coldGraph));
    expect(members(coldGraph).length).toBeGreaterThan(0);
    const largerGraph = collectPages(slice.database, { ...graphBudget, work_units: 8_000 }, relationQuery, 20);
    expect(members(largerGraph)).toEqual(members(coldGraph));
    const coldCost = workerActualCostOf(coldGraph[0]!.execution_receipt);
    const repeatCost = workerActualCostOf(repeatGraph[0]!.execution_receipt);
    expect(coldCost.rss_sampling_method).toBe(RSS_SAMPLING_METHOD);
    expect(repeatCost.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(coldCost.native_visits).toBeLessThanOrEqual(graphBudget.work_units);
    expect(repeatCost.native_visits).toBeLessThanOrEqual(graphBudget.work_units);

    const pageBudget = defaultBudget({
      work_units: 2_000, page_budget: 5, finalization_reserve: 40, min_envelope: 1
    });
    const pages = collectPages(slice.database, pageBudget, "needle page", 40, {
      result_kind_view: "memory_only"
    });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.at(-1)!.index.continuation).toBeNull();
    expect(pages.some((page) => page.index.continuation !== null)).toBe(true);
    const delivered = pages.flatMap((page) => page.index.entries.flatMap((entry) =>
      entry.object_id === undefined || entry.object_id.length === 0 ? [] : [entry.object_id]));
    expect(new Set(delivered)).toEqual(new Set(lexicalIds));
    for (const page of pages) {
      const cost = workerActualCostOf(page.execution_receipt);
      expect(cost.native_visits).toBeLessThanOrEqual(pageBudget.work_units);
      expect(cost.rss_bytes).toBeGreaterThan(0);
    }
  });

  it.each([0, 1, 3])("rejects an unserviceable %i-unit budget without consuming a never-sent product", async (work_units) => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await slice.writeMemory(MEM.r, "needle", MemoryDimension.FACT);
    const budget = defaultBudget({ work_units, finalization_reserve: 0, min_envelope: 1, page_budget: 1 });
    const result = runConditionalFieldWorkerRecall(runtime(slice.database), payload(budget, "needle"));
    const cost = workerActualCostOf(result.execution_receipt);
    expect(result.index.entries).toEqual([]);
    expect(result.index.continuation).toBeNull();
    expect(result.index.completeness.logical_index).not.toBe("complete");
    expect(cost.native_visits).toBe(0);
    expect(cost.row_visits).toBe(0);
    expect(cost.bytes_read).toBe(0);
  });

  it("replays the same delivery_id when retrying a last page with null continuation", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    for (const [index, id] of [MEM.r, MEM.c, MEM.h].entries()) {
      await slice.writeMemory(id, `needle ${index}`, MemoryDimension.FACT);
    }
    const budget = defaultBudget({
      work_units: 2_000, page_budget: 1, finalization_reserve: 20, min_envelope: 1
    });
    const pages = collectPages(slice.database, budget, "needle", 8);
    expect(pages.length).toBeGreaterThan(1);
    const last = pages.at(-1)!;
    expect(last.index.continuation).toBeNull();
    expect(last.issued_delivery_id).toBeDefined();
    const prior = pages.at(-2)!;
    expect(prior.index.continuation).not.toBeNull();
    const retry = runConditionalFieldWorkerRecall(runtime(slice.database), {
      ...payload(budget, "needle"),
      continuation: prior.index.continuation
    });
    expect(retry.index.continuation).toBeNull();
    expect(retry.issued_delivery_id).toBe(last.issued_delivery_id);
    expect(retry.index.entries.map((entry) => entry.object_id))
      .toEqual(last.index.entries.map((entry) => entry.object_id));
  });
});

function assertMeasuredWork(
  result: ConditionalFieldRecallPortResult,
  budget: RequestBudget
): WorkerActualCost {
  const cost = workerActualCostOf(result.execution_receipt);
  expect(cost.native_visits).toBeLessThanOrEqual(budget.work_units);
  expect(cost.row_visits).toBeLessThanOrEqual(budget.work_units);
  expect(cost.elapsed_ms).toBeGreaterThanOrEqual(0);
  expect(cost.rss_bytes).toBeGreaterThan(0);
  expect(cost.rss_sampling_method).toBe(RSS_SAMPLING_METHOD);
  return cost;
}

function collectPages(
  database: StorageDatabase,
  budget: RequestBudget,
  query: string,
  maximum: number,
  extra: Record<string, unknown> = {}
): ConditionalFieldRecallPortResult[] {
  const pages: ConditionalFieldRecallPortResult[] = [];
  let continuation: InformationIndex["continuation"] = null;
  const worker = runtime(database);
  for (let attempt = 0; attempt < maximum; attempt += 1) {
    const page = runConditionalFieldWorkerRecall(worker, {
      ...payload(budget, query), ...extra, continuation
    });
    pages.push(page);
    continuation = page.index.continuation;
    if (continuation === null) break;
  }
  return pages;
}

function members(pages: readonly ConditionalFieldRecallPortResult[]): string[] {
  return [...new Set(pages.flatMap((page) => page.index.entries.flatMap((entry) =>
    entry.object_id === undefined || entry.object_id.length === 0 ? [] : [entry.object_id])))].sort();
}

function payload(budget: RequestBudget, query: string) {
  return {
    workspace_id: WS,
    query_text: query,
    budget,
    requested_budget: budget,
    snapshot_id: `sha256:${"a".repeat(64)}`,
    interpretation_clock: NOW,
    as_of: NOW,
    expires_at: FAR_FUTURE_EXPIRY,
    lifetime_now: NOW,
    protocol_version: 1 as const,
    supports_source_evidence: true,
    supported_result_kinds: ["memory_entry", "source_evidence"] as const
  };
}

function runtime(database: StorageDatabase): RecallReadWorkerRuntime {
  return { database, closed: false } as RecallReadWorkerRuntime;
}

function compileReceipt(budget: RequestBudget) {
  return {
    schema_version: 1 as const,
    workspace_id: WS,
    requested_budget: budget,
    compile_input: {
      source: "ordinary" as const,
      text: "needle",
      snapshot_id: `sha256:${"a".repeat(64)}`,
      budget,
      interpretation_clock: NOW
    },
    query_id: "needle",
    interpretation_id: "interp",
    snapshot_id: `sha256:${"a".repeat(64)}`,
    interpretation_clock: NOW
  };
}

async function link(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  sourceId: string,
  targetId: string,
  index: number
) {
  await slice.admitRelation({
    evidenceId: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, "0")}`,
    assertionId: `assert-cost-${index}`,
    sourceId,
    targetId,
    resultObjectId: targetId,
    relationKind: "observed_log",
    validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" },
    gist: "stored observation proof"
  });
}
