import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareSourceIndexDocument, type SourceIndexVector } from "@do-soul/alaya-protocol";
import { SqliteFieldSourceRecordRepo } from "../../../repos/field/source-repo.js";
import {
  BUDGET, WORKSPACE, buildReady, captureDocuments, configuration, eraseSource, fieldSha256,
  fixture, ftsMatches, lexicalRows, publishSource, vectorFor, writeVectors, type Fixture
} from "./source-index-fixture.js";

const environments: Fixture[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const environment of environments.splice(0)) environment.database.close();
});
function setup() {
  const environment = fixture();
  environments.push(environment);
  return environment;
}
function prepared(environment: Fixture) {
  const source = publishSource(environment, "guarded vector input");
  const generation = environment.index.begin(environment.index.select(WORKSPACE, configuration()));
  const [document] = captureDocuments(environment, generation);
  if (document === undefined) throw new Error("expected captured fixture document");
  return { source, generation, document, vector: vectorFor(document.windows[0]!) };
}

describe("native retained Source document read boundaries", () => {
  it("reads an original source within 64 KiB and the fixed eleven-work boundary, retaining six-work exhaustion costs", () => {
    const environment = setup();
    const { generation, document } = prepared(environment);
    const current = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findCurrentBounded");
    const chunks = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findByIdBounded");
    for (const work of [1000, 11]) {
      current.mockClear(); chunks.mockClear();
      const result = environment.index.readDocument(WORKSPACE, generation.generation_id, document.source.root_key,
        1024, { work, native_bytes: 65536 });
      expect(result).toMatchObject({ status: "ready", body: "guarded vector input", resources: { work: 11 } });
      // This fixture needs one current-source read, one erase check and one complete-body read.
      expect(current).toHaveBeenCalledTimes(1);
      expect(chunks).toHaveBeenCalledTimes(1);
      expect(result.resources.work).toBeLessThanOrEqual(work);
      expect(result.resources.native_bytes).toBeGreaterThan(0);
      expect(result.resources.native_bytes).toBeLessThanOrEqual(65536);
    }
    current.mockClear(); chunks.mockClear();
    const limited = environment.index.readDocument(WORKSPACE, generation.generation_id, document.source.root_key,
      1024, { work: 6, native_bytes: 65536 });
    expect(limited).toMatchObject({ status: "partial", reason: "read_budget", resources: { work: 6 } });
    expect(limited.resources.native_bytes).toBeGreaterThan(0);
    expect(limited.resources.native_bytes).toBeLessThanOrEqual(65536);
    expect(current).toHaveBeenCalledTimes(1);
    expect(chunks).not.toHaveBeenCalled();
  });

  it.each([
    ["zero work", { work: 0, native_bytes: 65536 }],
    ["zero native bytes", { work: 1000, native_bytes: 0 }],
    ["insufficient byte reservation", { work: 1000, native_bytes: 1 }]
  ] as const)("refuses %s before native reads with zero actual costs", (_name, budget) => {
    const environment = setup();
    const { generation, document } = prepared(environment);
    const current = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findCurrentBounded");
    const chunks = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findByIdBounded");
    expect(environment.index.readDocument(WORKSPACE, generation.generation_id, document.source.root_key, 1024, budget))
      .toEqual({ status: "partial", reason: "read_budget", resources: { work: 0, native_bytes: 0 } });
    expect(current).not.toHaveBeenCalled();
    expect(chunks).not.toHaveBeenCalled();
  });

  it("keeps dependency exhaustion partial and reads the same canonical source with more work", () => {
    const environment = setup();
    const origin = publishSource(environment, "retained dependency", "origin", { source_representation: { kind: "retained_excerpt" } });
    const projection = publishSource(environment, "canonical retained body", "projection", {
      source_representation: { kind: "canonical_projection", source_record_ids: [origin.record_id] }
    });
    const generation = environment.index.begin(environment.index.select(WORKSPACE, configuration()));
    environment.index.capturePage(WORKSPACE, generation.generation_id, 8, BUDGET);
    const source = environment.index.listTargets(WORKSPACE, generation.generation_id, null, 8)
      .find(target => target.target.root_id === projection.record_id)!;
    const current = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findCurrentBounded");
    const chunks = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findByIdBounded");
    const limited = environment.index.readDocument(WORKSPACE, generation.generation_id, source.root_key,
      1024, { work: 6, native_bytes: 65536 });
    expect(limited).toMatchObject({ status: "partial", reason: "read_budget" });
    expect(limited).not.toHaveProperty("body");
    expect(limited.resources.work).toBeGreaterThan(0);
    expect(limited.resources.work).toBeLessThanOrEqual(6);
    expect(limited.resources.native_bytes).toBeGreaterThan(0);
    expect(limited.resources.native_bytes).toBeLessThanOrEqual(65536);
    expect(current).toHaveBeenCalledTimes(1);
    expect(current.mock.results[0]!.value).toMatchObject({ resourceLimited: true });
    expect(chunks).not.toHaveBeenCalled();
    const complete = environment.index.readDocument(WORKSPACE, generation.generation_id, source.root_key,
      1024, { work: 1000, native_bytes: 65536 });
    expect(complete).toMatchObject({ status: "ready", body: "canonical retained body" });
    expect(complete.resources.work).toBeLessThanOrEqual(1000);
    expect(complete.resources.native_bytes).toBeLessThanOrEqual(65536);
  });

  it("does not return a ready prefix when the later native chunk runs out of work", () => {
    const environment = setup();
    const body = `${"a".repeat(4096)}tail`;
    publishSource(environment, body);
    // Two persisted retained chunks make the later-read boundary independent of index status mapping.
    expect(environment.database.connection.prepare("SELECT COUNT(*) AS count FROM retained_source_chunks WHERE workspace_id=?")
      .get(WORKSPACE)).toEqual({ count: 2 });
    const generation = environment.index.begin(environment.index.select(WORKSPACE, configuration()));
    environment.index.capturePage(WORKSPACE, generation.generation_id, 8, BUDGET);
    const [source] = environment.index.listTargets(WORKSPACE, generation.generation_id, null, 8);
    const chunks = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findByIdBounded");
    const limited = environment.index.readDocument(WORKSPACE, generation.generation_id, source!.root_key,
      body.length, { work: 11, native_bytes: 262144 });
    expect(limited).toMatchObject({ status: "partial", reason: "read_budget", resources: { work: 11 } });
    expect(limited).not.toHaveProperty("body");
    expect(limited.resources.native_bytes).toBeGreaterThan(4096);
    expect(limited.resources.native_bytes).toBeLessThanOrEqual(262144);
    expect(chunks).toHaveBeenCalledTimes(1);
    expect(chunks.mock.results[0]!.value).toMatchObject({ prefixBytes: 4096, record: { source_body: "a".repeat(4096) } });
    expect(chunks.mock.results[0]!.value?.resourceLimited).not.toBe(true);
    chunks.mockClear();
    const complete = environment.index.readDocument(WORKSPACE, generation.generation_id, source!.root_key,
      body.length, { work: 16, native_bytes: 262144 });
    expect(complete).toMatchObject({ status: "ready", body, resources: { work: 16 } });
    expect(chunks).toHaveBeenCalledTimes(2);
    expect(chunks.mock.calls.map(call => call[3])).toEqual([0, 4096]);
  });

  it("reports missing retained chunks as unavailable, never empty or ready", () => {
    const environment = setup();
    const { source, generation, document } = prepared(environment);
    expect(environment.database.connection.prepare("DELETE FROM retained_source_chunks WHERE workspace_id=? AND root_id=?")
      .run(WORKSPACE, source.record_id).changes).toBeGreaterThan(0);
    const result = environment.index.readDocument(WORKSPACE, generation.generation_id, document.source.root_key, 1024, BUDGET);
    expect(result).toMatchObject({ status: "partial", reason: "native_source_unavailable" });
    expect(result).not.toHaveProperty("body");
    expect(result.resources.work).toBeGreaterThan(0);
    expect(result.resources.native_bytes).toBeGreaterThan(0);
  });

  // Response-mapping coverage only: normal readers cannot emit these malformed chunk outcomes.
  it.each(["zero prefix", "invalid offset"] as const)("maps an injected %s response to incomplete_source_bytes", outcome => {
    const environment = setup();
    const { generation, document } = prepared(environment);
    const original = SqliteFieldSourceRecordRepo.prototype.findByIdBounded;
    vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findByIdBounded").mockImplementationOnce((...args) => {
      const read = original.call(environment.records, ...args);
      if (read === null) throw new Error("expected retained chunk for response injection");
      return { ...read, ...(outcome === "zero prefix" ? { prefixBytes: 0 } : { invalidOffset: true }) };
    });
    const result = environment.index.readDocument(WORKSPACE, generation.generation_id, document.source.root_key, 1024, BUDGET);
    expect(result).toMatchObject({ status: "partial", reason: "incomplete_source_bytes" });
    expect(result).not.toHaveProperty("body");
    expect(result.resources.work).toBe(11);
    expect(result.resources.native_bytes).toBeGreaterThan(0);
  });

  it("distinguishes missing generation, missing target and failed generation before native reads", () => {
    const environment = setup();
    const { generation, document } = prepared(environment);
    const current = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findCurrentBounded");
    const chunks = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findByIdBounded");
    expect(environment.index.readDocument(WORKSPACE, "missing-generation", document.source.root_key, 1024, BUDGET))
      .toEqual({ status: "unbound", reason: "missing_generation", resources: { work: 0, native_bytes: 0 } });
    expect(environment.index.readDocument(WORKSPACE, generation.generation_id, "missing-root", 1024, BUDGET))
      .toEqual({ status: "unbound", reason: "missing_target", resources: { work: 0, native_bytes: 0 } });
    environment.index.fail(WORKSPACE, generation.generation_id, "interrupted");
    expect(environment.index.readDocument(WORKSPACE, generation.generation_id, document.source.root_key, 1024, BUDGET))
      .toEqual({ status: "partial", reason: "incomplete", resources: { work: 0, native_bytes: 0 } });
    expect(current).not.toHaveBeenCalled();
    expect(chunks).not.toHaveBeenCalled();
  });

  it("propagates SQLite target parse failures and rereads after an owner-mediated repair", () => {
    const environment = setup();
    const { generation, document } = prepared(environment);
    expect(environment.database.connection.prepare("UPDATE source_index_roots SET target_json='not json' WHERE workspace_id=? AND root_key=?")
      .run(WORKSPACE, document.source.root_key).changes).toBe(1);
    expect(() => environment.index.readDocument(WORKSPACE, generation.generation_id, document.source.root_key, 1024, BUDGET)).toThrow();
    const repaired = environment.index.writeLexical(document.source, document.body, BUDGET);
    expect(repaired).toEqual({ status: "accepted", resources: { work: 6, native_bytes: expect.any(Number) } });
    expect(repaired.resources.native_bytes).toBeGreaterThan(0);
    expect(repaired.resources.native_bytes).toBeLessThanOrEqual(BUDGET.native_bytes);
    expect(environment.index.readDocument(WORKSPACE, generation.generation_id, document.source.root_key, 1024, BUDGET))
      .toMatchObject({ status: "ready", body: "guarded vector input" });
  });

  it("propagates native read exceptions and performs a fresh successful retry", () => {
    const environment = setup();
    const { generation, document } = prepared(environment);
    const error = new Error("injected native reader failure");
    const current = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findCurrentBounded")
      .mockImplementationOnce(() => { throw error; });
    expect(() => environment.index.readDocument(WORKSPACE, generation.generation_id, document.source.root_key, 1024, BUDGET)).toThrow(error);
    expect(environment.index.readDocument(WORKSPACE, generation.generation_id, document.source.root_key, 1024, BUDGET))
      .toMatchObject({ status: "ready", body: "guarded vector input" });
    expect(current).toHaveBeenCalledTimes(2);
  });
});

