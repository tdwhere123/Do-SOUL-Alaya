import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SourceIndexOperationError } from "@do-soul/alaya-protocol";
import {
  BUDGET, WORKSPACE, captureDocuments, configuration, fixture, publishSource, vectorFor, type Fixture
} from "./source-index-fixture.js";

const environments: Fixture[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const environment of environments.splice(0)) environment.database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function setup(body = "abcdefghijklmno", fileBacked = false) {
  const directory = fileBacked ? mkdtempSync(join(tmpdir(), "source-pending-")) : undefined;
  if (directory !== undefined) directories.push(directory);
  const environment = fixture(directory === undefined ? undefined : join(directory, "index.sqlite"));
  environments.push(environment);
  publishSource(environment, body);
  const selection = environment.index.select(WORKSPACE, configuration({ window_bytes: 4 }));
  const generation = environment.index.begin(selection);
  const [document] = captureDocuments(environment, generation);
  if (document === undefined) throw new Error("expected prepared SQLite document");
  const pending = (limit = 128, budget = BUDGET) => environment.index.pendingWindows(
    WORKSPACE, generation.generation_id, document.source.root_key, limit, budget);
  return { ...environment, selection, generation, document, pending };
}

describe("Source pending-window SQLite anti-join", () => {
  it("rejects a zero page limit rather than claiming an empty pending set", () => {
    const environment = setup();
    expect(() => environment.pending(0)).toThrow(/page limit/u);
    expect(environment.pending(1)).toEqual({ status: "ready", ordinals: [0], resources: { work: 1, native_bytes: 8 } });
  });

  it.each([
    ["zero work", { work: 0, native_bytes: 32 }],
    ["zero bytes", { work: 4, native_bytes: 0 }],
    ["less than one ordinal", { work: 4, native_bytes: 7 }]
  ] as const)("preserves %s as a read-budget refusal, not valid empty", (_label, budget) => {
    const environment = setup();
    expect(environment.pending(4, budget)).toEqual({ status: "partial", reason: "read_budget",
      resources: { work: 0, native_bytes: 0 } });
    expect(environment.pending()).toEqual({ status: "ready", ordinals: [0, 1, 2, 3],
      resources: { work: 4, native_bytes: 32 } });
  });

  it.each([
    [1, { work: 4, native_bytes: 32 }, [0]],
    [4, { work: 1, native_bytes: 32 }, [0]],
    [4, { work: 4, native_bytes: 8 }, [0]],
    [4, { work: 4, native_bytes: 15 }, [0]],
    [4, { work: 4, native_bytes: 16 }, [0, 1]],
    [3, { work: 4, native_bytes: 32 }, [0, 1, 2]]
  ])("bounds hydrated rows at page/work/byte edges (%s, %j)", (limit, budget, ordinals) => {
    const environment = setup();
    expect(environment.pending(limit, budget)).toEqual({ status: "ready", ordinals,
      resources: { work: ordinals.length, native_bytes: 8 * ordinals.length } });
    // Lookup is read-only: repeated pages cannot act as a caller-owned resume cursor.
    expect(environment.pending(limit, budget)).toEqual({ status: "ready", ordinals,
      resources: { work: ordinals.length, native_bytes: 8 * ordinals.length } });
    expect(environment.database.connection.prepare("SELECT window_id FROM source_index_vectors").all()).toEqual([]);
  });

  it("returns valid empty for an empty prepared root with a nonzero lookup cost", () => {
    const environment = setup("");
    expect(environment.pending(1, { work: 1, native_bytes: 8 })).toEqual({ status: "ready", ordinals: [],
      resources: { work: 1, native_bytes: 0 } });
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "building", active_generation_id: null });
  });

  it("cannot skip the first unfinished window, retains idempotent accepts and resumes after database reopen", () => {
    const environment = setup("abcdefghijklmno", true);
    const { index, generation, document, database } = environment;
    for (const ordinal of [3, 2]) {
      const vector = vectorFor(document.windows[ordinal]!);
      expect(index.writeVector(WORKSPACE, generation.generation_id, vector)).toEqual({ status: "accepted" });
      expect(index.writeVector(WORKSPACE, generation.generation_id, vector)).toEqual({ status: "accepted" });
    }
    expect(environment.pending(1)).toEqual({ status: "ready", ordinals: [0], resources: { work: 1, native_bytes: 8 } });
    expect(environment.pending(4)).toEqual({ status: "ready", ordinals: [0, 1], resources: { work: 2, native_bytes: 16 } });
    expect(index.writeDocument(WORKSPACE, generation.generation_id, document, BUDGET).status).toBe("accepted");
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM source_index_vectors").get()).toEqual({ count: 2 });
    const connectionVersion = database.getConnectionVersion();
    database.close();
    expect(environment.pending(4)).toEqual({ status: "ready", ordinals: [0, 1], resources: { work: 2, native_bytes: 16 } });
    expect(database.getConnectionVersion()).toBeGreaterThan(connectionVersion);
    expect(database.connection.inTransaction).toBe(false);
    expect(index.writeVector(WORKSPACE, generation.generation_id, vectorFor(document.windows[0]!))).toEqual({ status: "accepted" });
    expect(environment.pending(1)).toEqual({ status: "ready", ordinals: [1], resources: { work: 1, native_bytes: 8 } });
    expect(index.writeVector(WORKSPACE, generation.generation_id, vectorFor(document.windows[1]!))).toEqual({ status: "accepted" });
    expect(environment.pending()).toEqual({ status: "ready", ordinals: [], resources: { work: 1, native_bytes: 0 } });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM source_index_vectors").get()).toEqual({ count: 4 });
    expect(index.generation(WORKSPACE, generation.generation_id)).toMatchObject({ completed_count: 1, status: "building" });
    expect(index.state(WORKSPACE)).toMatchObject({ active_generation_id: null });
  });

  it("keeps missing generation, missing root, unprepared and failed manifests distinct", () => {
    const environment = setup();
    const { index, generation, document, database } = environment;
    expect(index.pendingWindows(WORKSPACE, "missing-generation", document.source.root_key, 1, BUDGET))
      .toEqual({ status: "unbound", reason: "missing_generation", resources: { work: 0, native_bytes: 0 } });
    expect(index.pendingWindows(WORKSPACE, generation.generation_id, "missing-root", 1, BUDGET))
      .toEqual({ status: "unbound", reason: "missing_target", resources: { work: 0, native_bytes: 0 } });
    expect(database.connection.prepare("UPDATE source_index_targets SET expected_windows=NULL WHERE generation_id=?")
      .run(generation.generation_id).changes).toBe(1);
    expect(environment.pending()).toEqual({ status: "partial", reason: "manifest_unprepared", resources: { work: 0, native_bytes: 0 } });
    index.fail(WORKSPACE, generation.generation_id, "interrupted");
    expect(environment.pending()).toEqual({ status: "partial", reason: "generation_failed", resources: { work: 0, native_bytes: 0 } });
  });

  it.each(["source update", "selection switch"] as const)("refuses %s instead of reporting successful absence", change => {
    const environment = setup();
    if (change === "source update") publishSource(environment, "replacement", "source-a", {
      source_version: "v2", recorded_at: "2026-09-22T00:00:00Z"
    });
    else environment.index.select(WORKSPACE, configuration({ model_revision: "v2" }));
    const status = change === "source update" ? "stale" : "superseded";
    expect(environment.pending()).toEqual({ status, reason: status, resources: { work: 0, native_bytes: 0 } });
  });

  it("rejects a caller-owned transaction and preserves its conflict cause and zero preflight costs", () => {
    const environment = setup();
    environment.database.connection.transaction(() => {
      expect(environment.database.connection.inTransaction).toBe(true);
      try {
        environment.pending();
        expect.unreachable("pending lookup must reject an open caller transaction");
      } catch (failure) {
        expect(failure).toBeInstanceOf(SourceIndexOperationError);
        if (!(failure instanceof SourceIndexOperationError)) throw failure;
        expect(failure.resources).toEqual({ work: 0, native_bytes: 0 });
        expect(failure.cause).toMatchObject({ code: "CONFLICT", message: "Source backfill requires a transaction-free caller" });
      }
    })();
    expect(environment.pending(1)).toEqual({ status: "ready", ordinals: [0], resources: { work: 1, native_bytes: 8 } });
  });
});
