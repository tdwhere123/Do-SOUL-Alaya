import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import { SqliteMemoryRecallReader, type StorageDatabase } from "@do-soul/alaya-storage";
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
      for (const rBase of [1, 12, 512]) {
        const result = await slice.runRecall({ text: "Who owns Vega?", rBase, nBase: 4, nExtension: 0 });
        expect(result.counters.row_visits).toBeLessThanOrEqual(rBase);
        expect(result.counters.source_reads).toBeLessThanOrEqual(rBase);
        expect(result.counters.recall_provider_calls).toBe(0);
        expect(result.counters.phase_ms.total).toBeGreaterThan(0);
        expect(result.counters.phase_ms.total).toBeLessThanOrEqual(250);
        expect(result.counters.rss).toBeLessThanOrEqual(1024 ** 3);
        expect(result.decisionDiagnostics.phaseWork?.unit).toBe("instrumented_logical_operations");
        const pages = slice.database.connection.prepare("PRAGMA page_count").get() as { page_count: number };
        const pageSize = slice.database.connection.prepare("PRAGMA page_size").get() as { page_size: number };
        expect(pages.page_count * pageSize.page_size).toBeLessThanOrEqual(8 * 1024 ** 2);
        records.push({ stage, rBase, counters: result.counters, decision: result.decisionDiagnostics,
          sqliteAllocatedBytes: pages.page_count * pageSize.page_size, membership: result.membership,
          pack: result.pack.accounting, index: slice.recallReader.explain("workspace-1", "vega", "owns") });
      }
    }
    expect(noNetwork).not.toHaveBeenCalled();
  } finally { noNetwork.mockRestore(); }
  writeFileSync("/tmp/stop01-r2-resource-envelope.json", JSON.stringify({ schema: 1, node: process.version,
    preparation: { compositionSetupMs, sourceAndEvidenceWriteMs, reopenSetupMs },
    fixture: { sources: 64, assertions: 64, scope: "one workspace/subject", network: "forbidden",
      coldDefinition: "first query on reopened SQLite connection; OS/native/module caches are not flushed" }, records }, null, 2));
});

it("does not materialize an oversized source or read an unavailable family", async () => {
  const slice = await createSliceHarness((db) => databases.add(db));
  await slice.writeMemory(MEM.long, `needle ${"界".repeat(60000)}`, MemoryDimension.FACT, false);
  const result = await slice.runRecall({ text: "needle", rBase: 12, familyCaps: { typed_relation: "unavailable", embedding: "unavailable" } });
  expect(result.membership).toEqual([]);
  expect(result.pack.truncated).toBe(true);
  expect(result.counters.source_reads).toBe(0);
  expect(result.counters.assertion_rows).toBe(0);
  expect(result.counters.raw_bytes).toBeLessThan(2048);
});

it("bounds native FTS visits and discards an unfinished canonical ordering", async () => {
  const slice = await createSliceHarness((db) => databases.add(db));
  for (let index = 1; index <= 64; index += 1) {
    await slice.writeMemory(`aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
      `deployment checklist ${index}`, MemoryDimension.FACT, false);
  }
  let visits = 0;
  let instrumentedStatements = 0;
  slice.database.connection.function("resource_visit", (_id: string) => { visits += 1; return 1; });
  const prepare = slice.database.connection.prepare.bind(slice.database.connection);
  const spy = vi.spyOn(slice.database.connection, "prepare").mockImplementation((sql: string) => {
    if (sql.includes("FROM memory_content_fts_porter") && sql.includes("AND recall_lexical_visit")) {
      instrumentedStatements += 1;
      return prepare(sql.replace("AND recall_lexical_visit", "AND resource_visit(object_id) AND recall_lexical_visit"));
    }
    return prepare(sql);
  });
  try {
    const result = await slice.runRecall({ text: "deployment checklist", rBase: 12, nBase: 1, nExtension: 0 });
    expect(instrumentedStatements).toBeGreaterThan(0);
    expect(visits).toBeGreaterThan(0);
    expect(visits).toBeLessThanOrEqual(12);
    writeFileSync("/tmp/stop01-r2-native-lexical-visits.json", JSON.stringify({ sourceCount: 64,
      rBase: 12, instrumentedStatements, nativePredicateVisits: visits, returnedRows: result.counters.row_visits,
      ownerVisits: result.counters.native_lexical_visits, truncated: result.pack.truncated,
      note: "Counts SQLite predicate evaluations before canonical ordering; interruption discards the unfinished probe. Not CPU instructions or FTS internal posting-block reads." }, null, 2));
  } finally { spy.mockRestore(); }
});


it("bounded canonical lexical output is independent of source insertion and reader registration", async () => {
  const outputs: unknown[] = [];
  for (const reversed of [false, true]) {
    const slice = await createSliceHarness((db) => databases.add(db));
    const ids = Array.from({ length: 8 }, (_, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`);
    for (const id of reversed ? [...ids].reverse() : ids) {
      await slice.writeMemory(id, "deployment checklist", MemoryDimension.FACT, false);
    }
    const secondReader = new SqliteMemoryRecallReader(slice.database);
    const limited = await slice.runRecall({ text: "deployment checklist", rBase: 4, nBase: 1, nExtension: 0 });
    expect(limited.pack.truncated).toBe(true);
    expect(limited.counters.native_lexical_visits).toBe(1);
    expect(secondReader.lexical("workspace-1", "deployment checklist", 1, 3).nativeVisits).toBe(3);
    const complete = await slice.runRecall({ text: "deployment checklist", rBase: 512, nBase: 1, nExtension: 0 });
    expect(complete.membership).toEqual([ids[0]]);
    outputs.push({ limited: limited.membership, complete: complete.membership });
  }
  expect(outputs[0]).toEqual(outputs[1]);
});

it("bounds native evidence fanout before sorting or materializing assertion rows", async () => {
  const slice = await createSliceHarness((db) => databases.add(db));
  await slice.plantLaunchCorpus({ includeChannel: false });
  const prior = slice.database.connection.prepare("SELECT * FROM relation_assertion_evidence WHERE assertion_id = ?").get("assert-orion-alice") as Record<string, string>;
  const statement = slice.database.connection.prepare("INSERT INTO relation_assertion_evidence(assertion_id,evidence_id,source_event_type,source_event_id,source_occurred_at) VALUES (?,?,?,?,?)");
  for (let index = 0; index < 64; index += 1) statement.run("assert-orion-alice", `fanout-${index}`, prior.source_event_type, prior.source_event_id, prior.source_occurred_at);
  const result = await slice.runRecall({ text: "Who owns Orion?", rBase: 12,
    familyCaps: { lexical: "unavailable", typed_relation: "ready", embedding: "unavailable" } });
  expect(result.counters.native_assertion_visits).toBe(4);
  expect(result.counters.assertion_rows).toBe(0);
  expect(result.counters.source_reads).toBe(0);
  expect(result.referenceInput.edges).toEqual([]);
  expect(result.pack.truncated).toBe(true);
  writeFileSync("/tmp/stop01-r2-native-typed-visits.json", JSON.stringify({ fanout: 65, rBase: 12, counters: result.counters }, null, 2));
});
