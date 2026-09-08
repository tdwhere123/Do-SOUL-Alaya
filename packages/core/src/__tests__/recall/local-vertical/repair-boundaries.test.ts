import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDimension, type InformationIndex } from "@do-soul/alaya-protocol";
import { initDatabase, SqliteMemoryEntryRepo, type StorageDatabase } from "@do-soul/alaya-storage";
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
import { createSliceHarness, MEM, CONTENT, NOW } from "./harness.js";

const databases = new Set<StorageDatabase>();
const paths: string[] = [];
afterEach(() => { for (const db of databases) db.close(); databases.clear(); for (const path of paths) rmSync(path, { recursive: true, force: true }); paths.length = 0; });
const harness = (filename?: string) => createSliceHarness((db) => databases.add(db), filename);

describe("repair boundary falsifiers", () => {
  it("cancellation remains distinct from complete absence and revoked sessions fail", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus();
    const cancelled = await slice.runRecall({ text: "deployment checklist" }, AbortSignal.abort());
    expect(cancelled.index.completeness.logical_index).not.toBe("complete");
    expect(cancelled.membership).toEqual([]);
    slice.revokeSession();
    await expect(slice.runRecall({ text: "deployment checklist" })).rejects.toThrow(/revoked/);
  });

  it("retraction preserves source evidence but removes active relation admission", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus({ includeChannel: false });
    const source = await slice.memoryEntryRepo.findById(MEM.orion);
    expect(source?.evidence_refs.length).toBeGreaterThan(0);
    await slice.relationService.resolve({ assertionId: "assert-orion-alice", workspaceId: WS,
      runId: "run-1", causedBy: "garden", resolutionKind: "retracted",
      reason: "Reviewed source retraction", resolvedAt: NOW });
    const state = slice.database.connection.prepare(
      "SELECT resolution_kind FROM relation_assertion_resolution_current WHERE assertion_id = ?"
    ).get("assert-orion-alice");
    expect(state).toEqual({ resolution_kind: "retracted" });
    expect((await slice.memoryEntryRepo.findById(MEM.orion))?.evidence_refs).toEqual(source?.evidence_refs);
    const result = await slice.runRecall({ text: "Who owns Orion?" });
    expect(result.index.entries.every((entry) => entry.claim !== "supported")).toBe(true);
    expect(result.index.completeness.interpretation_coverage).not.toBe("complete");
  });

  it("bounds field page and work before materializing twelve matching sources", async () => {
    const slice = await openSourceSlice((db) => databases.add(db));
    for (let index = 1; index <= 12; index += 1) {
      const tail = String(index).padStart(12, "0");
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-${tail}`;
      await slice.writeMemory(id, `Person${index} owns Vega`, MemoryDimension.FACT);
      await slice.admitRelation({
        evidenceId: `bbbbbbbb-bbbb-4bbb-8bbb-${tail}`, assertionId: `assert-vega-${index}`,
        sourceId: "vega", targetId: `person${index}`, resultObjectId: id, relationKind: "owns",
        validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" }, gist: `Person${index} owns Vega`
      });
    }
    const byId = vi.spyOn(slice.memoryEntryRepo, "findById");
    for (const page_budget of [1, 12] as const) {
      const result = runLive(slice, { query_text: "Who owns Vega?", page_budget });
      expect(result.entries).toHaveLength(page_budget);
      expect(result.representation.page_budget).toBe(page_budget);
      expect(result.completeness.transport).toBe(page_budget === 1 ? "partial" : "complete");
      expect(result.completeness.interpretation_coverage).toBe("open");
      expect(result.continuation === null).toBe(page_budget === 12);
    }
    expect(byId).not.toHaveBeenCalled();
  });

  it("failed transactional enqueue rolls source, lexical projection and audit back before ack", async () => {
    const slice = await harness();
    const before = slice.database.connection.prepare("SELECT COUNT(*) AS n FROM event_log").get();
    vi.spyOn(slice.garden, "enqueue").mockImplementation(() => { throw new Error("queue-full"); });
    await expect(slice.writeMemory(MEM.checklist, CONTENT.checklist, MemoryDimension.PROCEDURE, true)).rejects.toThrow("queue-full");
    expect(await slice.memoryEntryRepo.findById(MEM.checklist)).toBeNull();
    expect(await slice.memoryEntryRepo.searchByKeyword("workspace-1", "deployment", 5)).toEqual([]);
    expect(slice.database.connection.prepare("SELECT COUNT(*) AS n FROM event_log").get()).toEqual(before);
    expect(slice.counters.write_ack_ms).toBe("not_observed");
  });
  it("committed source and pending job survive a real file database reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-repair-")); paths.push(directory);
    const filename = join(directory, "slice.sqlite");
    const slice = await harness(filename);
    await slice.writeMemory(MEM.checklist, CONTENT.checklist, MemoryDimension.PROCEDURE, true);
    slice.database.close(); databases.delete(slice.database);
    const reopened = initDatabase({ filename }); databases.add(reopened);
    const row = await new SqliteMemoryEntryRepo(reopened).findById(MEM.checklist);
    expect(row?.content).toBe(CONTENT.checklist);
    expect(reopened.connection.prepare("SELECT COUNT(*) AS n FROM garden_tasks").get()).toMatchObject({ n: 1 });
  });
});

it("a source revision change invalidates continuation without admitting new snapshot rows", async () => {
  const slice = await harness();
  for (let index = 0; index < 5; index += 1) {
    await slice.writeMemory(`aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
      "deployment checklist", MemoryDimension.FACT, false);
  }
  const first = await slice.runRecall({ text: "deployment checklist", budget: { page_budget: 1 } });
  expect(first.index.continuation).not.toBeNull();
  await slice.writeMemory("aaaaaaaa-aaaa-4aaa-8aaa-000000000099", CONTENT.checklist, MemoryDimension.PROCEDURE, false);
  const resumed = await slice.runRecall({ text: "deployment checklist", budget: { page_budget: 1 },
    continuation: first.index.continuation });
  expect(resumed.index.completeness.logical_index).toBe("invalidated");
  expect(resumed.membership).toEqual([]);
});

it("common source admission excludes active lifecycle rows retained as tombstones", async () => {
  const slice = await harness(); await slice.plantLaunchCorpus({ includeChannel: false });
  slice.database.connection.prepare("UPDATE memory_entries SET retention_state = 'tombstoned' WHERE object_id = ?").run(MEM.orion);
  const result = await slice.runRecall({ text: "Who owns Orion?" });
  expect(result.membership).not.toContain(MEM.orion);
  expect(result.index.entries.every((entry) => entry.claim !== "supported")).toBe(true);
});

function runLive(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  input: Readonly<{ readonly query_text: string; readonly page_budget: number }>
): InformationIndex {
  return runConditionalFieldRecall({
    workspace_id: WS,
    query_text: input.query_text,
    budget: defaultBudget({ page_budget: input.page_budget }),
    snapshot_id: SNAPSHOT_ID,
    interpretation_clock: INTERPRETATION_CLOCK,
    as_of: INTERPRETATION_CLOCK,
    expires_at: FAR_FUTURE_EXPIRY,
    readers: readersFor(slice)
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
