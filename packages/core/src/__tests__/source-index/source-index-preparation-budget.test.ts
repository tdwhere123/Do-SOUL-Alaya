import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceIndexBudget, SourceIndexResources } from "@do-soul/alaya-protocol";
import { SourceIndexLifecycle } from "../../source-index/source-index-lifecycle.js";
import { SqliteFieldSourceRecordRepo } from "../../../../storage/src/repos/field/source-repo.js";
import {
  BUDGET, WORKSPACE, configuration, fieldSha256, fixture, lexicalRows, publishSource, type Fixture
} from "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";

const environments: Fixture[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const environment of environments.splice(0)) environment.database.close();
});

function setup(body = "budget body", windowBytes = 8) {
  const environment = fixture();
  environments.push(environment);
  const source = publishSource(environment, body);
  const lifecycle = new SourceIndexLifecycle(environment.index, fieldSha256);
  const selection = lifecycle.select(WORKSPACE, configuration({ window_bytes: windowBytes }));
  const generation = lifecycle.begin(selection);
  lifecycle.capture(WORKSPACE, generation.generation_id, 8, BUDGET);
  const [target] = environment.index.listTargets(WORKSPACE, generation.generation_id, null, 8);
  if (target === undefined) throw new Error("expected captured native source");
  // Independent native observation, before lifecycle instrumentation. A four-byte prefix still reads
  // the entire retained chunk; metadata costs are fixture-dependent, not a prepare-result oracle.
  const native = environment.records.findCurrentBounded(WORKSPACE, source.source_id, 4)!;
  const chunks = environment.database.connection.prepare(`SELECT length(body) AS bytes FROM retained_source_chunks
    WHERE workspace_id=? AND root_id=? ORDER BY start_offset`).all(WORKSPACE, source.record_id) as { bytes: number }[];
  const bodyBytes = Buffer.byteLength(body, "utf8");
  expect(chunks.reduce((sum, chunk) => sum + chunk.bytes, 0)).toBe(bodyBytes);
  expect(native.nativeBytes).toBe(chunks[0]?.bytes ?? 0);
  expect(native.metadataBytes).toBeGreaterThan(0);
  expect(native.dependencyWork).toBe(0);
  const guardBytes = native.nativeBytes + native.metadataBytes;
  const readBytes = guardBytes + bodyBytes + chunks.length * native.metadataBytes;
  return { ...environment, lifecycle, source, target, generation, body, guardBytes, readBytes };
}
type Environment = ReturnType<typeof setup>;

