import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { __resetCjkSegmentationStateForTests, warmCjkSegmentation } from "@do-soul/alaya-cjk-segmentation";
import type { QuestionTimePreference, SourceIndexLexicalRepresentation } from "@do-soul/alaya-protocol";
import { StorageDatabase, initDatabase } from "../../../sqlite/db.js";
import { initializeSemanticArtifactCandidateSchema } from "../../../repos/garden/semantic-artifact-schema.js";
import { SqliteIndexedRecallProjection } from "../../../repos/garden/indexed-recall-projection.js";
import { SqliteSourceIndexRepository } from "../../../repos/source-index/source-index-repo.js";
import { lexicalDomainTables } from "../../../repos/source-index/lexical-domain.js";
import { readSourceIndexRootQualification, readSourceIndexSnapshotFact } from "../../../repos/source-index/source-index-qualification.js";
import { BUDGET, WORKSPACE, buildReady, eraseSource, fieldSha256, fixture, publishSource, type Fixture } from "./source-index-fixture.js";

const databases: StorageDatabase[] = [], directories: string[] = [];
afterEach(() => {
  __resetCjkSegmentationStateForTests();
  for (const database of databases.splice(0)) database.close({ optimize: false });
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const queryBudget = { work_units: 1_000_000, memory_bytes: 16 * 1024 * 1024 };
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "lexical-domains-")); directories.push(directory);
  const environment = fixture(join(directory, "source.sqlite")); databases.push(environment.database);
  return environment;
}
function prepare(environment: Pick<Fixture, "index">, representation: SourceIndexLexicalRepresentation = "raw-unicode61.v1",
  workspace = WORKSPACE, activate = true) {
  const store = environment.index.lexical;
  const generation = store.beginLexical(store.selectLexical(workspace, representation));
  expect(store.captureLexicalPage(workspace, generation.generation_id, 128, BUDGET).generation.enumeration_complete).toBe(true);
  for (;;) {
    const pending = store.pendingLexicalTarget(workspace, generation.generation_id, BUDGET);
    if (pending.source === null) { expect(pending.complete).toBe(true); break; }
    const read = store.readLexicalDocument(workspace, generation.generation_id, pending.source.root_key, 65536, BUDGET);
    if (read.status !== "ready") throw new Error(read.reason);
    expect(store.writeLexicalDocument(workspace, generation.generation_id, read.source, read.body, BUDGET).status).toBe("accepted");
  }
  if (activate) expect(store.activateLexical(workspace, generation.generation_id)).toEqual({ status: "accepted" });
  return generation.generation_id;
}
function reselect(environment: Pick<Fixture, "index">) {
  environment.index.lexical.selectLexical(WORKSPACE, "segmented-unicode61.v1");
  return prepare(environment);
}
const questionTime: QuestionTimePreference = { interpretation_clock: "2026-01-01T00:00:00.000Z",
  intervals: [{ start: "2020-01-02", end: "2020-01-02" }] };
function read(index: SqliteSourceIndexRepository, text = "alpha beta", preference?: QuestionTimePreference) {
  const result = index.readLexicalCandidates(WORKSPACE, text, 128, queryBudget, preference);
  expect(result.completion).toBe("complete");
  return result;
}