const invalidVectors: ReadonlyArray<readonly [string, (vector: SourceIndexVector) => SourceIndexVector]> = [
  ["wrong input digest", vector => ({ ...vector, input_digest: `sha256:${"f".repeat(64)}` })],
  ["wrong dimension", vector => ({ ...vector, embedding: new Float32Array([1, 0]) })],
  ["NaN component", vector => ({ ...vector, embedding: new Float32Array([1, Number.NaN, 0]) })],
  ["infinite component", vector => ({ ...vector, embedding: new Float32Array([1, Infinity, 0]) })],
  ["zero vector", vector => ({ ...vector, embedding: new Float32Array(3) })],
  ["token cap exceeded", vector => ({ ...vector, token_count: 9 })],
  ["zero token count", vector => ({ ...vector, token_count: 0 })],
  ["fractional token count", vector => ({ ...vector, token_count: 1.5 })],
  ["truncated runtime result", vector => ({ ...vector, truncated: true } as unknown as SourceIndexVector)]
];

describe("native Source index persistence and publication guards", () => {
  it.each(invalidVectors)("rejects %s at the compatible complete-window guard without completing a target", (_name, invalid) => {
    const environment = setup();
    const { generation, document, vector } = prepared(environment);
    expect(document.windows).toHaveLength(3);
    expect(environment.index.generation(WORKSPACE, generation.generation_id)).toMatchObject({
      enumeration_complete: true, target_count: 1, completed_count: 0
    });
    expect(() => environment.index.writeVector(WORKSPACE, generation.generation_id, invalid(vector)))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED", message: "source vector requires compatible complete window input" }));
    expect(environment.database.connection.prepare("SELECT window_id FROM source_index_vectors").all()).toEqual([]);
    // Valid data for the same persisted window must reach acceptance, not an earlier schema/target guard.
    expect(environment.index.writeVector(WORKSPACE, generation.generation_id, vector)).toEqual({ status: "accepted" });
    expect(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "rejected", reason: "incomplete" });
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "building", active_generation_id: null });
  });

  it("makes exact vector retries idempotent and rejects changed bytes or token accounting", () => {
    const environment = setup();
    const { generation, document } = prepared(environment);
    writeVectors(environment, generation, [document]);
    const before = environment.database.connection.prepare("SELECT window_id,embedding_blob,token_count FROM source_index_vectors ORDER BY window_id").all();
    const vector = vectorFor(document.windows[0]!);
    expect(environment.index.writeVector(WORKSPACE, generation.generation_id, vector)).toEqual({ status: "accepted" });
    for (const changed of [{ ...vector, embedding: new Float32Array([0, 1, 0]) }, { ...vector, token_count: 3 }]) {
      expect(() => environment.index.writeVector(WORKSPACE, generation.generation_id, changed))
        .toThrowError(expect.objectContaining({ code: "CONFLICT", message: "source index vector retry differs from its persisted result" }));
    }
    expect(environment.database.connection.prepare("SELECT window_id,embedding_blob,token_count FROM source_index_vectors ORDER BY window_id").all()).toEqual(before);
    expect(environment.index.generation(WORKSPACE, generation.generation_id)).toMatchObject({ completed_count: 1 });
    expect(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "accepted" });
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "ready", active_generation_id: generation.generation_id });
  });

  it("rejects a clipped manifest at the manifest guard, then accepts the complete manifest", () => {
    const environment = setup();
    publishSource(environment, "complete retained body");
    const generation = environment.index.begin(environment.index.select(WORKSPACE, configuration()));
    environment.index.capturePage(WORKSPACE, generation.generation_id, 8, BUDGET);
    const [source] = environment.index.listTargets(WORKSPACE, generation.generation_id, null, 8);
    const document = prepareSourceIndexDocument({ source: source!, body: "complete retained body", profile: configuration().profile }, fieldSha256);
    expect(() => environment.index.writeDocument(WORKSPACE, generation.generation_id, { ...document, windows: document.windows.slice(0, 1) }))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED", message: "source index window manifest mismatch" }));
    expect(environment.database.connection.prepare("SELECT window_id FROM source_index_windows").all()).toEqual([]);
    expect(environment.index.generation(WORKSPACE, generation.generation_id)).toMatchObject({ completed_count: 0 });
    const write = environment.index.writeDocument(WORKSPACE, generation.generation_id, document, BUDGET);
    expect(write).toEqual({ status: "accepted", resources: { work: 6, native_bytes: expect.any(Number) } });
    expect(write.resources.native_bytes).toBeGreaterThan(0);
    expect(write.resources.native_bytes).toBeLessThanOrEqual(BUDGET.native_bytes);
    expect(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "rejected", reason: "incomplete" });
  });

  it.each(["source_index_windows", "source_index_vectors"])("rechecks missing persisted payloads in %s at publication", table => {
    const environment = setup();
    const { generation, document } = prepared(environment);
    writeVectors(environment, generation, [document]);
    expect(environment.index.generation(WORKSPACE, generation.generation_id)).toMatchObject({ enumeration_complete: true, completed_count: 1 });
    // Negative corruption only: successful preparation above used the native publication and repository owners.
    expect(environment.database.connection.prepare(`DELETE FROM ${table} WHERE workspace_id=? AND generation_id=? AND window_id=?`)
      .run(WORKSPACE, generation.generation_id, document.windows[0]!.window_id).changes).toBe(1);
    expect.soft(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "rejected", reason: "incomplete" });
    expect.soft(environment.index.state(WORKSPACE)).toMatchObject({ active_generation_id: null });
  });

  it.each(["supersession", "deletion", "scope change", "erase barrier"] as const)("rejects delayed document/vector writes after native %s", mutation => {
    const environment = setup();
    const { source, generation, document, vector } = prepared(environment);
    if (mutation === "supersession") {
      const replacement = publishSource(environment, "replacement current body", source.source_id,
        { source_version: "v2", recorded_at: "2026-09-22T00:00:00Z" });
      expect(environment.records.findCurrent(WORKSPACE, source.source_id)?.record_id).toBe(replacement.record_id);
    } else if (mutation === "deletion") {
      // Simulate physical native loss, not a manufactured index success.
      expect(environment.database.connection.prepare("DELETE FROM source_records WHERE workspace_id=? AND record_id=?")
        .run(WORKSPACE, source.record_id).changes).toBe(1);
      expect(environment.records.findById(WORKSPACE, source.record_id)).toBeNull();
    } else if (mutation === "scope change") {
      // A metadata repair keeps the gold tuple but must still invalidate in-flight projection work.
      expect(environment.database.connection.prepare("UPDATE source_records SET scope_class='global_core' WHERE workspace_id=? AND record_id=?")
        .run(WORKSPACE, source.record_id).changes).toBe(1);
      expect(environment.records.findCurrent(WORKSPACE, source.source_id)?.scope_class).toBe("global_core");
    } else {
      eraseSource(environment, source.record_id);
      expect(environment.erase.isErased(WORKSPACE, source.record_id)).toBe(true);
      expect(environment.records.findById(WORKSPACE, source.record_id)?.source_body).toBeNull();
    }
    expect(environment.index.writeDocument(WORKSPACE, generation.generation_id, document, BUDGET))
      .toEqual({ status: "rejected", reason: "stale", resources: { work: 0, native_bytes: 0 } });
    expect(environment.index.writeVector(WORKSPACE, generation.generation_id, vector)).toEqual({ status: "rejected", reason: "stale" });
    expect(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "rejected", reason: "stale" });
    if (mutation !== "scope change") {
      const lexical = environment.index.writeLexical(document.source, document.body, BUDGET);
      expect(lexical).toEqual({ status: "rejected", reason: "stale", resources: {
        work: mutation === "deletion" ? 1 : 5, native_bytes: expect.any(Number)
      } });
      if (mutation === "deletion") expect(lexical.resources.native_bytes).toBe(0);
      else expect(lexical.resources.native_bytes).toBeGreaterThan(0);
      expect(lexical.resources.native_bytes).toBeLessThanOrEqual(BUDGET.native_bytes);
    }
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "unbound", active_generation_id: null });
    expect(lexicalRows(environment.database)).toEqual([]);
  });

  it("rejects a delayed canonical projection after its native dependency disappears", () => {
    const environment = setup();
    const origin = publishSource(environment, "retained origin", "origin", { source_representation: { kind: "retained_excerpt" } });
    const projection = publishSource(environment, "User retained origin", "projection", {
      source_representation: { kind: "canonical_projection", source_record_ids: [origin.record_id] }
    });
    const generation = environment.index.begin(environment.index.select(WORKSPACE, configuration()));
    const documents = captureDocuments(environment, generation);
    const document = documents.find(value => value.source.target.root_id === projection.record_id)!;
    expect(document.body).toBe("User retained origin");
    expect(environment.database.connection.prepare("DELETE FROM source_records WHERE workspace_id=? AND record_id=?")
      .run(WORKSPACE, origin.record_id).changes).toBe(1);
    expect(environment.records.findById(WORKSPACE, projection.record_id)?.source_body).toBeNull();
    expect(environment.index.writeDocument(WORKSPACE, generation.generation_id, document, BUDGET))
      .toEqual({ status: "rejected", reason: "stale", resources: { work: 0, native_bytes: 0 } });
    expect(environment.index.writeVector(WORKSPACE, generation.generation_id, vectorFor(document.windows[0]!))).toEqual({ status: "rejected", reason: "stale" });
    const lexical = environment.index.writeLexical(document.source, document.body, BUDGET);
    expect(lexical).toEqual({ status: "rejected", reason: "stale", resources: { work: 7, native_bytes: expect.any(Number) } });
    expect(lexical.resources.native_bytes).toBeGreaterThan(0);
    expect(lexical.resources.native_bytes).toBeLessThanOrEqual(BUDGET.native_bytes);
    expect(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "rejected", reason: "stale" });
    expect(lexicalRows(environment.database)).toEqual([]);
  });

  it("scrubs pointer-bound, building and retired payloads plus dependent canonical projections in the native erase transaction", () => {
    const environment = setup();
    const origin = publishSource(environment, "privateerase origin", "origin", { source_representation: { kind: "retained_excerpt" } });
    const projection = publishSource(environment, "User privateerase projection", "projection", {
      source_representation: { kind: "canonical_projection", source_record_ids: [origin.record_id] }
    });
    const retired = buildReady(environment);
    const active = buildReady(environment, configuration({ model_revision: "v2" }));
    expect(environment.index.generation(WORKSPACE, retired.generation.generation_id)?.status).toBe("retired");
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "ready", active_generation_id: active.generation.generation_id });
    publishSource(environment, "public untouched", "unrelated");
    const building = environment.index.begin(active.generation.selection);
    const buildingDocuments = captureDocuments(environment, building);
    writeVectors(environment, building, buildingDocuments);
    expect(environment.index.generation(WORKSPACE, building.generation_id)?.status).toBe("building");
    // Native epoch change leaves the old pointer distinguishably partial, not falsely ready.
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "partial", active_generation_id: active.generation.generation_id });
    const privateRoots = active.documents.map(document => document.source.root_key);
    expect(privateRoots).toHaveLength(2);
    const payloads = (table: string) => environment.database.connection.prepare(
      `SELECT * FROM ${table} WHERE workspace_id=? AND root_key IN (?,?)`).all(WORKSPACE, ...privateRoots);
    for (const table of ["source_index_windows", "source_index_vectors"]) {
      const rows = payloads(table) as { generation_id: string }[];
      expect(new Set(rows.map(row => row.generation_id))).toEqual(new Set([
        retired.generation.generation_id, active.generation.generation_id, building.generation_id
      ]));
    }
    expect(ftsMatches(environment.database, "privateerase")).toHaveLength(2);
    environment.database.connection.transaction(() => {
      eraseSource(environment, origin.record_id);
      expect(environment.database.connection.inTransaction).toBe(true);
      for (const record of [origin, projection]) {
        expect(environment.database.connection.prepare("SELECT source_body FROM source_records WHERE workspace_id=? AND record_id=?")
          .get(WORKSPACE, record.record_id)).toEqual({ source_body: null });
        expect(environment.database.connection.prepare("SELECT root_id FROM retained_source_chunks WHERE workspace_id=? AND root_id=?")
          .all(WORKSPACE, record.record_id)).toEqual([]);
        expect(environment.erase.isErased(WORKSPACE, record.record_id)).toBe(true);
      }
      for (const table of ["source_index_text", "source_index_windows", "source_index_vectors"]) expect(payloads(table)).toEqual([]);
      expect(ftsMatches(environment.database, "privateerase")).toEqual([]);
      expect(environment.database.connection.prepare(`SELECT DISTINCT expected_windows,complete FROM source_index_targets
        WHERE workspace_id=? AND root_key IN (?,?)`).all(WORKSPACE, ...privateRoots)).toEqual([{ expected_windows: null, complete: 0 }]);
    })();
    expect(ftsMatches(environment.database, "privateerase")).toEqual([]);
    expect(ftsMatches(environment.database, "public")).toHaveLength(1);
    expect(environment.index.generation(WORKSPACE, retired.generation.generation_id)).toMatchObject({ status: "retired", completed_count: 0 });
    expect(environment.index.generation(WORKSPACE, active.generation.generation_id)).toMatchObject({ status: "partial", completed_count: 0 });
    expect(environment.index.generation(WORKSPACE, building.generation_id)).toMatchObject({ status: "partial", completed_count: 1 });
    expect(environment.index.writeVector(WORKSPACE, building.generation_id, vectorFor(buildingDocuments.find(document =>
      document.source.target.root_id === projection.record_id)!.windows[0]!))).toEqual({ status: "rejected", reason: "stale" });
    expect(environment.index.activate(WORKSPACE, building.generation_id)).toEqual({ status: "rejected", reason: "stale" });
  });

  it("rolls back the native barrier, bodies, FTS and pointer state when projection scrubbing fails", () => {
    const environment = setup();
    const source = publishSource(environment, "privateerase atomic");
    const ready = buildReady(environment);
    const snapshot = ["source_index_text", "source_index_windows", "source_index_vectors"].map(table =>
      environment.database.connection.prepare(`SELECT * FROM ${table}`).all());
    environment.database.connection.exec(`CREATE TRIGGER reject_vector_scrub BEFORE DELETE ON source_index_vectors
      BEGIN SELECT RAISE(ABORT, 'injected projection scrub failure'); END`);
    expect(() => eraseSource(environment, source.record_id)).toThrow(/erase barrier/u);
    expect(environment.erase.isErased(WORKSPACE, source.record_id)).toBe(false);
    expect(environment.records.findById(WORKSPACE, source.record_id)?.source_body).toBe("privateerase atomic");
    expect(ftsMatches(environment.database, "privateerase")).toHaveLength(1);
    expect(["source_index_text", "source_index_windows", "source_index_vectors"].map(table =>
      environment.database.connection.prepare(`SELECT * FROM ${table}`).all())).toEqual(snapshot);
    expect(environment.index.generation(WORKSPACE, ready.generation.generation_id)).toEqual(ready.generation);
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "ready", active_generation_id: ready.generation.generation_id });
  });

  it("keeps equal persisted native record ids and their erasure independent across workspaces", () => {
    const environment = setup();
    const first = publishSource(environment, "privateerase shared identity");
    const second = publishSource(environment, "privateerase shared identity", "source-a", { workspace_id: "workspace-2" });
    expect(first.record_id).toBe(second.record_id);
    const firstBuild = buildReady(environment);
    const secondBuild = buildReady(environment, configuration(), "workspace-2");
    const otherLexical = lexicalRows(environment.database, "workspace-2");
    const otherVectors = environment.database.connection.prepare("SELECT * FROM source_index_vectors WHERE workspace_id='workspace-2'").all();
    expect(otherVectors.length).toBeGreaterThan(0);
    eraseSource(environment, first.record_id);
    expect(environment.records.findById(WORKSPACE, first.record_id)?.source_body).toBeNull();
    expect(environment.records.findById("workspace-2", second.record_id)?.source_body).toBe("privateerase shared identity");
    expect(lexicalRows(environment.database)).toEqual([]);
    expect(lexicalRows(environment.database, "workspace-2")).toEqual(otherLexical);
    expect(ftsMatches(environment.database, "privateerase", "workspace-2")).toHaveLength(1);
    expect(environment.database.connection.prepare("SELECT * FROM source_index_vectors WHERE workspace_id='workspace-2'").all()).toEqual(otherVectors);
    expect(environment.index.generation("workspace-2", secondBuild.generation.generation_id)).toEqual(secondBuild.generation);
    expect(environment.index.state("workspace-2")).toMatchObject({ status: "ready", active_generation_id: secondBuild.generation.generation_id });
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "partial", active_generation_id: firstBuild.generation.generation_id });
  });
});