function instrument(environment: Environment) {
  // These spies observe real native calls; none replaces their implementation.
  const current = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findCurrentBounded");
  const chunks = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findByIdBounded");
  // Hot read statements are compiled once, so count executions rather than compilations.
  const executions = vi.spyOn(Object.getPrototypeOf(environment.database.connection.prepare("SELECT 1")) as { get(): unknown }, "get");
  const lexical = vi.spyOn(environment.index, "writeLexical");
  const document = vi.spyOn(environment.index, "writeDocument");
  const barrierChecks = () => executions.mock.contexts.filter(statement => {
    const sql = (statement as { source: string }).source;
    return sql.includes("SELECT 1 FROM projection_erase_barriers") && sql.includes("subject_kind = 'source_record'");
  }).length;
  return { current, chunks, lexical, document, barrierChecks };
}
function expectNativeCalls(spies: ReturnType<typeof instrument>, current: number, chunks: number, barriers: number) {
  expect(spies.current).toHaveBeenCalledTimes(current);
  expect(spies.chunks).toHaveBeenCalledTimes(chunks);
  expect(spies.barrierChecks()).toBe(barriers);
}
function expectWithinAllowance(resources: SourceIndexResources, budget: SourceIndexBudget) {
  for (const key of ["work", "native_bytes"] as const) {
    expect(Number.isSafeInteger(resources[key])).toBe(true);
    expect(resources[key]).toBeGreaterThanOrEqual(0);
    expect(resources[key]).toBeLessThanOrEqual(budget[key]);
  }
}
function prepare(environment: Environment, budget: SourceIndexBudget, maxBytes?: number) {
  const result = environment.lifecycle.prepare(WORKSPACE, environment.generation.generation_id,
    environment.target.root_key, budget, maxBytes);
  expectWithinAllowance(result.resources, budget);
  return result;
}
function expectNoPayloads(environment: Environment) {
  for (const table of ["source_index_text", "source_index_windows", "source_index_vectors"]) {
    expect(environment.database.connection.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
  }
  expect(environment.index.generation(WORKSPACE, environment.generation.generation_id)).toMatchObject({ completed_count: 0 });
}

// Literal work expectations follow native operations: five per retained read, one per erase check.
// No provider or inference claim is made by this SQLite lifecycle accounting suite.
describe("aggregate Source preparation budget through actual SQLite", () => {
  it.each([
    { work: 0, status: "partial", current: 0, chunks: 0, barriers: 0, byteReads: 0 },
    { work: 5, status: "partial", current: 1, chunks: 0, barriers: 0, byteReads: 1 },
    { work: 6, status: "partial", current: 1, chunks: 0, barriers: 1, byteReads: 1 },
    { work: 11, status: "partial", current: 1, chunks: 1, barriers: 1, byteReads: 2 },
    { work: 16, status: "partial", current: 2, chunks: 1, barriers: 1, byteReads: 3 },
    { work: 17, status: "ready", current: 2, chunks: 1, barriers: 2, byteReads: 3 }
  ])("work $work returns $status with only actual native debits", expected => {
    const environment = setup();
    const spies = instrument(environment);
    const budget = { work: expected.work, native_bytes: 65536 };
    const result = prepare(environment, budget);
    expect(result.resources).toEqual({ work: expected.work, native_bytes: expected.byteReads * environment.guardBytes });
    expect(result.status).toBe(expected.status);
    expectNativeCalls(spies, expected.current, expected.chunks, expected.barriers);
    expect(spies.lexical).not.toHaveBeenCalled();
    if (expected.work < 11) expect(spies.document).not.toHaveBeenCalled();
    else {
      expect(spies.document).toHaveBeenCalledExactlyOnceWith(WORKSPACE, environment.generation.generation_id,
        expect.objectContaining({ body: "budget body" }),
        { work: expected.work - 11, native_bytes: 65536 - environment.readBytes });
      expect(spies.document.mock.results[0]!.value.resources).toEqual({
        work: expected.work - 11, native_bytes: expected.work === 11 ? 0 : environment.guardBytes
      });
    }
    if (result.status !== "ready") {
      expect(result).toEqual({ status: "partial", reason: "read_budget", resources: result.resources });
      expectNoPayloads(environment);
    } else {
      expect(result.document.body).toBe("budget body");
      expect(lexicalRows(environment.database)).toEqual([
        { root_key: environment.target.root_key, body: "budget body", body_bytes: 11 }
      ]);
      expect(environment.database.connection.prepare("SELECT ordinal,body FROM source_index_windows ORDER BY ordinal").all())
        .toEqual([{ ordinal: 0, body: "budget b" }, { ordinal: 1, body: "ody" }]);
    }
  });

  it("admits the final guard only at the remaining native reservation and retries the same source with more bytes", () => {
    const environment = setup();
    const spies = instrument(environment);
    // 12,288 is the native reservation (one 4 KiB chunk plus an 8 KiB metadata envelope),
    // not an actual debit. Read costs come from the independent native observation above.
    const threshold = environment.readBytes + 12288;
    const refused = prepare(environment, { work: 17, native_bytes: threshold - 1 });
    expect(refused).toEqual({ status: "partial", reason: "read_budget",
      resources: { work: 11, native_bytes: environment.readBytes } });
    expectNativeCalls(spies, 1, 1, 1);
    expect(spies.document.mock.calls[0]![3]).toEqual({ work: 6, native_bytes: 12287 });
    expect(spies.document.mock.results[0]!.value.resources).toEqual({ work: 0, native_bytes: 0 });
    expectNoPayloads(environment);
    vi.clearAllMocks();
    const admitted = prepare(environment, { work: 17, native_bytes: threshold });
    expect(admitted).toMatchObject({ status: "ready", resources: {
      work: 17, native_bytes: environment.readBytes + environment.guardBytes
    } });
    expectNativeCalls(spies, 2, 1, 2);
    expect(spies.document.mock.calls[0]![3]).toEqual({ work: 6, native_bytes: 12288 });
    expect(spies.current.mock.calls[1]![4]).toEqual({ workLimit: 6, nativeByteLimit: 12288 });
    vi.clearAllMocks();
    const control = prepare(environment, { work: 1000, native_bytes: 65536 });
    expect(control).toMatchObject({ status: "ready", resources: { work: 17,
      native_bytes: environment.readBytes + environment.guardBytes } });
    expectNativeCalls(spies, 2, 1, 2);
    expect(spies.lexical).not.toHaveBeenCalled();
  });

  it.each([0, 1, 12287])("refuses a %i-byte native allowance without any native read or synthetic debit", nativeBytes => {
    const environment = setup();
    const spies = instrument(environment);
    expect(prepare(environment, { work: 1000, native_bytes: nativeBytes }))
      .toEqual({ status: "partial", reason: "read_budget", resources: { work: 0, native_bytes: 0 } });
    expectNativeCalls(spies, 0, 0, 0);
    expect(spies.document).not.toHaveBeenCalled();
    expect(spies.lexical).not.toHaveBeenCalled();
    expectNoPayloads(environment);
  });

  it("does not charge a body read for an empty retained body", () => {
    const environment = setup("");
    const spies = instrument(environment);
    expect(prepare(environment, { work: 12, native_bytes: 65536 })).toMatchObject({
      status: "ready", document: { body: "", windows: [] },
      resources: { work: 12, native_bytes: 2 * environment.guardBytes }
    });
    expectNativeCalls(spies, 2, 0, 2);
    expect(spies.lexical).not.toHaveBeenCalled();
    expect(lexicalRows(environment.database)).toEqual([{ root_key: environment.target.root_key, body: "", body_bytes: 0 }]);
  });

  it("preserves body-capacity refusal and only charges the performed current read and barrier", () => {
    const environment = setup();
    const spies = instrument(environment);
    expect(prepare(environment, { work: 17, native_bytes: 65536 }, 10)).toEqual({
      status: "partial", reason: "body_capacity", resources: { work: 6, native_bytes: environment.guardBytes }
    });
    expectNativeCalls(spies, 1, 0, 1);
    expect(spies.document).not.toHaveBeenCalled();
    expect(spies.lexical).not.toHaveBeenCalled();
    expectNoPayloads(environment);
  });
});

describe("capacity-path lexical preservation under the aggregate budget", () => {
  it.each([31, 36, 37])("work %i charges complete body assembly plus only the performed lexical guard", work => {
    const body = "full".repeat(4097);
    const environment = setup(body, 4);
    const spies = instrument(environment);
    // Five persisted body chunks: six-work initial guard + 5*5 body reads = 31.
    // The final guard consumes zero, five (barrier refused), or six work respectively.
    const result = prepare(environment, { work, native_bytes: 262144 });
    expect(result).toEqual({ status: "partial", reason: work === 37 ? "window_capacity" : "read_budget",
      resources: { work, native_bytes: environment.readBytes + (work === 31 ? 0 : environment.guardBytes) } });
    expectNativeCalls(spies, work === 31 ? 1 : 2, 5, work === 37 ? 2 : 1);
    expect(spies.chunks.mock.calls.map(call => call[3])).toEqual([0, 4096, 8192, 12288, 16384]);
    expect(spies.document).not.toHaveBeenCalled();
    expect(spies.lexical).toHaveBeenCalledExactlyOnceWith(environment.target, body,
      { work: work - 31, native_bytes: 262144 - environment.readBytes });
    expect(spies.lexical.mock.results[0]!.value.resources).toEqual({ work: work - 31,
      native_bytes: work === 31 ? 0 : environment.guardBytes });
    if (work < 37) expectNoPayloads(environment);
    else {
      expect(lexicalRows(environment.database)).toEqual([{ root_key: environment.target.root_key, body, body_bytes: 16388 }]);
      expect(environment.database.connection.prepare("SELECT window_id FROM source_index_windows").all()).toEqual([]);
      expect(environment.index.generation(WORKSPACE, environment.generation.generation_id)).toMatchObject({ completed_count: 0 });
      expect(environment.lifecycle.publish(WORKSPACE, environment.generation.generation_id))
        .toEqual({ status: "rejected", reason: "incomplete" });
    }
  });

  it("retains both body assembly and a refused lexical guard's costs after real native supersession", () => {
    const environment = setup("full".repeat(4097), 4);
    const replacementBody = "replacement native body";
    const spies = instrument(environment);
    const original = environment.index.writeLexical.bind(environment.index);
    spies.lexical.mockImplementationOnce((...args) => {
      publishSource(environment, replacementBody, environment.source.source_id,
        { source_version: "v2", recorded_at: "2026-09-22T00:00:00Z" });
      return original(...args);
    });
    const result = prepare(environment, { work: 37, native_bytes: 262144 });
    expectNativeCalls(spies, 2, 5, 1);
    const guardRead = spies.current.mock.results[1]!.value!;
    expect(guardRead.nativeBytes).toBe(Buffer.byteLength(replacementBody));
    expect(guardRead.dependencyWork).toBe(0);
    expect(result).toEqual({ status: "stale", reason: "stale", resources: { work: 36,
      native_bytes: environment.readBytes + guardRead.nativeBytes + guardRead.metadataBytes } });
    expect(spies.document).not.toHaveBeenCalled();
    expectNoPayloads(environment);
  });
});

describe("preparation interleavings and errors retain their distinct meanings", () => {
  it.each(["stale", "superseded"] as const)("preserves %s after a real mutation immediately before document persistence", reason => {
    const environment = setup();
    const spies = instrument(environment);
    const original = environment.index.writeDocument.bind(environment.index);
    spies.document.mockImplementationOnce((...args) => {
      if (reason === "stale") publishSource(environment, "replacement", environment.source.source_id,
        { source_version: "v2", recorded_at: "2026-09-22T00:00:00Z" });
      else environment.lifecycle.select(WORKSPACE, configuration({ model_revision: "v2" }));
      return original(...args);
    });
    expect(prepare(environment, { work: 17, native_bytes: 65536 })).toEqual({ status: reason, reason,
      resources: { work: 11, native_bytes: environment.readBytes } });
    expectNativeCalls(spies, 1, 1, 1);
    expect(spies.document.mock.results[0]!.value).toEqual({ status: "rejected", reason,
      resources: { work: 0, native_bytes: 0 } });
    expect(spies.lexical).not.toHaveBeenCalled();
    expectNoPayloads(environment);
  });

  it.each(["work", "native_bytes"] as const)("rejects invalid %s budgets before native reads", key => {
    const environment = setup();
    const spies = instrument(environment);
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => prepare(environment, { work: 1000, native_bytes: 65536, [key]: value }))
        .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED", message: "invalid source index budget" }));
    }
    expectNativeCalls(spies, 0, 0, 0);
    expect(spies.document).not.toHaveBeenCalled();
    expect(spies.lexical).not.toHaveBeenCalled();
    expectNoPayloads(environment);
  });

  it("rolls back lexical and window writes on a SQLite error and performs a fresh successful retry", () => {
    const environment = setup();
    const spies = instrument(environment);
    environment.database.connection.exec(`CREATE TRIGGER refuse_source_window BEFORE INSERT ON source_index_windows
      BEGIN SELECT RAISE(ABORT, 'window storage unavailable'); END`);
    expect(() => prepare(environment, { work: 17, native_bytes: 65536 })).toThrow(/window storage unavailable/u);
    expectNativeCalls(spies, 2, 1, 2);
    expectNoPayloads(environment);
    environment.database.connection.exec("DROP TRIGGER refuse_source_window");
    vi.clearAllMocks();
    expect(prepare(environment, { work: 17, native_bytes: 65536 })).toMatchObject({ status: "ready",
      resources: { work: 17, native_bytes: environment.readBytes + environment.guardBytes } });
    expectNativeCalls(spies, 2, 1, 2);
    expect(lexicalRows(environment.database)).toHaveLength(1);
    expect(environment.database.connection.prepare("SELECT window_id FROM source_index_windows").all()).toHaveLength(2);
  });
});