it("qualifies only roots in the active lexical generation and binds activation identity", () => {
  const environment = setup(), store = environment.index.lexical;
  publishSource(environment, "alpha", "a");
  buildReady(environment);
  const active = prepare(environment);
  publishSource(environment, "beta", "b");
  buildReady(environment);
  const pending = prepare(environment, "raw-unicode61.v1", WORKSPACE, false);
  const readFact = () => environment.database.connection.transaction(() => ({
    snapshot: readSourceIndexSnapshotFact(environment.database, WORKSPACE),
    root: readSourceIndexRootQualification(environment.database, fieldSha256, WORKSPACE, "b")
  }))();
  const before = readFact();
  expect(before.snapshot.lexical).toMatchObject({ serving: "generation", selected: { binding: { generation_id: active } } });
  expect(before.root.lexical.status).toBe("not_indexed");
  expect(environment.index.readLexicalCandidates(WORKSPACE, "beta", 8, queryBudget).candidates).toEqual([]);
  expect(store.activateLexical(WORKSPACE, pending)).toEqual({ status: "accepted" });
  const after = readFact();
  expect(after.snapshot.lexical.selected).toMatchObject({ binding: { generation_id: pending } });
  expect(after.snapshot.lexical).not.toEqual(before.snapshot.lexical);
  expect(after.root.lexical).toMatchObject({ status: "ready", start_byte: 0, end_byte: 4 });
  expect(environment.index.readLexicalCandidates(WORKSPACE, "beta", 8, queryBudget).candidates).toHaveLength(1);
});
function pin(environment: Fixture) {
  const database = new StorageDatabase(environment.database.filename,
    new BetterSqlite3(environment.database.filename, { readonly: true }));
  databases.push(database); database.connection.exec("BEGIN DEFERRED");
  return { database, index: new SqliteSourceIndexRepository(database, fieldSha256) };
}
function drain(index: SqliteSourceIndexRepository, limit = 1) {
  const receipts = [];
  for (let page = 0; page < 100; page++) {
    const receipt = index.lexical.reclaimLexicalPage(WORKSPACE, limit, BUDGET); receipts.push(receipt);
    expect(receipt.projections + receipt.targets).toBeLessThanOrEqual(limit);
    if (receipt.complete) return receipts;
  }
  throw new Error("bounded fixture reclamation did not finish");
}

it("isolates BM25 from retired corpora and preserves both active and pinned retired readers through domain removal", () => {
  const environment = setup();
  const alpha = publishSource(environment, "alpha", "a");
  const first = prepare(environment), oldReader = pin(environment), oldRead = read(oldReader.index);
  expect(oldRead.candidates).toHaveLength(1);
  for (let generation = 0; generation < 3; generation++) reselect(environment);
  publishSource(environment, "beta", "b"); publishSource(environment, "beta", "c");
  const vector = buildReady(environment);
  const active = prepare(environment), activeReader = pin(environment);
  const before = read(environment.index), activeRead = read(activeReader.index);
  // Independent corpus expectation: N=3, df(alpha)=1, df(beta)=2, so alpha strictly precedes beta.
  expect(before.candidates).toHaveLength(3);
  expect(before.candidates[0]!.source.target.root_id).toBe(alpha.record_id);
  expect(before.candidates.map(candidate => candidate.lexical.bm25))
    .toEqual([expect.closeTo(-Math.log(5 / 3), 12), expect.closeTo(-0.000001, 12), expect.closeTo(-0.000001, 12)]);
  expect(before.limitations).toContain("generation_scoped_bm25_statistics");
  expect(before.limitations).not.toContain("database_wide_bm25_statistics");
  const rawBefore = environment.database.connection.prepare("SELECT * FROM source_index_text ORDER BY id").all();
  const vectorsBefore = environment.database.connection.prepare("SELECT * FROM source_index_vectors ORDER BY window_id").all();
  const receipts = drain(environment.index);
  expect(receipts.reduce((sum, page) => sum + page.generations, 0)).toBe(4);
  expect(read(environment.index)).toEqual(before);
  expect(read(activeReader.index)).toEqual(activeRead);
  expect(read(oldReader.index)).toEqual(oldRead);
  expect(environment.index.lexical.lexicalGeneration(WORKSPACE, first)).toBeNull();
  expect(environment.index.lexical.lexicalState(WORKSPACE)?.active_generation_id).toBe(active);
  expect(environment.database.connection.prepare("SELECT name FROM sqlite_master WHERE name=?")
    .get(lexicalDomainTables(first).unicode61)).toBeUndefined();
  expect(oldReader.database.connection.prepare("SELECT name FROM sqlite_master WHERE name=?")
    .get(lexicalDomainTables(first).unicode61)).toBeDefined();
  expect(environment.database.connection.prepare("SELECT * FROM source_index_text ORDER BY id").all()).toEqual(rawBefore);
  expect(environment.database.connection.prepare("SELECT * FROM source_index_vectors ORDER BY window_id").all()).toEqual(vectorsBefore);
  expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "ready", active_generation_id: vector.generation.generation_id });
  oldReader.database.connection.exec("COMMIT"); activeReader.database.connection.exec("COMMIT");
  expect(read(oldReader.index)).toEqual(before);
});

