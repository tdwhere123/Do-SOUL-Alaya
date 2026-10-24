import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceIndexOperationError } from "@do-soul/alaya-protocol";
import { SourceIndexLifecycle } from "../../source-index/source-index-lifecycle.js";
import {
  BUDGET, WORKSPACE, configuration, fieldPointer, fieldSha256, fixture, lexicalRows,
  publishSource, vectorFor, type Fixture
} from "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";

const environments: Fixture[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const environment of environments.splice(0)) environment.database.close();
});
function setup(config = configuration()) {
  const environment = fixture();
  environments.push(environment);
  const lifecycle = new SourceIndexLifecycle(environment.index, fieldSha256);
  const selection = lifecycle.select(WORKSPACE, config);
  return { ...environment, lifecycle, selection };
}
const digest = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

// Adapter-only addition proof: supplied read/write counters are not native accounting evidence.
const preparationRejections = [
  ["incomplete", "partial"], ["superseded", "superseded"], ["stale", "stale"],
  ["missing_target", "unbound"], ["missing_generation", "unbound"],
  ["read_budget", "partial"], ["native_source_unavailable", "partial"]
] as const;
for (const phase of ["lexical", "document"] as const) describe(`${phase} preparation rejection adapter`, () => {
  it.each(preparationRejections)("preserves %s as %s and adds supplied nonzero write resources", (reason, status) => {
    const environment = setup(configuration({ window_bytes: 4 }));
    const body = phase === "lexical" ? "full".repeat(4097) : "adapter body";
    publishSource(environment, body);
    const generation = environment.lifecycle.begin(environment.selection);
    environment.lifecycle.capture(WORKSPACE, generation.generation_id, 8, BUDGET);
    const [source] = environment.index.listTargets(WORKSPACE, generation.generation_id, null, 8);
    const read = environment.index.readDocument(WORKSPACE, generation.generation_id, source!.root_key, body.length, BUDGET);
    if (read.status !== "ready") throw new Error("expected native adapter input");
    const resources = { work: 17, native_bytes: 321 };
    vi.spyOn(environment.index, "readDocument").mockReturnValue({ ...read, resources });
    const lexical = vi.spyOn(environment.index, "writeLexical");
    const document = vi.spyOn(environment.index, "writeDocument");
    const refusal = { status: "rejected" as const, reason, resources: { work: 3, native_bytes: 29 } };
    if (phase === "lexical") lexical.mockReturnValue(refusal);
    else document.mockReturnValue(refusal);
    expect(environment.lifecycle.prepare(WORKSPACE, generation.generation_id, source!.root_key, BUDGET))
      .toEqual({ status, reason, resources: { work: 20, native_bytes: 350 } });
    const remaining = { work: BUDGET.work - 17, native_bytes: BUDGET.native_bytes - 321 };
    if (phase === "lexical") {
      expect(lexical).toHaveBeenCalledExactlyOnceWith(read.source, body, remaining);
      expect(document).not.toHaveBeenCalled();
    } else {
      expect(lexical).not.toHaveBeenCalled();
      expect(document).toHaveBeenCalledExactlyOnceWith(WORKSPACE, generation.generation_id,
        expect.objectContaining({ source: read.source, body }), remaining);
    }
    expect(environment.database.connection.prepare("SELECT window_id FROM source_index_windows").all()).toEqual([]);
    expect(environment.index.generation(WORKSPACE, generation.generation_id)).toMatchObject({ completed_count: 0 });
  });
});

