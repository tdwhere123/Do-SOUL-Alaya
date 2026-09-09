import { afterEach, describe, expect, it } from "vitest";
import { EvidenceHealthState } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../sqlite/db.js";
import { SqliteEvidenceCapsuleRepo } from "../../../repos/capsules/evidence-capsule-repo.js";
import { SqliteFieldSourceRecordRepo } from "../../../repos/field/source-repo.js";
import { SqliteSourceRootRecallReader } from "../../../repos/field/bounded-source-root-reader.js";
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
    }, 64);
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
    }, 64, 1);
    expect(broken.unavailable).toBe(true);
    expect(broken.row).toBeNull();
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
