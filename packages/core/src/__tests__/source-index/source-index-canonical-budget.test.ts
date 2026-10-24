import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceIndexBudget } from "@do-soul/alaya-protocol";
import { SourceIndexLifecycle } from "../../source-index/source-index-lifecycle.js";
import { SqliteFieldSourceRecordRepo } from "../../../../storage/src/repos/field/source-repo.js";
import {
  BUDGET, WORKSPACE, buildReady, configuration, fieldSha256, fixture, lexicalRows, publishSource, type Fixture
} from "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";

const environments: Fixture[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const environment of environments.splice(0)) environment.database.close();
});

function setup(dependencyCount: number, body = "canonical body", windowBytes = 8) {
  const environment = fixture();
  environments.push(environment);
  const origins = Array.from({ length: dependencyCount }, (_, index) => publishSource(environment,
    `retained excerpt ${index}`, `logical-origin-${index}`, { source_representation: { kind: "retained_excerpt" } }));
  const source = publishSource(environment, body, "logical-canonical", {
    source_representation: { kind: "canonical_projection", source_record_ids: origins.map(origin => origin.record_id) }
  });
  for (const row of [...origins, source]) expect(row.record_id).not.toBe(row.source_id);
  const lifecycle = new SourceIndexLifecycle(environment.index, fieldSha256);
  const selection = lifecycle.select(WORKSPACE, configuration({ window_bytes: windowBytes }));
  const generation = lifecycle.begin(selection);
  expect(lifecycle.capture(WORKSPACE, generation.generation_id, 8, BUDGET).generation).toMatchObject({
    status: "building", enumeration_complete: true, target_count: dependencyCount + 1, completed_count: 0
  });
  const target = environment.index.listTargets(WORKSPACE, generation.generation_id, null, 8)
    .find(candidate => candidate.target.root_id === source.record_id);
  if (target === undefined) throw new Error("expected captured canonical root");
  expect(target).toMatchObject({ source_id: source.source_id, body_bytes: Buffer.byteLength(body),
    target: { kind: "source_evidence", root_id: source.record_id, content_digest: source.content_digest } });

  // Observe the native fixture independently of Core prepare and its returned accounting.
  const native = environment.records.findCurrentBounded(WORKSPACE, source.source_id, 4)!;
  const chunks = environment.database.connection.prepare(`SELECT length(body) AS bytes FROM retained_source_chunks
    WHERE workspace_id=? AND root_id=? ORDER BY start_offset`).all(WORKSPACE, source.record_id) as { bytes: number }[];
  expect(chunks.reduce((sum, chunk) => sum + chunk.bytes, 0)).toBe(Buffer.byteLength(body));
  expect(native.nativeBytes).toBe(chunks[0]!.bytes);
  expect(native.dependencyWork).toBe(2 * dependencyCount);
  expect(native.metadataBytes).toBeGreaterThan(0);
  // Native admission reserves a retained chunk, metadata envelope and dependency fact envelopes.
  const reservation = 4096 + 8192 + 1024 * dependencyCount;
  const limited = environment.records.findCurrentBounded(WORKSPACE, source.source_id, 4, 0,
    { workLimit: 1000, nativeByteLimit: reservation - 1 })!;
  expect(limited).toMatchObject({ resourceLimited: true, nativeBytes: 0, dependencyWork: 0 });
  expect(limited.metadataBytes).toBeGreaterThan(0);
  const guardBytes = native.nativeBytes + native.metadataBytes;
  const readBytes = guardBytes + Buffer.byteLength(body) + chunks.length * native.metadataBytes;
  return { ...environment, lifecycle, selection, generation, origins, source, target, body,
    dependencyCount, chunks, guardBytes, readBytes, reservation, limitedBytes: limited.metadataBytes,
    // Unavailable dependency reads retain the same fixed-size identity facts but no chunk/digest receipt.
    unavailableBytes: native.metadataBytes - 72 };
}
type Environment = ReturnType<typeof setup>;