describe("preparation read failures and generation disappearance", () => {
  it("returns unbound/missing_generation without writes when the generation disappears after a successful read", () => {
    const environment = setup();
    publishSource(environment, "disappearing generation");
    const generation = environment.lifecycle.begin(environment.selection);
    environment.lifecycle.capture(WORKSPACE, generation.generation_id, 8, BUDGET);
    const [source] = environment.index.listTargets(WORKSPACE, generation.generation_id, null, 8);
    const original = environment.index.readDocument.bind(environment.index);
    const read = vi.spyOn(environment.index, "readDocument").mockImplementation((...args) => {
      const result = original(...args);
      expect(result.status).toBe("ready");
      // Real SQLite loss between the read and Core's generation lookup, not a cached null stub.
      expect(environment.database.connection.prepare("DELETE FROM source_index_generations WHERE workspace_id=? AND generation_id=?")
        .run(WORKSPACE, generation.generation_id).changes).toBe(1);
      return result;
    });
    const lexical = vi.spyOn(environment.index, "writeLexical");
    const document = vi.spyOn(environment.index, "writeDocument");
    const result = environment.lifecycle.prepare(WORKSPACE, generation.generation_id, source!.root_key, BUDGET);
    expect(result).toEqual({ status: "unbound", reason: "missing_generation", resources: read.mock.results[0]!.value.resources });
    expect(result.resources.work).toBeGreaterThan(0);
    expect(lexical).not.toHaveBeenCalled();
    expect(document).not.toHaveBeenCalled();
    expect(lexicalRows(environment.database)).toEqual([]);
    expect(environment.database.connection.prepare("SELECT window_id FROM source_index_windows").all()).toEqual([]);
  });

  it("propagates a read exception and retries instead of caching successful absence", () => {
    const environment = setup();
    publishSource(environment, "retry actual bytes");
    const generation = environment.lifecycle.begin(environment.selection);
    environment.lifecycle.capture(WORKSPACE, generation.generation_id, 8, BUDGET);
    const [source] = environment.index.listTargets(WORKSPACE, generation.generation_id, null, 8);
    const error = new Error("injected read failure");
    const read = vi.spyOn(environment.index, "readDocument").mockImplementationOnce(() => { throw error; });
    const lexical = vi.spyOn(environment.index, "writeLexical");
    const document = vi.spyOn(environment.index, "writeDocument");
    try {
      environment.lifecycle.prepare(WORKSPACE, generation.generation_id, source!.root_key, BUDGET);
      expect.unreachable("expected preparation to retain the read failure");
    } catch (failure) {
      expect(failure).toBeInstanceOf(SourceIndexOperationError);
      if (!(failure instanceof SourceIndexOperationError)) throw failure;
      expect(failure.resources).toEqual({ work: 0, native_bytes: 0 });
      expect(failure.cause).toBe(error);
    }
    expect(lexical).not.toHaveBeenCalled();
    expect(document).not.toHaveBeenCalled();
    expect(environment.lifecycle.prepare(WORKSPACE, generation.generation_id, source!.root_key, BUDGET))
      .toMatchObject({ status: "ready", document: { body: "retry actual bytes" } });
    expect(read).toHaveBeenCalledTimes(2);
    expect(lexicalRows(environment.database)).toEqual([{ root_key: source!.root_key, body: "retry actual bytes", body_bytes: 18 }]);
  });
});

