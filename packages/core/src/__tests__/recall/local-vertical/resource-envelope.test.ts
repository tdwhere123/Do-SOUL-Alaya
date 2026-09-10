import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDimension, type InformationIndex } from "@do-soul/alaya-protocol";
import { type StorageDatabase } from "@do-soul/alaya-storage";
import {
  runConditionalFieldRecall,
  toSourceObserverRow,
  type ObserverReaders
} from "../../../recall/recall-service.js";
import {
  FAR_FUTURE_EXPIRY,
  INTERPRETATION_CLOCK,
  SNAPSHOT_ID,
  defaultBudget
} from "../conditional-field/reference/deployment.fixture.js";
import { WS, openSourceSlice } from "../conditional-field/vertical/source-slice.js";
import { createSliceHarness, MEM } from "./harness.js";

const databases = new Set<StorageDatabase>();
const directories: string[] = [];
afterEach(() => {
  for (const db of databases) db.close(); databases.clear();
  for (const path of directories) rmSync(path, { recursive: true, force: true }); directories.length = 0;
});

it("measures bounded first/repeat/reopened local Recall including setup, final quality and delivery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recall-resource-")); directories.push(directory);
  const filename = join(directory, "memory.db");
  const setupStarted = performance.now();
  let slice = await createSliceHarness((db) => databases.add(db), filename);
  const compositionSetupMs = performance.now() - setupStarted;
  const writesStarted = performance.now();
  for (let index = 1; index <= 64; index += 1) {
    const tail = String(index).padStart(12, "0");
    const id = `aaaaaaaa-aaaa-4aaa-8aaa-${tail}`;
    await slice.writeMemory(id, `Person${index} owns Vega and keeps deployment checklist ${index}`, MemoryDimension.FACT, false);
    await slice.admitRelation({ evidenceId: `bbbbbbbb-bbbb-4bbb-8bbb-${tail}`, assertionId: `assert-vega-${tail}`,
      sourceId: "vega", targetId: `person${index}`, resultObjectId: id, relationKind: "owns", assignmentKey: "unused",
      validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" }, gist: `Person${index} owns Vega` });
  }
  const sourceAndEvidenceWriteMs = performance.now() - writesStarted;
  const records: unknown[] = [];
  let reopenSetupMs = 0;
  const noNetwork = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("network forbidden"); });
  try {
    for (const stage of ["first-query-after-write", "repeat", "reopened-connection"] as const) {
      if (stage === "reopened-connection") {
        databases.delete(slice.database); slice.database.close();
        const reopenStarted = performance.now();
        slice = await createSliceHarness((db) => databases.add(db), filename);
        reopenSetupMs = performance.now() - reopenStarted;
      }
      for (const workUnits of [1, 120, 512]) {
        const result = await slice.runRecall({ text: "Who owns Vega?", budget: { work_units: workUnits } });
        expect(result.counters.row_visits).toBeLessThanOrEqual(workUnits);
        expect(result.counters.source_reads).toBeLessThanOrEqual(workUnits);
        expect(result.counters.recall_provider_calls).toBe(0);
        expect(result.counters.phase_ms.total).toBeGreaterThan(0);
        expect(result.counters.phase_ms.total).toBeLessThanOrEqual(250);
        expect(result.counters.rss).toBeLessThanOrEqual(1024 ** 3);
        expect(result.index.completeness.logical_index).not.toBe("complete");
        const pages = slice.database.connection.prepare("PRAGMA page_count").get() as { page_count: number };
        const pageSize = slice.database.connection.prepare("PRAGMA page_size").get() as { page_size: number };
        expect(pages.page_count * pageSize.page_size).toBeLessThanOrEqual(8 * 1024 ** 2);
        records.push({ stage, workUnits, counters: result.counters, index: result.index,
          sqliteAllocatedBytes: pages.page_count * pageSize.page_size, membership: result.membership,
          readerPlan: slice.recallReader.explain("workspace-1", "vega", "owns") });
      }
    }
    expect(noNetwork).not.toHaveBeenCalled();
    expect(compositionSetupMs).toBeGreaterThanOrEqual(0);
    expect(sourceAndEvidenceWriteMs).toBeGreaterThan(0);
    expect(reopenSetupMs).toBeGreaterThan(0);
  } finally { noNetwork.mockRestore(); }
});

it("does not materialize an oversized source or read an unavailable family", async () => {
  const slice = await openSourceSlice((db) => databases.add(db));
  await slice.writeMemory(MEM.long, `needle ${"界".repeat(60000)}`, MemoryDimension.FACT);
  const unavailable = runLive(slice, { query_text: "needle", page_budget: 12, memory_bytes: 2048, readers: {} });
  expect(unavailable.completeness.logical_index).not.toBe("complete");
  expect(unavailable.completeness.observed_coverage).toBe("unavailable");
  expect(unavailable.completeness.observed_coverage).not.toBe("exhausted_empty");
  expect(JSON.stringify(unavailable)).not.toContain("ranking_authority");
  const oversized = runLive(slice, { query_text: "needle", page_budget: 12, memory_bytes: 2048 });
  expect(["omitted", "partial", "open", "unavailable"]).toContain(oversized.completeness.payload);
  expect(JSON.stringify(oversized)).not.toContain("界".repeat(1000));
  expect(slice.pendingGarden()).toHaveLength(0);
});