function instrument(environment: Environment) {
  const current = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findCurrentBounded");
  const chunks = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findByIdBounded");
  const document = vi.spyOn(environment.index, "writeDocument");
  const lexical = vi.spyOn(environment.index, "writeLexical");
  // Observe execution, including reused statements, without replacing any SQL/native implementation.
  const statement = environment.database.connection.prepare("SELECT 1");
  const prototype = Object.getPrototypeOf(statement) as typeof statement;
  const run = vi.spyOn(prototype, "run"), get = vi.spyOn(prototype, "get"), all = vi.spyOn(prototype, "all");
  const statementSql = (context: unknown) => (context as typeof statement).source;
  const runs = () => run.mock.contexts.map((context, index) => ({ sql: statementSql(context),
    args: run.mock.calls[index]!, result: run.mock.results[index]! }));
  const copies = () => runs().filter(call => /INSERT INTO source_index_dependencies[\s\S]*FROM source_records/u.test(call.sql));
  const payloadWrites = () => runs().filter(call =>
    /(?:INSERT INTO|DELETE FROM|UPDATE) source_index_(?:roots|dependencies|text|windows|vectors)\b/u.test(call.sql));
  const selects = () => [...get.mock.contexts, ...all.mock.contexts].map(statementSql);
  return { current, chunks, document, lexical, copies, payloadWrites, selects };
}
type Spies = ReturnType<typeof instrument>;

function expectNativeSql(spies: Spies, current: number, chunks: number, barriers: number, dependencies: number, mutationReads = 0) {
  expect(spies.current).toHaveBeenCalledTimes(current);
  expect(spies.chunks).toHaveBeenCalledTimes(chunks);
  const selects = spies.selects();
  expect(selects.filter(sql => sql.includes("SELECT 1 FROM projection_erase_barriers"))).toHaveLength(barriers);
  const sourceSelects = selects.filter(sql => sql.includes("FROM source_records"));
  expect(sourceSelects.filter(sql => sql.includes("AS metadata_limited"))).toHaveLength(current + chunks);
  expect(sourceSelects.filter(sql => sql.includes("FROM source_records origin"))).toHaveLength(dependencies);
  // Only explicit native publication may hydrate full rows; dependency persistence adds no SELECT.
  expect(sourceSelects.filter(sql => sql.includes(", source_body FROM source_records WHERE workspace_id = ? AND record_id = ? LIMIT 1")))
    .toHaveLength(mutationReads);
  expect(sourceSelects).toHaveLength(current + chunks + dependencies + mutationReads);
}
function expectCopies(environment: Environment, spies: Spies, count: number) {
  expect(spies.copies()).toHaveLength(count);
  expect(spies.copies().map(call => call.args)).toEqual(environment.origins.slice(0, count)
    .map(origin => [environment.target.root_key, WORKSPACE, origin.record_id]));
  for (const call of spies.copies()) {
    expect(call.sql).toContain("SELECT workspace_id,?,'source_record',record_id,source_id FROM source_records");
    if (call.result.type === "return") expect(call.result.value).toMatchObject({ changes: 1 });
  }
}
function dependencies(environment: Environment) {
  return environment.database.connection.prepare(`SELECT workspace_id,root_key,dependency_record_id,dependency_source_id
    FROM source_index_dependencies WHERE workspace_id=? AND root_key=? ORDER BY dependency_record_id`)
    .all(WORKSPACE, environment.target.root_key);
}
function expectDependencies(environment: Environment) {
  expect(dependencies(environment)).toEqual(environment.origins.map(origin => ({ workspace_id: WORKSPACE,
    root_key: environment.target.root_key, dependency_record_id: origin.record_id, dependency_source_id: origin.source_id
  })).sort((left, right) => left.dependency_record_id.localeCompare(right.dependency_record_id)));
  for (const origin of environment.origins) {
    expect(environment.records.findCurrent(WORKSPACE, origin.source_id)?.record_id).toBe(origin.record_id);
  }
}
function payloadState(environment: Environment) {
  return Object.fromEntries(["roots", "dependencies", "text", "windows", "vectors"].map(table => [table,
    environment.database.connection.prepare(`SELECT * FROM source_index_${table} ORDER BY rowid`).all()]));
}
function prepare(environment: Environment, budget: SourceIndexBudget) {
  const result = environment.lifecycle.prepare(WORKSPACE, environment.generation.generation_id, environment.target.root_key, budget);
  for (const key of ["work", "native_bytes"] as const) {
    expect(Number.isSafeInteger(result.resources[key])).toBe(true);
    expect(result.resources[key]).toBeGreaterThanOrEqual(0);
    expect(result.resources[key]).toBeLessThanOrEqual(budget[key]);
  }
  return result;
}
function expectUnpublished(environment: Environment) {
  expect(environment.index.generation(WORKSPACE, environment.generation.generation_id)).toMatchObject({
    completed_count: 0, target_count: environment.dependencyCount + 1, enumeration_complete: true
  });
  expect(environment.lifecycle.publish(WORKSPACE, environment.generation.generation_id))
    .toEqual({ status: "rejected", reason: "incomplete" });
  expect(environment.index.state(WORKSPACE)).toEqual({ status: "building", selection: environment.selection, active_generation_id: null });
}