it.each(["raw-unicode61.v1", "segmented-unicode61.v1"] as const)(
  "uses only the active %s corpus for independent BM25 scores despite foreign and preparing generations", async representation => {
    expect(await warmCjkSegmentation()).toBe(true);
    const environment = setup(), store = environment.index.lexical;
    const alpha = publishSource(environment, "alpha alpha", "a");
    publishSource(environment, "beta", "b"); publishSource(environment, "beta", "c");
    const active = prepare(environment, representation), before = read(environment.index);
    // FTS5's documented equation: N=3, lengths=[2,1,1], avgdl=4/3, k1=1.2, b=.75.
    // alpha has df=1/tf=2; beta has df=2/tf=1 and the negative IDF floor is 1e-6.
    const expected = [-Math.log(5 / 3) * 4.4 / 3.65, -0.000001 * 2.2 / 1.975, -0.000001 * 2.2 / 1.975];
    expect(before.candidates.map(candidate => candidate.lexical.bm25))
      .toEqual(expected.map(score => expect.closeTo(score, 12)));
    expect(before.candidates[0]!.source.target.root_id).toBe(alpha.record_id);
    for (let i = 0; i < 4; i++) publishSource(environment, "alpha", `foreign-${i}`, { workspace_id: "workspace-2" });
    prepare(environment, representation, "workspace-2");
    expect(read(environment.index)).toEqual(before);
    publishSource(environment, "alpha", "new-epoch");
    const pending = prepare(environment, representation, WORKSPACE, false);
    expect(pending).not.toBe(active);
    expect(store.lexicalState(WORKSPACE)?.active_generation_id).toBe(active);
    const partial = environment.index.readLexicalCandidates(WORKSPACE, "alpha beta", 128, queryBudget);
    expect(partial).toMatchObject({ completion: "partial", reason: "lexical_generation_partial" });
    expect(partial.candidates).toEqual(before.candidates);
    expect(store.reclaimLexicalPage(WORKSPACE, 128, BUDGET)).toMatchObject({ complete: true, generations: 0 });
    expect(store.lexicalGeneration(WORKSPACE, pending)?.status).toBe("building");
    expect(store.activateLexical(WORKSPACE, pending)).toEqual({ status: "accepted" });
    const published = read(environment.index);
    expect(published.candidates).toHaveLength(4);
    expect(published.tokenization?.lexical_binding?.generation_id).toBe(pending);
    drain(environment.index);
    expect(read(environment.index)).toEqual(published);
    expect(store.lexicalState("workspace-2")?.active_generation_id).not.toBeNull();
  });