it("page budget truncates the index without native FTS visit counters", async () => {
  const slice = await openSourceSlice((db) => databases.add(db));
  for (let index = 1; index <= 64; index += 1) {
    await slice.writeMemory(`aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
      `deployment checklist ${index}`, MemoryDimension.FACT);
  }
  const result = runLive(slice, { query_text: "deployment checklist", page_budget: 12 });
  expect(result.entries.length).toBeLessThanOrEqual(12);
  expect(result.representation.page_budget).toBe(12);
  expect(pageTruncated(result)).toBe(true);
  expect(slice.pendingGarden()).toHaveLength(0);
});

it("bounded field page is independent of source insertion order", async () => {
  const outputs: unknown[] = [];
  for (const reversed of [false, true]) {
    const slice = await openSourceSlice((db) => databases.add(db));
    const ids = Array.from({ length: 8 }, (_, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`);
    for (const id of reversed ? [...ids].reverse() : ids) {
      await slice.writeMemory(id, "deployment checklist", MemoryDimension.FACT);
    }
    const limited = runLive(slice, { query_text: "deployment checklist", page_budget: 4 });
    expect(limited.entries.length).toBeLessThanOrEqual(4);
    expect(limited.representation.page_budget).toBe(4);
    expect(pageTruncated(limited)).toBe(true);
    const complete = runLive(slice, { query_text: "deployment checklist", page_budget: 800 });
    outputs.push({
      limited: limited.entries.map((entry) => entry.object_id),
      complete: complete.entries.map((entry) => entry.object_id)
    });
  }
  expect(outputs[0]).toEqual(outputs[1]);
});

it("work or page budget truncates relation-backed index without native visit counters", async () => {
  const slice = await openSourceSlice((db) => databases.add(db));
  await slice.writeMemory(MEM.orion, "Alice owns Orion", MemoryDimension.FACT);
  await slice.admitRelation({
    evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000001",
    assertionId: "assert-orion-alice",
    sourceId: "orion",
    targetId: "alice",
    resultObjectId: MEM.orion,
    relationKind: "owns",
    validity: { kind: "open", valid_from: "2025-01-01T00:00:00.000Z" },
    gist: "Alice owns Orion"
  });
  const result = runLive(slice, { query_text: "Who owns Orion?", page_budget: 1, work_units: 12 });
  expect(result.entries.length).toBeLessThanOrEqual(1);
  expect(result.representation.page_budget).toBe(1);
  expect(pageTruncated(result) || result.completeness.logical_index !== "complete").toBe(true);
  expect(slice.pendingGarden()).toHaveLength(0);
});

function runLive(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  input: Readonly<{
    readonly query_text: string;
    readonly page_budget?: number;
    readonly memory_bytes?: number;
    readonly work_units?: number;
    readonly readers?: ObserverReaders;
  }>
): InformationIndex {
  return runConditionalFieldRecall({
    workspace_id: WS,
    query_text: input.query_text,
    budget: defaultBudget({
      page_budget: input.page_budget ?? 800,
      ...(input.memory_bytes === undefined ? {} : { memory_bytes: input.memory_bytes }),
      ...(input.work_units === undefined ? {} : { work_units: input.work_units })
    }),
    snapshot_id: SNAPSHOT_ID,
    interpretation_clock: INTERPRETATION_CLOCK,
    as_of: INTERPRETATION_CLOCK,
    expires_at: FAR_FUTURE_EXPIRY,
    readers: input.readers ?? readersFor(slice)
  });
}

function readersFor(slice: Awaited<ReturnType<typeof openSourceSlice>>): ObserverReaders {
  const kindsSql = slice.database.connection.prepare(
    `SELECT DISTINCT relation_kind AS kind FROM relation_assertions
     WHERE workspace_id = ?
       AND (? IS NULL OR lower(json_extract(anchors_json, '$.source_anchor.object_id')) = ?)`
  );
  return {
    lexical: (input) => slice.memoryReader.lexical(
      input.workspaceId, input.query, input.limit, input.nativeLimit, input.afterObjectId
    ),
    source: (input) => {
      const page = slice.memoryReader.source(input.workspaceId, input.objectId);
      return {
        row: page.row === null ? null : toSourceObserverRow(page.row),
        rowsRead: page.rowsRead,
        bytesRead: page.bytesRead,
        unavailable: page.unavailable
      };
    },
    relation: (input) => slice.relationReader.read(
      input.workspaceId, input.subject, input.predicate, input.limit, input.nativeLimit, input.afterAssertionId
    ),
    relationKinds: (input) => {
      const subject = input.subject === null ? null : input.subject.toLowerCase();
      const rows = kindsSql.all(input.workspaceId, subject, subject) as { readonly kind: string }[];
      return rows.map((row) => row.kind);
    },
    snapshotPin: (workspaceId) => slice.indexProjection.observablePin(workspaceId)
  };
}

function pageTruncated(index: InformationIndex): boolean {
  return index.continuation !== null
    || index.completeness.transport === "partial"
    || index.completeness.representation === "partial"
    || index.completeness.logical_index === "open";
}
