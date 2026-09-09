import { afterEach, describe, expect, it } from "vitest";
import { MemoryDimension, type InformationIndex, type RequestBudget } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { runConditionalFieldRecall, captureIndexPreviews } from "../../../../recall/runtime/recall-service-runner.js";
import { toSourceObserverRow, type ObserverReaders } from "../../../../recall/conditional-field/observers/observe.js";
import { defaultBudget, INTERPRETATION_CLOCK, SNAPSHOT_ID } from "../reference/deployment.fixture.js";
import { openSourceSlice, WS } from "../vertical/source-slice.js";
import { indexEntryRevision } from "../../../../recall/conditional-field/index/project-accepting-index.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

describe("native lexical delivery at corpus scale", () => {
  it.each([0, 1])("terminates an unserviceable %i-unit request without a replayable no-progress cursor", (work_units) => {
    const readers: ObserverReaders = { lexical: () => { throw new Error("An unserviceable action must not read"); } };
    const pages = collectPages(readers, defaultBudget({ work_units, finalization_reserve: 0,
      min_envelope: 0, page_budget: 1 }), 2);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.entries).toEqual([]);
    expect(pages[0]!.continuation).toBeNull();
    expect(pages[0]!.completeness.logical_index).not.toBe("complete");
  });

  it("delivers and exhausts 180 grounded matches in a thousand-source corpus with the default reserve", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    const expected: string[] = [];
    for (let index = 0; index < 1_024; index += 1) {
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(10_000 + index).padStart(12, "0")}`;
      if (index < 180) expected.push(id);
      await slice.writeMemory(id, index < 180 ? `graduation degree record ${index}` : `unrelated bicycle trip ${index}`, MemoryDimension.FACT);
    }
    const limits: number[] = [];
    const readers = readersFor(slice, limits);
    const budget = defaultBudget({ page_budget: 5 });
    const pages = collectPages(readers, budget, 50);
    expect(pages[0]!.entries).toHaveLength(5);
    expect(pages.flatMap((page) => page.entries.map((entry) => entry.object_id))).toEqual(expected);
    expect(pages.at(-1)!.continuation).toBeNull();
    expect(limits.some((limit) => limit > 1)).toBe(true);
    expect(limits.length).toBeLessThan(20);
    for (const page of pages) {
      expect(page.completeness.interpretation_coverage).toBe("open");
      expect(page.completeness.payload).not.toBe("omitted");
      const previews = captureIndexPreviews(page, readers, WS);
      for (const entry of page.entries) {
        expect(entry.claim).toBe("unknown");
        expect(entry.explanation_ids.length).toBeGreaterThan(0);
        expect(previews.get(entry.object_id)).toContain("graduation degree");
        expect(page.explanations?.some((root) => root.leaf_ids.includes(entry.object_id))).toBe(true);
      }
    }
  }, 30_000);

  it("advances retained grounding and delivery across small work allowances", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    const expected: string[] = [];
    for (let index = 0; index < 48; index += 1) {
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(20_000 + index).padStart(12, "0")}`;
      expected.push(id);
      await slice.writeMemory(id, `graduation degree record ${index}`, MemoryDimension.FACT);
    }
    const pages = collectPages(readersFor(slice, []), defaultBudget({ work_units: 120, finalization_reserve: 30,
      min_envelope: 1, page_budget: 3 }), 100);
    expect(pages.at(-1)!.continuation, JSON.stringify(pages.map((page) => [page.entries.length, page.continuation?.cursor, page.completeness]))).toBeNull();
    expect(pages.flatMap((page) => page.entries.map((entry) => entry.object_id))).toEqual(expected);
    const cursors = pages.flatMap((page) => page.continuation === null ? [] : [page.continuation.cursor]);
    expect(new Set(cursors).size).toBe(cursors.length);
    expect(cursors).not.toContain("p0g0");
  });

  it.each(["reverse", "interleaved"])("delivers each product once when %s UUID order arrives across observation pages", async (order) => {
    const slice = await openSourceSlice((database) => databases.add(database));
    const numbers = Array.from({ length: 48 }, (_, index) => order === "reverse" ? 47 - index
      : index % 2 === 0 ? 47 - index / 2 : (index - 1) / 2);
    const ids = numbers.map((number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(40_000 + number).padStart(12, "0")}`);
    for (const id of ids) await slice.writeMemory(id, "graduation degree", MemoryDimension.FACT);
    const pages = collectPages(readersFor(slice, []), defaultBudget({ work_units: 120,
      finalization_reserve: 30, min_envelope: 1, page_budget: 3 }), 100);
    const delivered = pages.flatMap((page) => page.entries.map((entry) => entry.object_id));
    expect(pages.at(-1)!.continuation).toBeNull();
    expect(delivered).toHaveLength(ids.length);
    expect([...delivered].sort()).toEqual([...ids].sort());
    expect(new Set(delivered).size).toBe(ids.length);
    expect(pages.some((page) => page.entries.length > 0 && page.completeness.observed_coverage === "interrupted")).toBe(true);
  });

  it("retains delivered identities when later relation pages discover earlier-sorting targets", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    const seed = "ffffffff-ffff-4fff-8fff-000000000001";
    const query = "find observed_log from x to y";
    await slice.writeMemory(seed, query, MemoryDimension.FACT);
    const ids: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(50_011 - index).padStart(12, "0")}`;
      ids.push(id);
      await slice.writeMemory(id, `target record ${index}`, MemoryDimension.FACT);
      await slice.admitRelation({ evidenceId: `bbbbbbbb-bbbb-4bbb-8bbb-${String(50_000 + index).padStart(12, "0")}`,
        assertionId: `observation-${String(index).padStart(3, "0")}`, sourceId: seed, targetId: id, resultObjectId: id,
        relationKind: "observed_log", validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" }, gist: "stored observation proof" });
    }
    const readers: ObserverReaders = { ...readersFor(slice, []), relation: (input) => slice.relationReader.read(
      input.workspaceId, input.subject, input.predicate, input.limit, input.nativeLimit, input.afterAssertionId, input.asOf) };
    const pages = collectPages(readers, defaultBudget({ work_units: 120, finalization_reserve: 60,
      min_envelope: 1, page_budget: 2 }), 100, query, "2026-09-07T00:00:00.000Z");
    const delivered = pages.flatMap((page) => page.entries.map((entry) => entry.object_id));
    expect(pages.at(-1)!.continuation).toBeNull();
    expect([...new Set(delivered)].sort()).toEqual([...ids].sort());
    const revisions = pages.flatMap((page) => page.entries.map(indexEntryRevision));
    expect(new Set(revisions).size).toBe(revisions.length);
    for (const page of pages) expect(new Set(page.entries.map((entry) => entry.object_id)).size).toBe(page.entries.length);
    expect(delivered.length).toBeGreaterThan(new Set(delivered).size);
    const latest = new Map(pages.flatMap((page) => page.entries.map((entry) => [entry.object_id, indexEntryRevision(entry)] as const)));
    const complete = collectPages(readers, defaultBudget({ work_units: 10_000, finalization_reserve: 1_000,
      memory_bytes: 10_000_000, page_budget: 100 }), 10, query, "2026-09-07T00:00:00.000Z");
    expect(complete.at(-1)!.continuation).toBeNull();
    for (const entry of complete.flatMap((page) => page.entries)) expect(latest.get(entry.object_id)).toBe(indexEntryRevision(entry));
    expect(new Set(delivered).size).toBe(ids.length);
    expect(pages.some((page) => page.entries.length > 0 && page.completeness.observed_coverage === "interrupted")).toBe(true);
  });

  it.each(["forward", "reverse"])("delivers grounded partial seeds under default memory with %s UUID arrival", async (order) => {
    const slice = await openSourceSlice((database) => databases.add(database));
    for (let index = 0; index < 1_024; index += 1) {
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(30_000 + (order === "forward" ? index : 1_023 - index)).padStart(12, "0")}`;
      await slice.writeMemory(id, `graduation degree record ${index}`, MemoryDimension.FACT);
    }
    const pages = collectPages(readersFor(slice, []), defaultBudget({ page_budget: 5 }), 250);
    const delivered = pages.flatMap((page) => page.entries);
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.length, JSON.stringify(pages.slice(-3).map((page) => [page.entries.map((entry) => entry.object_id), page.continuation?.cursor, page.completeness]))).toBeLessThan(1_024);
    expect(new Set(delivered.map((entry) => entry.object_id)).size).toBe(delivered.length);
    expect(pages.at(-1)!.continuation).toBeNull();
    expect(pages.at(-1)!.completeness.logical_index).not.toBe("complete");
    for (const page of pages) for (const entry of page.entries) {
      expect(entry.explanation_ids.length).toBeGreaterThan(0);
      expect(page.explanations?.some((root) => root.leaf_ids.includes(entry.object_id))).toBe(true);
    }
  }, 30_000);
});

function collectPages(readers: ObserverReaders, budget: RequestBudget, maximum: number,
  query = "graduation degree", clock = INTERPRETATION_CLOCK): InformationIndex[] {
  const pages: InformationIndex[] = [];
  let continuation: InformationIndex["continuation"] = null;
  for (let attempt = 0; attempt < maximum; attempt += 1) {
    const index = runConditionalFieldRecall({ workspace_id: WS, query_text: query, budget,
      snapshot_id: SNAPSHOT_ID, interpretation_clock: clock, as_of: clock,
      expires_at: "2099-01-01T00:00:00.000Z", readers, continuation });
    pages.push(index);
    continuation = index.continuation;
    if (continuation === null) break;
    expect(continuation.continuation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  }
  return pages;
}

function readersFor(slice: Awaited<ReturnType<typeof openSourceSlice>>, limits: number[]): ObserverReaders {
  return {
    lexical: (input) => {
      limits.push(input.limit);
      return slice.memoryReader.lexical(input.workspaceId, input.query, input.limit, input.nativeLimit, input.afterObjectId);
    },
    source: (input) => {
      const page = slice.memoryReader.source(input.workspaceId, input.objectId);
      return { ...page, row: page.row === null ? null : toSourceObserverRow(page.row) };
    },
    relation: () => { throw new Error("Lexical seed acceptance must not invent a stored relation"); },
    snapshotPin: (workspaceId) => slice.indexProjection.observablePin(workspaceId)
  };
}