// Literal work totals: each native read costs five plus two checks per dependency;
// each guard also checks the root/dependency barriers, then each copied dependency costs one.
describe("canonical dependency persistence admission through real SQLite", () => {
  it.each([
    { count: 1, work: 25, spent: 25, copies: 0 }, { count: 1, work: 26, spent: 26, copies: 1 },
    { count: 2, work: 34, spent: 33, copies: 0 }, { count: 2, work: 35, spent: 35, copies: 2 }
  ])("$count dependencies with work $work spend $spent and execute $copies copies", expected => {
    const environment = setup(expected.count);
    const before = payloadState(environment);
    const spies = instrument(environment);
    const result = prepare(environment, { work: expected.work, native_bytes: 131072 });
    expect(result.resources).toEqual({ work: expected.spent, native_bytes: environment.readBytes + environment.guardBytes });
    expectNativeSql(spies, 2, 1, 2 * (expected.count + 1), 3 * expected.count);
    expectCopies(environment, spies, expected.copies);
    expect(spies.lexical).not.toHaveBeenCalled();
    expect(spies.document).toHaveBeenCalledExactlyOnceWith(WORKSPACE, environment.generation.generation_id,
      expect.objectContaining({ source: environment.target, body: environment.body }), {
        work: expected.work - (11 + 5 * expected.count), native_bytes: 131072 - environment.readBytes
      });
    expect(spies.document.mock.results[0]!.value.resources).toEqual({ work: expected.spent - (11 + 5 * expected.count),
      native_bytes: environment.guardBytes });
    if (expected.copies === 0) {
      expect(result).toEqual({ status: "partial", reason: "read_budget", resources: result.resources });
      expect(spies.payloadWrites()).toEqual([]);
      expect(payloadState(environment)).toEqual(before);
      expect(lexicalRows(environment.database)).toEqual([]);
    } else {
      expect(result.status).toBe("ready");
      if (result.status !== "ready") throw new Error("expected canonical preparation");
      expect(result.document.source).toEqual(environment.target);
      expect(result.document.body).toBe(environment.body);
      const digest = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
      const windows = [{ ordinal: 0, start_byte: 0, end_byte: 8, text: "canonica", content_digest: digest("canonica") },
        { ordinal: 1, start_byte: 8, end_byte: 14, text: "l body", content_digest: digest("l body") }];
      expect(result.document.windows.map(({ ordinal, start_byte, end_byte, text, content_digest }) =>
        ({ ordinal, start_byte, end_byte, text, content_digest }))).toEqual(windows);
      expect(environment.database.connection.prepare(`SELECT ordinal,start_byte,end_byte,body AS text,content_digest
        FROM source_index_windows WHERE root_key=? ORDER BY ordinal`).all(environment.target.root_key)).toEqual(windows);
      expect(environment.database.connection.prepare("SELECT window_id FROM source_index_windows WHERE root_key=? ORDER BY ordinal")
        .all(environment.target.root_key)).toEqual(result.document.windows.map(window => ({ window_id: window.window_id })));
      expect(new Set(result.document.windows.map(window => window.window_id)).size).toBe(2);
      expect(lexicalRows(environment.database)).toEqual([{ root_key: environment.target.root_key, body: environment.body, body_bytes: 14 }]);
    }
    expectDependencies(environment);
    expectUnpublished(environment);
  });

  it.each([1, 2])("%i dependencies retain native-byte refusal costs and succeed with the same source at admission", count => {
    const environment = setup(count);
    const before = payloadState(environment);
    const spies = instrument(environment);
    const work = count === 1 ? 26 : 35;
    const threshold = environment.readBytes + environment.reservation;
    expect(prepare(environment, { work, native_bytes: threshold - 1 })).toEqual({ status: "partial", reason: "read_budget",
      resources: { work: 16 + 5 * count, native_bytes: environment.readBytes + environment.limitedBytes } });
    expectNativeSql(spies, 2, 1, count + 1, 2 * count);
    expectCopies(environment, spies, 0);
    expect(spies.current.mock.calls[1]![4]).toEqual({ workLimit: work - (11 + 5 * count),
      nativeByteLimit: environment.reservation - 1 });
    expect(spies.payloadWrites()).toEqual([]);
    expect(payloadState(environment)).toEqual(before);
    vi.clearAllMocks();
    const ready = prepare(environment, { work, native_bytes: threshold });
    expect(ready).toMatchObject({ status: "ready", resources: { work, native_bytes: environment.readBytes + environment.guardBytes } });
    expectNativeSql(spies, 2, 1, 2 * (count + 1), 3 * count);
    expectCopies(environment, spies, count);
    expect(spies.current.mock.calls[1]![4]).toEqual({ workLimit: work - (11 + 5 * count), nativeByteLimit: environment.reservation });
    expectDependencies(environment);
    expectUnpublished(environment);
  });

  it("does not delete a previously published dependency set or alter its payloads on a refused rewrite", () => {
    const environment = setup(2);
    const ready = buildReady(environment, environment.selection.configuration);
    expect(ready.generation.generation_id).toBe(environment.generation.generation_id);
    expectDependencies(environment);
    const before = payloadState(environment);
    const generation = environment.index.generation(WORKSPACE, environment.generation.generation_id);
    const state = environment.index.state(WORKSPACE);
    expect(state).toEqual({ status: "ready", selection: environment.selection, active_generation_id: environment.generation.generation_id });
    const spies = instrument(environment);
    expect(prepare(environment, { work: 34, native_bytes: 131072 })).toEqual({ status: "partial", reason: "read_budget",
      resources: { work: 33, native_bytes: environment.readBytes + environment.guardBytes } });
    expectNativeSql(spies, 2, 1, 6, 6);
    expectCopies(environment, spies, 0);
    expect(spies.payloadWrites()).toEqual([]);
    expect(payloadState(environment)).toEqual(before);
    expectDependencies(environment);
    expect(environment.index.generation(WORKSPACE, environment.generation.generation_id)).toEqual(generation);
    expect(environment.index.state(WORKSPACE)).toEqual(state);
  });
});

