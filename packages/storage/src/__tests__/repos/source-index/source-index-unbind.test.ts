import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SourceIndexLifecycle } from "../../../../../core/src/source-index/source-index-lifecycle.js";
import { initDatabase } from "../../../sqlite/db.js";
import { SqliteSourceIndexRepository } from "../../../repos/source-index/source-index-repo.js";
import { SqliteFieldSourceRecordRepo } from "../../../repos/field/source-repo.js";
import { BUDGET, WORKSPACE, buildReady, captureDocuments, configuration, fieldSha256, fixture, publishSource, vectorFor, writeVectors } from "./source-index-fixture.js";

it("atomically unbinds without build failure, fences old work and recovers after file reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "source-index-unbind-"));
  const filename = join(directory, "index.sqlite");
  const environment = fixture(filename);
  let database = environment.database;
  try {
    publishSource(environment, "source body");
    const { generation: old, documents: oldDocuments } = buildReady(environment);
    const lifecycle = new SourceIndexLifecycle(environment.index, fieldSha256);
    lifecycle.unbind(WORKSPACE);
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "unbound", active_generation_id: null,
      selection: { selection_revision: old.selection.selection_revision + 1, profile_id: old.selection.profile_id } });
    expect(environment.index.generation(WORKSPACE, old.generation_id)).toMatchObject({ status: "retired", reason: "configuration_unbound" });
    expect(lifecycle.publish(WORKSPACE, old.generation_id)).toEqual({ status: "rejected", reason: "superseded" });
    expect(lifecycle.acceptVector(WORKSPACE, old.generation_id, vectorFor(oldDocuments[0]!.windows[0]!)))
      .toEqual({ status: "rejected", reason: "superseded" });
    expect(() => lifecycle.begin(old.selection)).toThrow(/superseded/);
    expect(environment.index.readVectorCandidates(WORKSPACE, null, 1, { work_units: 100_000, memory_bytes: 1_000_000 }))
      .toMatchObject({ state: { status: "unbound" }, candidates: [] });
    database.close({ optimize: false });
    database = initDatabase({ filename });
    const index = new SqliteSourceIndexRepository(database, fieldSha256);
    const next = { ...environment, database, index, records: new SqliteFieldSourceRecordRepo(database, fieldSha256) };
    expect(index.state(WORKSPACE).status).toBe("unbound");
    const selected = index.select(WORKSPACE, configuration());
    expect(selected.selection_revision).toBe(old.selection.selection_revision + 1);
    const fresh = index.begin(selected);
    expect(fresh.generation_id).not.toBe(old.generation_id);
    const documents = captureDocuments(next, fresh);
    writeVectors(next, fresh, documents);
    expect(index.activate(WORKSPACE, fresh.generation_id)).toEqual({ status: "accepted" });
    expect(index.state(WORKSPACE).status).toBe("ready");
    expect(index.generation(WORKSPACE, old.generation_id)?.status).toBe("retired");
    // Genuine build failure remains distinguishable from unavailable configuration.
    index.fail(WORKSPACE, fresh.generation_id, "fixture_build_failed");
    expect(index.state(WORKSPACE).status).toBe("failed");
    expect(index.capturePage(WORKSPACE, old.generation_id, 1, BUDGET).generation.status).toBe("retired");
  } finally {
    if (!database.isClosed()) database.close({ optimize: false });
    rmSync(directory, { recursive: true, force: true });
  }
});

it("unbind fences a captured selection even before its generation begins", () => {
  const environment = fixture();
  try {
    const lifecycle = new SourceIndexLifecycle(environment.index, fieldSha256);
    const selected = lifecycle.select(WORKSPACE, configuration());
    lifecycle.unbind(WORKSPACE);
    expect(() => lifecycle.begin(selected)).toThrow(/superseded/);
    expect(environment.index.state(WORKSPACE)).toMatchObject({ status: "unbound", active_generation_id: null });
    expect(environment.index.state("workspace-2")).toEqual({ status: "unknown" });
    lifecycle.unbind("workspace-2");
    expect(environment.index.state("workspace-2")).toEqual({ status: "unknown" });
  } finally { environment.database.close({ optimize: false }); }
});