it.each(["raw-unicode61.v1", "segmented-unicode61.v1"] as const)(
  "keeps restricted-time %s scores generation-owned across cleanup instead of rebuilding a window corpus", async representation => {
    expect(await warmCjkSegmentation()).toBe(true);
    const environment = setup(), store = environment.index.lexical;
    publishSource(environment, "alpha alpha", "in-alpha", { event_time: "2020-01-02T00:00:00.000Z" });
    publishSource(environment, "beta", "outside-beta", { event_time: "2020-01-01T00:00:00.000Z" });
    publishSource(environment, "beta", "in-beta", { event_time: "2020-01-02T23:59:59.999Z" });
    for (let i = 0; i < 4; i++) publishSource(environment, "alpha", `foreign-${i}`, { workspace_id: "workspace-2" });
    // Native capture publishes the raw index; source admission alone does not.
    buildReady(environment); buildReady(environment, undefined, "workspace-2");
    const fallback = read(environment.index, "alpha beta", questionTime);
    expect(fallback.tokenization?.lexical_binding).toBeUndefined();
    expect(fallback.limitations).toContain("database_wide_bm25_statistics");
    // Raw fallback includes seven documents, even though the workspace/window admits only two.
    expect(fallback.candidates.map(row => row.source.source_id)).toEqual(["in-beta", "in-alpha"]);
    expect(fallback.candidates.map(row => row.lexical.bm25)).toEqual([
      expect.closeTo(-Math.log(5.5 / 2.5) * 2.2 / 2.0875, 12), expect.closeTo(-0.000001 * 4.4 / 3.875, 12)]);
    const retired = prepare(environment, representation);
    store.selectLexical(WORKSPACE, representation === "raw-unicode61.v1" ? "segmented-unicode61.v1" : "raw-unicode61.v1");
    const active = prepare(environment, representation);
    prepare(environment, representation, "workspace-2");
    const before = read(environment.index, "alpha beta", questionTime), pinned = pin(environment);
    const pinnedBefore = read(pinned.index, "alpha beta", questionTime);
    expect(before.tokenization?.lexical_binding).toMatchObject({ generation_id: active, representation });
    expect(before.limitations).toContain("generation_scoped_bm25_statistics");
    expect(before.limitations).not.toContain("database_wide_bm25_statistics");
    expect(before.candidates.map(row => row.source.source_id)).toEqual(["in-alpha", "in-beta"]);
    expect(before.candidates.map(row => row.lexical.rank)).toEqual([1, 2]);
    // The full active corpus still has N=3 and lengths [2,1,1], not the two in-window documents.
    expect(before.candidates.map(row => row.lexical.bm25)).toEqual([
      expect.closeTo(-Math.log(5 / 3) * 4.4 / 3.65, 12), expect.closeTo(-0.000001 * 2.2 / 1.975, 12)]);
    drain(environment.index);
    expect(store.lexicalGeneration(WORKSPACE, retired)).toBeNull();
    expect(read(environment.index, "alpha beta", questionTime)).toEqual(before);
    expect(read(pinned.index, "alpha beta", questionTime)).toEqual(pinnedBefore);
    pinned.database.connection.exec("COMMIT");
    expect(read(pinned.index, "alpha beta", questionTime)).toEqual(before);
  });

it("resumes bounded committed pages after reopen and rolls an interrupted page back without touching the active domain", () => {
  const environment = setup();
  for (const id of ["a", "b", "c"]) publishSource(environment, "alpha", id);
  const retired = prepare(environment); reselect(environment);
  const activeRead = read(environment.index);
  const first = environment.index.lexical.reclaimLexicalPage(WORKSPACE, 1, BUDGET);
  expect(first).toMatchObject({ projections: 1, targets: 0, generations: 0, complete: false });
  environment.database.close({ optimize: false });
  const database = initDatabase({ filename: environment.database.filename }); databases.push(database);
  const index = new SqliteSourceIndexRepository(database, fieldSha256);
  expect(database.connection.prepare("SELECT count(*) AS n FROM source_index_lexical_projections WHERE generation_id=?")
    .get(retired)).toEqual({ n: 2 });
  database.connection.exec(`CREATE TEMP TRIGGER interrupt_reclamation BEFORE DELETE ON source_index_lexical_targets
    BEGIN SELECT RAISE(ABORT,'authored reclamation interruption'); END`);
  expect(() => index.lexical.reclaimLexicalPage(WORKSPACE, 8, BUDGET)).toThrow("authored reclamation interruption");
  expect(database.connection.prepare("SELECT count(*) AS n FROM source_index_lexical_projections WHERE generation_id=?")
    .get(retired)).toEqual({ n: 2 });
  expect(read(index)).toEqual(activeRead);
  database.connection.exec("DROP TRIGGER interrupt_reclamation");
  const receipts = drain(index, 2);
  expect(receipts.reduce((sum, page) => sum + page.projections, 0)).toBe(2);
  expect(receipts.reduce((sum, page) => sum + page.targets, 0)).toBe(3);
  expect(receipts.reduce((sum, page) => sum + page.generations, 0)).toBe(1);
  expect(read(index)).toEqual(activeRead);
  expect(index.lexical.reclaimLexicalPage(WORKSPACE, 1, BUDGET)).toMatchObject({ complete: true, generations: 0 });
});