describe("canonical capacity-path lexical persistence", () => {
  it.each([
    { count: 1, work: 53, spent: 53, copies: 0 }, { count: 1, work: 54, spent: 54, copies: 1 },
    { count: 2, work: 70, spent: 69, copies: 0 }, { count: 2, work: 71, spent: 71, copies: 2 }
  ])("$count dependencies with work $work admit $copies copies after five body chunks", expected => {
    const environment = setup(expected.count, "full".repeat(4097), 4);
    const before = payloadState(environment);
    const spies = instrument(environment);
    const result = prepare(environment, { work: expected.work, native_bytes: 262144 });
    expect(result).toEqual({ status: "partial", reason: expected.copies === 0 ? "read_budget" : "window_capacity",
      resources: { work: expected.spent, native_bytes: environment.readBytes + environment.guardBytes } });
    expectNativeSql(spies, 2, 5, 2 * (expected.count + 1), 7 * expected.count);
    expectCopies(environment, spies, expected.copies);
    expect(spies.chunks.mock.calls.map(call => call[3])).toEqual([0, 4096, 8192, 12288, 16384]);
    expect(spies.document).not.toHaveBeenCalled();
    const readWork = expected.count === 1 ? 44 : 57;
    expect(spies.lexical).toHaveBeenCalledExactlyOnceWith(environment.target, environment.body,
      { work: expected.work - readWork, native_bytes: 262144 - environment.readBytes });
    expect(spies.lexical.mock.results[0]!.value.resources).toEqual({ work: expected.spent - readWork, native_bytes: environment.guardBytes });
    if (expected.copies === 0) {
      expect(spies.payloadWrites()).toEqual([]);
      expect(payloadState(environment)).toEqual(before);
      expect(lexicalRows(environment.database)).toEqual([]);
    } else expect(lexicalRows(environment.database)).toEqual([
      { root_key: environment.target.root_key, body: environment.body, body_bytes: 16388 }
    ]);
    expect(environment.database.connection.prepare("SELECT window_id FROM source_index_windows").all()).toEqual([]);
    expect(environment.database.connection.prepare("SELECT window_id FROM source_index_vectors").all()).toEqual([]);
    expectDependencies(environment);
    expectUnpublished(environment);
  });
});