describe("Source index lifecycle through migrated SQLite and native Source publication", () => {
  it("retains exact full lexical bytes and a complete UTF-8 manifest before guarded vector publication, without changing Field", () => {
    const environment = setup();
    const source = publishSource(environment, "Alpha猫\nβeta!");
    const field = fieldPointer(environment.database);
    const generation = environment.lifecycle.begin(environment.selection);
    expect(environment.lifecycle.capture(WORKSPACE, generation.generation_id, 8, BUDGET).generation)
      .toMatchObject({ enumeration_complete: true, target_count: 1, completed_count: 0 });
    const targets = environment.index.listTargets(WORKSPACE, generation.generation_id, null, 8);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ source_id: source.source_id, body_bytes: 15,
      target: { root_id: source.record_id, content_digest: digest("Alpha猫\nβeta!") } });
    const prepared = environment.lifecycle.prepare(WORKSPACE, generation.generation_id, targets[0]!.root_key, BUDGET);
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("expected complete Source document");
    expect(prepared.document.body).toBe("Alpha猫\nβeta!");
    const expectedWindows = [
      { ordinal: 0, start_byte: 0, end_byte: 8, text: "Alpha猫", content_digest: digest("Alpha猫") },
      { ordinal: 1, start_byte: 8, end_byte: 15, text: "\nβeta!", content_digest: digest("\nβeta!") }
    ];
    expect(prepared.document.windows.map(({ ordinal, start_byte, end_byte, text, content_digest }) =>
      ({ ordinal, start_byte, end_byte, text, content_digest }))).toEqual(expectedWindows);
    expect(environment.database.connection.prepare(`SELECT ordinal,start_byte,end_byte,body AS text,content_digest
      FROM source_index_windows WHERE workspace_id=? AND generation_id=? ORDER BY ordinal`)
      .all(WORKSPACE, generation.generation_id)).toEqual(expectedWindows);
    expect(new Set(prepared.document.windows.map(window => window.window_id)).size).toBe(2);
    expect(lexicalRows(environment.database)).toEqual([
      { root_key: targets[0]!.root_key, body: "Alpha猫\nβeta!", body_bytes: 15 }
    ]);
    expect(environment.lifecycle.publish(WORKSPACE, generation.generation_id))
      .toEqual({ status: "rejected", reason: "incomplete" });
    expect(() => environment.lifecycle.acceptVector(WORKSPACE, generation.generation_id,
      { ...vectorFor(prepared.document.windows[0]!), embedding: new Float32Array([1, 0]) }))
      .toThrow(/compatible complete window input/u);
    expect(environment.lifecycle.acceptVector(WORKSPACE, generation.generation_id, vectorFor(prepared.document.windows[0]!)))
      .toEqual({ status: "accepted" });
    expect(environment.lifecycle.publish(WORKSPACE, generation.generation_id))
      .toEqual({ status: "rejected", reason: "incomplete" });
    expect(environment.lifecycle.acceptVector(WORKSPACE, generation.generation_id, vectorFor(prepared.document.windows[1]!)))
      .toEqual({ status: "accepted" });
    expect(environment.lifecycle.publish(WORKSPACE, generation.generation_id)).toEqual({ status: "accepted" });
    expect(environment.index.generation(WORKSPACE, generation.generation_id)).toMatchObject({
      status: "ready", enumeration_complete: true, target_count: 1, completed_count: 1, reason: null
    });
    expect(environment.index.state(WORKSPACE)).toEqual({ status: "ready", selection: environment.selection,
      active_generation_id: generation.generation_id });
    expect(environment.database.connection.prepare(`SELECT workspace_id,active_generation_id,activated_at
      FROM projection_generation_pointer WHERE workspace_id=?`).get(WORKSPACE)).toEqual(field.pointer);
    expect(field.repository.readActive(WORKSPACE)).toMatchObject({ generation_id: field.generation.generation_id, status: "active" });
    expect(environment.database.connection.prepare(`SELECT dimensions,embedding_blob,token_count FROM source_index_vectors
      WHERE workspace_id=? AND generation_id=?`).all(WORKSPACE, generation.generation_id)).toEqual([
      { dimensions: 3, token_count: 2, embedding_blob: Buffer.from([154, 153, 25, 63, 205, 204, 76, 63, 0, 0, 0, 0]) },
      { dimensions: 3, token_count: 2, embedding_blob: Buffer.from([154, 153, 25, 63, 205, 204, 76, 63, 0, 0, 0, 0]) }
    ]);
  });

  it("does not activate captured membership without its window manifest", () => {
    const environment = setup();
    publishSource(environment, "retained text");
    const generation = environment.lifecycle.begin(environment.selection);
    environment.lifecycle.capture(WORKSPACE, generation.generation_id, 8, BUDGET);
    expect(environment.index.generation(WORKSPACE, generation.generation_id)).toMatchObject({
      enumeration_complete: true, target_count: 1, completed_count: 0
    });
    expect(environment.lifecycle.publish(WORKSPACE, generation.generation_id)).toEqual({ status: "rejected", reason: "incomplete" });
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "building", active_generation_id: null });
  });

  it("does not interpret a fully prepared page as completed enumeration", () => {
    const environment = setup();
    publishSource(environment, "one page");
    const generation = environment.lifecycle.begin(environment.selection);
    expect(environment.lifecycle.capture(WORKSPACE, generation.generation_id, 1, BUDGET).generation)
      .toMatchObject({ status: "partial", enumeration_complete: false, reason: "enumeration_page" });
    const [source] = environment.index.listTargets(WORKSPACE, generation.generation_id, null, 8);
    const prepared = environment.lifecycle.prepare(WORKSPACE, generation.generation_id, source!.root_key, BUDGET);
    if (prepared.status !== "ready") throw new Error("expected prepared page");
    for (const window of prepared.document.windows) environment.lifecycle.acceptVector(WORKSPACE, generation.generation_id, vectorFor(window));
    expect(environment.index.generation(WORKSPACE, generation.generation_id)).toMatchObject({ target_count: 1, completed_count: 1 });
    expect(environment.lifecycle.publish(WORKSPACE, generation.generation_id)).toEqual({ status: "rejected", reason: "incomplete" });
    expect(environment.index.state(WORKSPACE)).toMatchObject({ active_generation_id: null, status: "partial" });
    expect(environment.lifecycle.capture(WORKSPACE, generation.generation_id, 1, BUDGET).generation)
      .toMatchObject({ records_complete: true, enumeration_complete: false });
    expect(environment.lifecycle.publish(WORKSPACE, generation.generation_id)).toEqual({ status: "rejected", reason: "incomplete" });
    expect(environment.lifecycle.capture(WORKSPACE, generation.generation_id, 1, BUDGET).generation.enumeration_complete).toBe(true);
    expect(environment.lifecycle.publish(WORKSPACE, generation.generation_id)).toEqual({ status: "accepted" });
  });

  it("retains all lexical text on window-cap refusal without claiming document completion", () => {
    const environment = setup(configuration({ window_bytes: 4 }));
    const body = "full".repeat(4097);
    publishSource(environment, body);
    const generation = environment.lifecycle.begin(environment.selection);
    environment.lifecycle.capture(WORKSPACE, generation.generation_id, 8, BUDGET);
    const [source] = environment.index.listTargets(WORKSPACE, generation.generation_id, null, 8);
    expect(environment.lifecycle.prepare(WORKSPACE, generation.generation_id, source!.root_key, BUDGET))
      .toMatchObject({ status: "partial", reason: "window_capacity" });
    expect(lexicalRows(environment.database)).toEqual([{ root_key: source!.root_key, body, body_bytes: 16388 }]);
    expect(environment.database.connection.prepare("SELECT window_id FROM source_index_windows").all()).toEqual([]);
    expect(environment.index.generation(WORKSPACE, generation.generation_id)).toMatchObject({
      enumeration_complete: true, target_count: 1, completed_count: 0
    });
    expect(environment.lifecycle.publish(WORKSPACE, generation.generation_id)).toEqual({ status: "rejected", reason: "incomplete" });
    expect(environment.index.state(WORKSPACE)).toMatchObject({ active_generation_id: null });
  });

  it("marks interrupted work failed and refuses its outstanding vectors or publication", () => {
    const environment = setup();
    publishSource(environment, "interrupted");
    const generation = environment.lifecycle.begin(environment.selection);
    environment.lifecycle.capture(WORKSPACE, generation.generation_id, 8, BUDGET);
    const [source] = environment.index.listTargets(WORKSPACE, generation.generation_id, null, 8);
    const prepared = environment.lifecycle.prepare(WORKSPACE, generation.generation_id, source!.root_key, BUDGET);
    if (prepared.status !== "ready") throw new Error("expected prepared document");
    environment.lifecycle.fail(WORKSPACE, generation.generation_id, "worker_interrupted");
    expect(environment.index.generation(WORKSPACE, generation.generation_id)).toMatchObject({ status: "failed", reason: "worker_interrupted" });
    expect(environment.lifecycle.acceptVector(WORKSPACE, generation.generation_id, vectorFor(prepared.document.windows[0]!)))
      .toEqual({ status: "rejected", reason: "incomplete" });
    expect(environment.lifecycle.publish(WORKSPACE, generation.generation_id)).toEqual({ status: "rejected", reason: "incomplete" });
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "failed", active_generation_id: null });
  });
});