it("does not mutate a caller-owned snapshot, exceed page budgets, or invalidate an observable pin for retired-only cleanup", () => {
  const environment = setup(); publishSource(environment, "alpha");
  prepare(environment); reselect(environment);
  initializeSemanticArtifactCandidateSchema(environment.database.connection);
  const projection = new SqliteIndexedRecallProjection(environment.database.connection);
  const before = projection.observablePin(WORKSPACE);
  expect(environment.index.lexical.reclaimLexicalPage(WORKSPACE, 1, { work: 3, native_bytes: 1_000 }))
    .toMatchObject({ projections: 0, complete: false, resources: { work: 0, native_bytes: 0 } });
  environment.database.connection.exec("BEGIN");
  expect(() => environment.index.lexical.reclaimLexicalPage(WORKSPACE, 1, BUDGET)).toThrow("transaction-free caller");
  environment.database.connection.exec("ROLLBACK");
  for (const receipt of drain(environment.index)) {
    expect(receipt.resources.work).toBeLessThanOrEqual(BUDGET.work);
    expect(receipt.resources.native_bytes).toBeLessThanOrEqual(BUDGET.native_bytes);
  }
  expect(projection.observablePin(WORKSPACE)).toEqual(before);
  environment.index.lexical.selectLexical(WORKSPACE, "segmented-unicode61.v1");
  expect(projection.observablePin(WORKSPACE)).not.toEqual(before);
});

it("keeps generation-scoped raw trigram order and erases both lanes of active and retired domains", () => {
  const environment = setup(), source = publishSource(environment, "自动部署流水线", "han",
    { event_time: "2020-01-02T00:00:00.000Z" });
  const retired = prepare(environment); reselect(environment);
  const before = read(environment.index, "部署流水线");
  expect(before.candidates.some(item => item.lexical.lane === "trigram")).toBe(true);
  const timed = read(environment.index, "部署流水线", questionTime);
  expect(timed.candidates).toEqual(before.candidates);
  expect(timed.limitations).toContain("generation_scoped_bm25_statistics");
  drain(environment.index);
  expect(read(environment.index, "部署流水线", questionTime)).toEqual(timed);
  expect(read(environment.index, "部署流水线")).toEqual(before);
  expect(environment.index.lexical.lexicalGeneration(WORKSPACE, retired)).toBeNull();
  const priorActive = environment.index.lexical.lexicalState(WORKSPACE)!.active_generation_id!;
  const active = reselect(environment); // Retain this retired domain rather than running lifecycle maintenance.
  eraseSource(environment, source.record_id);
  for (const generation of [priorActive, active]) for (const table of Object.values(lexicalDomainTables(generation))) {
    expect(environment.database.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  }
  expect(environment.index.lexical.lexicalGeneration(WORKSPACE, priorActive)).toMatchObject({ status: "retired", completed_count: 0 });
  expect(environment.index.lexical.lexicalGeneration(WORKSPACE, active)).toMatchObject({ status: "partial", completed_count: 0 });
});
