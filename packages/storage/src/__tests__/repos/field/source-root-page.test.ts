import { afterEach, describe, expect, it } from "vitest";
import { EvidenceHealthState } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../sqlite/db.js";
import { SqliteEvidenceCapsuleRepo } from "../../../repos/capsules/evidence-capsule-repo.js";
import { SqliteFieldSourceRecordRepo } from "../../../repos/field/source-repo.js";
import {
  encodeContentCursor,
  SqliteSourceRootRecallReader
} from "../../../repos/field/bounded-source-root-reader.js";
import { fieldSha256, hashedRecord, openFieldDatabase } from "./field-contract-fixture.js";

const tracked = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
});

describe("bounded source-root pages", () => {
  it("pages capsule-only roots that have no source_records", async () => {
    const database = openFieldDatabase();
    tracked.add(database);
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const capsules = new SqliteEvidenceCapsuleRepo(database);
    const only = await capsules.create(capsule(
      "11111111-1111-4111-8111-111111111111",
      "workspace-1",
      "only gist"
    ));
    const linked = await capsules.create(capsule(
      "22222222-2222-4222-8222-222222222222",
      "workspace-1",
      "linked gist"
    ));
    records.insert({
      ...hashedRecord("workspace-1", "linked gist", "src-linked"),
      evidence_object_id: linked.object_id
    });

    const page = capsules.pageCapsuleOnlyRoots("workspace-1", { limit: 8 });
    expect(page.rows.map((row) => row.object_id)).toEqual([only.object_id]);
    expect(page.truncated).toBe(false);

    const reader = new SqliteSourceRootRecallReader(records, capsules);
    const roots = reader.page({
      workspaceId: "workspace-1",
      limit: 8,
      nativeLimit: 8,
      afterCursor: null
    });
    expect(roots.rows.some((row) => row.root_id === only.object_id && row.kind === "evidence_capsule")).toBe(true);
    expect(roots.rows.some((row) => row.root_id === linked.object_id && row.kind === "evidence_capsule")).toBe(false);
  });

  it("does not starve a capsule-only exact root behind a full record page", async () => {
    const database = openFieldDatabase();
    tracked.add(database);
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const capsules = new SqliteEvidenceCapsuleRepo(database);
    const needle = "CAPSULE_ONLY_NEEDLE";
    for (let index = 0; index < 24; index += 1) {
      records.insert(hashedRecord("workspace-1", `unrelated body ${index}`, `src-unrelated-${index}`));
    }
    const only = await capsules.create(capsule(
      "99999999-9999-4999-8999-999999999999",
      "workspace-1",
      needle
    ));
    const reader = new SqliteSourceRootRecallReader(records, capsules);
    const first = reader.page({
      workspaceId: "workspace-1",
      limit: 4,
      nativeLimit: 4,
      afterCursor: null
    });
    expect(first.rows.some((row) => row.kind === "source_record")).toBe(true);
    expect(first.rows.some((row) => (
      row.kind === "evidence_capsule" && row.root_id === only.object_id && row.content?.includes(needle)
    ))).toBe(true);
    expect(first.nativeVisits).toBeLessThan(24);
    expect(first.truncated).toBe(true);
    expect(first.committedThrough).not.toBeNull();
    const second = reader.page({
      workspaceId: "workspace-1",
      limit: 4,
      nativeLimit: 4,
      afterCursor: first.committedThrough
    });
    expect(second.rows.some((row) => row.kind === "source_record")).toBe(true);
    expect(second.rows.some((row) => row.root_id === only.object_id)).toBe(false);
  });

  it("hydrates oversized CJK at UTF-8 boundaries and rejects a broken offset", () => {
    const database = openFieldDatabase();
    tracked.add(database);
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const capsules = new SqliteEvidenceCapsuleRepo(database);
    const body = "汉".repeat(30_000);
    const row = records.insert(hashedRecord("workspace-1", body, "src-cjk"));
    const reader = new SqliteSourceRootRecallReader(records, capsules);
    const page = reader.hydrate("workspace-1", {
      kind: "source_evidence",
      workspace_id: "workspace-1",
      root_kind: "source_record",
      root_id: row.record_id,
      source_version: row.source_version,
      content_digest: row.content_digest,
      evidence_object_id: null
    }, 64, 0, 16384);
    expect(page.unavailable).toBe(false);
    expect(page.row?.content_complete).toBe(false);
    expect(page.row?.content_end).toBeGreaterThan(0);
    expect(Buffer.byteLength(page.row?.content ?? "", "utf8")).toBeLessThanOrEqual(64);
    expect(page.resourceLimited).toBe(true);

    const broken = reader.hydrate("workspace-1", {
      kind: "source_evidence",
      workspace_id: "workspace-1",
      root_kind: "source_record",
      root_id: row.record_id,
      source_version: row.source_version,
      content_digest: row.content_digest,
      evidence_object_id: null
    }, 64, 1, 16384);
    expect(broken.unavailable).toBe(true);
    expect(broken.row).toBeNull();
  });

  it("continues an oversized body from the content-offset cursor", () => {
    const database = openFieldDatabase();
    tracked.add(database);
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const capsules = new SqliteEvidenceCapsuleRepo(database);
    const needle = "NEEDLE_ONLY_AFTER_64K";
    const body = `${"a".repeat(65_536)}${needle}`;
    const row = records.insert(hashedRecord("workspace-1", body, "src-oversize"));
    const reader = new SqliteSourceRootRecallReader(records, capsules);
    const first = reader.page({
      workspaceId: "workspace-1",
      limit: 1,
      nativeLimit: 1,
      afterCursor: null,
      byteLimit: 65_536
    });
    const head = first.rows.find((candidate) => candidate.root_id === row.record_id);
    expect(head?.content_complete).toBe(false);
    expect(head?.content?.includes(needle)).toBe(false);
    let rest = head;
    while (rest !== undefined && !rest.content_complete) {
      const offset = rest.content_end;
      const continued = reader.page({
      workspaceId: "workspace-1",
      limit: 1,
      nativeLimit: 1,
      afterCursor: encodeContentCursor({
        kind: "source_record",
        rootId: row.record_id,
        offset
      }),
      byteLimit: 65_536
    });
      rest = continued.rows.find((candidate) => candidate.root_id === row.record_id);
      expect(rest?.content_start).toBe(offset);
      expect(rest?.content_end).toBeGreaterThan(offset);
      expect(continued.bytesRead).toBeLessThanOrEqual(4096);
    }
    expect(rest?.content).toContain(needle);
    expect(rest?.content_complete).toBe(true);
    expect(rest?.content_end).toBe(Buffer.byteLength(body, "utf8"));
  });

  it("maps persisted scope_class and leaves omitted scope unset", () => {
    const database = openFieldDatabase();
    tracked.add(database);
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const capsules = new SqliteEvidenceCapsuleRepo(database);
    const project = records.insert({
      ...hashedRecord("workspace-1", "project body", "src-project"),
      scope_class: "project"
    });
    const other = records.insert({
      ...hashedRecord("workspace-1", "global body", "src-global"),
      scope_class: "global_domain"
    });
    const omitted = records.insert(hashedRecord("workspace-1", "omitted body", "src-omitted"));
    const roots = new SqliteSourceRootRecallReader(records, capsules).page({
      workspaceId: "workspace-1",
      limit: 8,
      nativeLimit: 8,
      afterCursor: null
    });
    expect(roots.rows.find((row) => row.root_id === project.record_id)?.scope_class).toBe("project");
    expect(roots.rows.find((row) => row.root_id === other.record_id)?.scope_class).toBe("global_domain");
    expect(roots.rows.find((row) => row.root_id === omitted.record_id)?.scope_class).toBeUndefined();
  });

  it("projects retained speaker identity onto source-record roots", () => {
    const database = openFieldDatabase();
    tracked.add(database);
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const capsules = new SqliteEvidenceCapsuleRepo(database);
    const user = records.insert({
      ...hashedRecord("workspace-1", "user said hello", "alaya:garden-turn-evidence:user-turn"),
      speaker: "user"
    });
    const assistant = records.insert({
      ...hashedRecord("workspace-1", "assistant replied", "alaya:garden-turn-evidence:assistant-turn"),
      speaker: "assistant"
    });
    const lineage = records.insert(hashedRecord(
      "workspace-1",
      "lineage body",
      "alaya:garden-turn-evidence:sig"
    ));
    const userToken = records.insert(hashedRecord("workspace-1", "source_id is not speaker", "user"));
    const roots = new SqliteSourceRootRecallReader(records, capsules).page({
      workspaceId: "workspace-1",
      limit: 8,
      nativeLimit: 8,
      afterCursor: null
    });
    expect(roots.rows.find((candidate) => candidate.root_id === user.record_id)?.role).toBe("user");
    expect(roots.rows.find((candidate) => candidate.root_id === assistant.record_id)?.role).toBe("assistant");
    expect(roots.rows.find((candidate) => candidate.root_id === lineage.record_id)?.role).toBeUndefined();
    expect(roots.rows.find((candidate) => candidate.root_id === userToken.record_id)?.role).toBeUndefined();
  });

  it("marks a verified evidence bind and leaves record-only unverified", async () => {
    const database = openFieldDatabase();
    tracked.add(database);
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const capsules = new SqliteEvidenceCapsuleRepo(database);
    const boundCapsule = await capsules.create(capsule(
      "55555555-5555-4555-8555-555555555555",
      "workspace-1",
      "bound gist"
    ));
    const bound = records.insert({
      ...hashedRecord("workspace-1", "bound body", "src-bound-evidence"),
      evidence_object_id: boundCapsule.object_id
    });
    const recordOnly = records.insert(hashedRecord("workspace-1", "record only body", "src-record-only"));
    const reader = new SqliteSourceRootRecallReader(records, capsules);
    const roots = reader.page({
      workspaceId: "workspace-1",
      limit: 8,
      nativeLimit: 8,
      afterCursor: null
    });
    const boundRow = roots.rows.find((candidate) => candidate.root_id === bound.record_id);
    const recordOnlyRow = roots.rows.find((candidate) => candidate.root_id === recordOnly.record_id);
    expect(boundRow?.evidence_object_id).toBe(boundCapsule.object_id);
    expect(boundRow?.evidence_verified).toBe(true);
    expect(recordOnlyRow?.evidence_object_id).toBeNull();
    expect(recordOnlyRow?.evidence_verified).toBeUndefined();
  });

  it("pages and hydrates a large body through a byte-bounded prefix", () => {
    const database = openFieldDatabase();
    tracked.add(database);
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const capsules = new SqliteEvidenceCapsuleRepo(database);
    const body = "汉".repeat(30_000);
    const row = records.insert(hashedRecord("workspace-1", body, "src-bound"));
    expect(records.findById("workspace-1", row.record_id)?.source_body).toBe(body);
    const reader = new SqliteSourceRootRecallReader(records, capsules);
    const roots = reader.page({
      workspaceId: "workspace-1",
      limit: 8,
      nativeLimit: 8,
      afterCursor: null,
      byteLimit: 64,
      nativeByteLimit: 16384
    });
    const found = roots.rows.find((candidate) => candidate.root_id === row.record_id);
    expect(found?.original_complete).toBe(true);
    expect(found?.retained_extent).toBe("body");
    expect(found?.content_complete).toBe(false);
    expect(Buffer.byteLength(found?.content ?? "", "utf8")).toBeLessThanOrEqual(64);
    expect(roots.nativeBytes).toBeGreaterThan(0);
    expect(roots.nativeBytes).toBeLessThanOrEqual(4096);
    expect(roots.bytesRead).toBe(roots.nativeBytes);

    const page = reader.hydrate("workspace-1", {
      kind: "source_evidence",
      workspace_id: "workspace-1",
      root_kind: "source_record",
      root_id: row.record_id,
      source_version: row.source_version,
      content_digest: row.content_digest,
      evidence_object_id: null
    }, 64, 0, 16384);
    expect(page.unavailable).toBe(false);
    expect(page.resourceLimited).toBe(true);
    expect(page.row?.content_complete).toBe(false);
    expect(page.bytesRead).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(page.row?.content ?? "", "utf8")).toBeLessThanOrEqual(page.bytesRead);
    expect(Buffer.byteLength(page.row?.content ?? "", "utf8")).toBeLessThanOrEqual(64);
  });

  it("copies validity so an expired closed interval is distinct from an open one", () => {
    const database = openFieldDatabase();
    tracked.add(database);
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const capsules = new SqliteEvidenceCapsuleRepo(database);
    const expired = records.insert({
      ...hashedRecord("workspace-1", "expired body", "src-expired"),
      valid_from: "2025-01-01T00:00:00.000Z",
      valid_to: "2026-01-01T00:00:00.000Z"
    });
    const open = records.insert({
      ...hashedRecord("workspace-1", "open body", "src-open"),
      valid_from: "2025-01-01T00:00:00.000Z",
      valid_to: null
    });
    const roots = new SqliteSourceRootRecallReader(records, capsules).page({
      workspaceId: "workspace-1",
      limit: 8,
      nativeLimit: 8,
      afterCursor: null
    });
    const expiredRow = roots.rows.find((candidate) => candidate.root_id === expired.record_id);
    const openRow = roots.rows.find((candidate) => candidate.root_id === open.record_id);
    const asOf = "2026-09-09T00:00:00.000Z";
    expect(expiredRow?.valid_from).toBe("2025-01-01T00:00:00.000Z");
    expect(expiredRow?.valid_to).toBe("2026-01-01T00:00:00.000Z");
    expect(openRow?.valid_from).toBe("2025-01-01T00:00:00.000Z");
    expect(openRow?.valid_to).toBeNull();
    expect(expiredRow!.valid_to != null && expiredRow!.valid_to <= asOf).toBe(true);
    expect(openRow!.valid_to == null || openRow!.valid_to > asOf).toBe(true);
  });

  it("does not treat a populated excerpt as the complete original", async () => {
    const database = openFieldDatabase();
    tracked.add(database);
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const capsules = new SqliteEvidenceCapsuleRepo(database);
    const excerpt = "e".repeat(800);
    const stored = await capsules.create(capsule(
      "33333333-3333-4333-8333-333333333333",
      "workspace-1",
      excerpt
    ));
    const roots = new SqliteSourceRootRecallReader(records, capsules).page({
      workspaceId: "workspace-1",
      limit: 8,
      nativeLimit: 8,
      afterCursor: null
    });
    const found = roots.rows.find((candidate) => candidate.root_id === stored.object_id);
    expect(found?.retained_extent).toBe("excerpt");
    expect(found?.original_complete).toBe(false);
    expect(found?.content).toBe(excerpt);
    expect(roots.nativeBytes).toBe(Buffer.byteLength(excerpt, "utf8"));
    expect(roots.bytesRead).toBe(roots.nativeBytes);

    const gistOnly = await capsules.create({
      ...capsule(
        "44444444-4444-4444-8444-444444444444",
        "workspace-1",
        "gist only"
      ),
      excerpt: null
    });
    const gistPage = new SqliteSourceRootRecallReader(records, capsules).page({
      workspaceId: "workspace-1",
      limit: 8,
      nativeLimit: 8,
      afterCursor: null
    });
    const gistRow = gistPage.rows.find((candidate) => candidate.root_id === gistOnly.object_id);
    expect(gistRow?.retained_extent).toBe("gist");
    expect(gistRow?.original_complete).toBe(false);
  });

  it("marks a missing root unavailable rather than empty", () => {
    const database = openFieldDatabase();
    tracked.add(database);
    const reader = new SqliteSourceRootRecallReader(
      new SqliteFieldSourceRecordRepo(database, fieldSha256),
      new SqliteEvidenceCapsuleRepo(database)
    );
    const page = reader.hydrate("workspace-1", {
      kind: "source_evidence",
      workspace_id: "workspace-1",
      root_kind: "source_record",
      root_id: `sha256:${"a".repeat(64)}`,
      source_version: "v1",
      content_digest: `sha256:${"b".repeat(64)}`,
      evidence_object_id: null
    });
    expect(page.unavailable).toBe(true);
    expect(page.row).toBeNull();
  });
});

function capsule(objectId: string, workspaceId: string, gist: string) {
  return {
    object_id: objectId,
    object_kind: "evidence_capsule" as const,
    schema_version: 1 as const,
    lifecycle_state: "active" as const,
    created_at: "2026-08-16T00:00:00.000Z",
    updated_at: "2026-08-16T00:00:00.000Z",
    created_by: "user_action" as const,
    evidence_kind: "conversation_excerpt" as const,
    semantic_anchor: { topic: "source", keywords: ["source"], summary: gist },
    event_anchor: null,
    physical_anchor: null,
    evidence_health_state: EvidenceHealthState.VERIFIED,
    gist,
    excerpt: gist,
    source_hash: null,
    run_id: "run-1",
    workspace_id: workspaceId,
    surface_id: null
  };
}