describe("canonical persistence rollback and native supersession", () => {
  it("rolls back an admitted dependency replacement when its second actual copy fails, then retries afresh", () => {
    const environment = setup(2);
    buildReady(environment, environment.selection.configuration);
    const before = payloadState(environment);
    const generation = environment.index.generation(WORKSPACE, environment.generation.generation_id);
    const state = environment.index.state(WORKSPACE);
    // Fault injection only: successful rows were built by the real lifecycle and repositories.
    environment.database.connection.exec(`CREATE TRIGGER refuse_second_dependency BEFORE INSERT ON source_index_dependencies
      WHEN (SELECT COUNT(*) FROM source_index_dependencies WHERE workspace_id=NEW.workspace_id AND root_key=NEW.root_key)=1
      BEGIN SELECT RAISE(ABORT, 'dependency copy unavailable'); END`);
    const spies = instrument(environment);
    expect(() => prepare(environment, { work: 35, native_bytes: 131072 })).toThrow(/dependency copy unavailable/u);
    expectNativeSql(spies, 2, 1, 6, 6);
    expectCopies(environment, spies, 2);
    expect(spies.copies().map(call => call.result.type)).toEqual(["return", "throw"]);
    expect(spies.copies()[0]!.result.value).toMatchObject({ changes: 1 });
    expect(payloadState(environment)).toEqual(before);
    expectDependencies(environment);
    expect(environment.index.generation(WORKSPACE, environment.generation.generation_id)).toEqual(generation);
    expect(environment.index.state(WORKSPACE)).toEqual(state);
    environment.database.connection.exec("DROP TRIGGER refuse_second_dependency");
    vi.clearAllMocks();
    expect(prepare(environment, { work: 35, native_bytes: 131072 })).toMatchObject({ status: "ready",
      resources: { work: 35, native_bytes: environment.readBytes + environment.guardBytes } });
    expectNativeSql(spies, 2, 1, 6, 6);
    expectCopies(environment, spies, 2);
    expect(payloadState(environment)).toEqual(before);
    expectDependencies(environment);
    expect(environment.index.state(WORKSPACE)).toEqual(state);
  });

  it.each(["document", "lexical"] as const)("refuses %s persistence after a real dependency supersession without fabricating ready", phase => {
    const capacity = phase === "lexical";
    const environment = setup(1, capacity ? "full".repeat(4097) : "canonical body", capacity ? 4 : 8);
    const before = payloadState(environment);
    const spies = instrument(environment);
    const supersede = () => publishSource(environment, "replacement retained excerpt", environment.origins[0]!.source_id,
      { source_version: "v2", recorded_at: "2026-09-22T00:00:00Z", source_representation: { kind: "retained_excerpt" } });
    if (capacity) {
      const original = environment.index.writeLexical.bind(environment.index);
      spies.lexical.mockImplementationOnce((...args) => { supersede(); return original(...args); });
    } else {
      const original = environment.index.writeDocument.bind(environment.index);
      spies.document.mockImplementationOnce((...args) => { supersede(); return original(...args); });
    }
    const result = prepare(environment, { work: capacity ? 54 : 26, native_bytes: 262144 });
    expect(result.status).toBe("stale");
    if (capacity) {
      // The lexical entry rechecks native dependency eligibility after supersession.
      expect(result).toEqual({ status: "stale", reason: "stale", resources: { work: 51,
        native_bytes: environment.readBytes + environment.unavailableBytes } });
      expect(spies.current.mock.results[1]!.value).toMatchObject({ nativeBytes: 0, dependencyWork: 2,
        metadataBytes: environment.unavailableBytes, record: { source_body: null } });
      expectNativeSql(spies, 2, 5, 2, 7, 3);
    } else {
      expect(result).toEqual({ status: "stale", reason: "stale", resources: { work: 16, native_bytes: environment.readBytes } });
      expectNativeSql(spies, 1, 1, 2, 2, 3);
      expect(spies.document.mock.results[0]!.value).toEqual({ status: "rejected", reason: "stale", resources: { work: 0, native_bytes: 0 } });
    }
    expectCopies(environment, spies, 0);
    expect(spies.payloadWrites()).toEqual([]);
    expect(payloadState(environment)).toEqual(before);
    expect(environment.records.findCurrent(WORKSPACE, environment.origins[0]!.source_id)).toMatchObject({ source_version: "v2" });
    expect(environment.records.findById(WORKSPACE, environment.source.record_id)?.source_body).toBeNull();
    expect(environment.index.generation(WORKSPACE, environment.generation.generation_id)).toMatchObject({
      status: "partial", reason: "source_changed", completed_count: 0
    });
    // The old generation is partial; no generation is bound to the newly advanced native epoch.
    expect(environment.index.state(WORKSPACE)).toEqual({ status: "unbound", selection: environment.selection, active_generation_id: null });
    expect(environment.lifecycle.publish(WORKSPACE, environment.generation.generation_id)).toEqual({ status: "rejected", reason: "stale" });
  });
});
