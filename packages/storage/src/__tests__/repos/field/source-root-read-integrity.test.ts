import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceHealthState, sourceRecallTarget } from "@do-soul/alaya-protocol";
import { StorageDatabase, initDatabase } from "../../../sqlite/db.js";
import { SqliteEvidenceCapsuleRepo } from "../../../repos/capsules/evidence-capsule-repo.js";
import { SqliteFieldSourceRecordRepo } from "../../../repos/field/source-repo.js";
import { SqliteSourceRootRecallReader } from "../../../repos/field/bounded-source-root-reader.js";
import { SqliteIndexedRecallProjection, prepareIndexedRecallProjection } from "../../../repos/garden/indexed-recall-projection.js";
import { fieldSha256, hashedRecord, openFieldDatabase, seedWorkspaces } from "./field-contract-fixture.js";

const databases: StorageDatabase[] = [];
const directories: string[] = [];
afterEach(() => { databases.forEach((database) => database.close()); databases.length = 0;
  directories.forEach((directory) => rmSync(directory, { force: true, recursive: true })); directories.length = 0; });

function setup(database = openFieldDatabase()) {
  databases.push(database);
  const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
  const capsules = new SqliteEvidenceCapsuleRepo(database);
  return { database, records, capsules, reader: new SqliteSourceRootRecallReader(records, capsules) };
}

async function createCapsule(capsules: SqliteEvidenceCapsuleRepo, body: string) {
  return capsules.create({ object_id: "99999999-9999-4999-8999-999999999999", object_kind: "evidence_capsule", schema_version: 1,
    lifecycle_state: "active", created_at: "2026-08-16T00:00:00.000Z", updated_at: "2026-08-16T00:00:00.000Z", created_by: "user_action",
    evidence_kind: "conversation_excerpt", semantic_anchor: { topic: "source", keywords: ["source"], summary: "source" },
    event_anchor: null, physical_anchor: null, evidence_health_state: EvidenceHealthState.VERIFIED, gist: "gist", excerpt: body,
    source_hash: `sha256:${"a".repeat(64)}`, run_id: "run-1", workspace_id: "workspace-1", surface_id: null });
}

describe("retained source read identity", () => {
  it("pins retained text digest separately from the original source hash across restart and read-only reads", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-source-read-"));
    directories.push(directory);
    const path = join(directory, "source.sqlite");
    const database = initDatabase({ filename: path });
    seedWorkspaces(database);
    const initial = setup(database);
    const capsule = await createCapsule(initial.capsules, "😀 retained text");
    database.close();
    const readonly = setup(new StorageDatabase(path, new BetterSqlite3(path, { readonly: true, fileMustExist: true })));
    readonly.database.connection.pragma("query_only = ON");
    const page = readonly.reader.page({ workspaceId: "workspace-1", limit: 1, nativeLimit: 1, afterCursor: "c:", byteLimit: 7, nativeByteLimit: 16384 });
    expect(page.bytesRead).toBe(Buffer.byteLength("😀 retained text", "utf8"));
    const row = page.rows[0]!;
    expect(row.content).toBe("😀 re");
    expect(row.digest).toBe(`sha256:${createHash("sha256").update("😀 retained text", "utf8").digest("hex")}`);
    expect(row.digest).not.toBe(capsule.source_hash);
    expect(readonly.capsules.getById(capsule.object_id)?.source_hash).toBe(capsule.source_hash);
  });

  it("invalidates changed retained text without read-side repair or borrowed digest", async () => {
    const { database, capsules, reader } = setup();
    const projection = new SqliteIndexedRecallProjection(database.connection);
    prepareIndexedRecallProjection(database);
    const capsule = await createCapsule(capsules, "before");
    const before = projection.observablePin("workspace-1");
    database.connection.prepare("UPDATE evidence_capsules SET excerpt = ? WHERE object_id = ?").run("after", capsule.object_id);
    expect(projection.observablePin("workspace-1").source_revision).not.toBe(before.source_revision);
    database.connection.pragma("query_only = ON");
    const page = reader.page({ workspaceId: "workspace-1", limit: 1, nativeLimit: 1, afterCursor: "c:", byteLimit: 8, nativeByteLimit: 16384 });
    expect(page.unavailable).toBe(true);
    expect(page.rows).toEqual([]);
    expect(page.bytesRead).toBe(0);
  });

  it("keeps the original record when a previously valid capsule alias is revoked", async () => {
    const { database, records, capsules, reader } = setup();
    const capsule = await createCapsule(capsules, "retained");
    const record = records.insert({ ...hashedRecord("workspace-1", "original"), evidence_object_id: capsule.object_id });
    database.connection.prepare("UPDATE evidence_capsules SET lifecycle_state = 'archived' WHERE object_id = ?").run(capsule.object_id);
    const page = reader.page({ workspaceId: "workspace-1", limit: 1, nativeLimit: 1, afterCursor: null, byteLimit: 32, nativeByteLimit: 16384 });
    expect(page.rows[0]).toMatchObject({ root_id: record.record_id, content: "original", evidence_object_id: null });
    expect(page.rows[0]?.evidence_verified).toBeUndefined();
  });

  it("does not exceed a tiny native or delivered UTF-8 byte allowance", () => {
    const { records, reader } = setup();
    const record = records.insert(hashedRecord("workspace-1", "😀"));
    const target = sourceRecallTarget({ workspace_id: "workspace-1", root_kind: "source_record", root_id: record.record_id,
      source_version: record.source_version, content_digest: record.content_digest, evidence_object_id: null });
    const small = reader.hydrate("workspace-1", target, 1);
    expect(small.bytesRead).toBe(0);
    expect(small.rowsRead).toBe(0);
    expect(small.row).toBeNull();
    expect(small.resourceLimited).toBe(true);
    const clipped = reader.hydrate("workspace-1", target, 1, 0, 16384);
    expect(clipped.bytesRead).toBe(4);
    expect(clipped.row?.content).toBe("");
    expect(reader.hydrate("workspace-1", target, 4, 0, 16384).row?.content).toBe("😀");
  });
});
