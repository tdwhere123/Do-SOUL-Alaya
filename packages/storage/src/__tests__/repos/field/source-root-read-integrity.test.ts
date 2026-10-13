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
import { SqliteSourceRootRecallReader, encodeRecordCursor, encodeCapsuleCursor } from "../../../repos/field/bounded-source-root-reader.js";
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
  it("rejects malformed native and nested progress without skipping planted records, while accepting issued legacy cursors", async () => {
    const { records, capsules, reader } = setup();
    const planted = [records.insert(hashedRecord("workspace-1", "first retained body")),
      records.insert(hashedRecord("workspace-1", "second retained body"))].sort((a, b) => a.record_id.localeCompare(b.record_id));
    const input = { workspaceId: "workspace-1", limit: 8, nativeLimit: 8, afterCursor: null, nativeByteLimit: 16384 };
    expect(reader.page(input).rows.map(row => row.root_id)).toEqual(planted.map(row => row.record_id));
    const invalidNative = ["c:bad", "r:bad", "c:\tmissing-time", "r:bad-time\tid", "r:2026-08-16T00:00:00.000Z\t",
      "c:2026-08-16T00:00:00.000Z\tid\textra", "r:2026-08-16T00:00:00.000Z\tid\nforeign"];
    const invalidNested = invalidNative.flatMap(cursor => [
      `f:${JSON.stringify({ recordsAfter: cursor, capsulesAfter: null, recordsDone: true, capsulesDone: true })}`,
      `f:${JSON.stringify({ recordsAfter: null, capsulesAfter: cursor, recordsDone: true, capsulesDone: true })}`,
      `f:11\n${cursor}\n`
    ]);
    for (const afterCursor of [...invalidNative, ...invalidNested]) {
      expect(() => reader.page({ ...input, afterCursor }), afterCursor).toThrow(/cursor/i);
    }
    const recordCursor = encodeRecordCursor({ afterRecordedAt: planted[0]!.recorded_at, afterRecordId: planted[0]!.record_id });
    for (const afterCursor of [recordCursor, `f:00\n${recordCursor}\n`,
      `f:${JSON.stringify({ recordsAfter: recordCursor, capsulesAfter: null, recordsDone: false, capsulesDone: false })}`]) {
      expect(reader.page({ ...input, afterCursor }).rows.map(row => row.root_id)).toEqual([planted[1]!.record_id]);
    }
    const capsule = await createCapsule(capsules, "capsule body");
    const capsuleCursor = encodeCapsuleCursor({ afterCreatedAt: capsule.created_at, afterObjectId: capsule.object_id });
    for (const afterCursor of [capsuleCursor, `f:10\n${recordCursor}\n${capsuleCursor}`]) {
      expect(reader.page({ ...input, afterCursor })).toMatchObject({ rows: [], truncated: false, unavailable: false });
    }
  });
  it("checks reported spans against retained source bytes", () => {
    const { records, reader } = setup();
    const record = records.insert(hashedRecord("workspace-1", "retained source"));
    const target = sourceRecallTarget({ workspace_id: "workspace-1", root_kind: "source_record", root_id: record.record_id,
      source_version: record.source_version, content_digest: record.content_digest, evidence_object_id: null });
    const span = { content_start: 0, content_end: 8, retained_extent: "body" as const,
      content_complete: false, original_complete: false };
    expect(reader.isCurrentTarget("workspace-1", { ...target, span })).toBe(true);
    expect(reader.isCurrentTarget("workspace-1", { ...target, span: { ...span, content_end: 999 } })).toBe(false);
  });

  it("rejects malformed progress and retains a corrupt family's cursor on repeated reads", async () => {
    const { database, capsules, reader } = setup();
    const capsule = await createCapsule(capsules, "before");
    const input = { workspaceId: "workspace-1", limit: 8, nativeLimit: 8, afterCursor: null, nativeByteLimit: 16384 };
    for (const afterCursor of ["f:bad", "o:bad", "unknown"]) {
      expect(() => reader.page({ ...input, afterCursor })).toThrow(/cursor/);
    }
    database.connection.prepare("UPDATE evidence_capsules SET excerpt = ? WHERE object_id = ?").run("after", capsule.object_id);
    const first = reader.page(input);
    expect(first.unavailable).toBe(true);
    expect(first.truncated).toBe(true);
    const repeated = reader.page({ ...input, afterCursor: first.committedThrough });
    expect(repeated.unavailable).toBe(true);
    expect(repeated.truncated).toBe(true);
    expect(repeated.committedThrough).toBe(first.committedThrough);
  });
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
    const page = readonly.reader.page({ workspaceId: "workspace-1", limit: 1, nativeLimit: 1,
      afterCursor: 'f:{"recordsAfter":null,"capsulesAfter":null,"recordsDone":true,"capsulesDone":false}',
      byteLimit: 7, nativeByteLimit: 16384 });
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
    const page = reader.page({ workspaceId: "workspace-1", limit: 1, nativeLimit: 1,
      afterCursor: 'f:{"recordsAfter":null,"capsulesAfter":null,"recordsDone":true,"capsulesDone":false}',
      byteLimit: 8, nativeByteLimit: 16384 });
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
