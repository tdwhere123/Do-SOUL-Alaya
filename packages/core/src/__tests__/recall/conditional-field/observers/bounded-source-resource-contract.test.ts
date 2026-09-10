import { afterEach, describe, expect, it } from "vitest";
import { EvidenceHealthState, sourceRecallTarget, type QueryInterpretation } from "@do-soul/alaya-protocol";
import { SqliteEvidenceCapsuleRepo, SqliteFieldSourceRecordRepo, SqliteSourceRootRecallReader, type StorageDatabase } from "@do-soul/alaya-storage";
import { observeConditionalField, startObserverCursor, toSourceRootObserverRow } from "../../../../recall/conditional-field/observers/observe.js";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import { defaultBudget, defaultView, SNAPSHOT_ID } from "../reference/deployment.fixture.js";
import { fieldSha256, hashedRecord, openFieldDatabase } from "../../../../../../storage/src/__tests__/repos/field/field-contract-fixture.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

function fixture() {
  const database = openFieldDatabase();
  databases.add(database);
  const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
  const capsules = new SqliteEvidenceCapsuleRepo(database);
  return { database, records, capsules, reader: new SqliteSourceRootRecallReader(records, capsules) };
}

function query(): QueryInterpretation {
  return { schema_version: 1, query_id: "bounded-source-resource-contract", snapshot_id: SNAPSHOT_ID,
    status: "resolved", program: { schema_version: 1, kind: "epsilon" }, holes: [], hypotheses: [],
    view: { ...defaultView(), result_kind_view: "source_only" },
    source_guard: { schema_version: 1, kind: "query_predicate", verdict: "unresolved",
      predicate_name: "source.literal.nfc.v1", entity_id: "NEEDLE" } };
}

function createCapsule(capsules: SqliteEvidenceCapsuleRepo, body: string) {
  return capsules.create({ object_id: "99999999-9999-4999-8999-999999999999",
    object_kind: "evidence_capsule", schema_version: 1, lifecycle_state: "active", created_by: "user_action",
    created_at: "2026-09-09T00:00:00.000Z", updated_at: "2026-09-09T00:00:00.000Z",
    evidence_kind: "conversation_excerpt", semantic_anchor: { topic: "source", keywords: [], summary: "source" },
    event_anchor: null, physical_anchor: null, evidence_health_state: EvidenceHealthState.VERIFIED,
    gist: "source", excerpt: body, source_hash: null, run_id: "run-1", workspace_id: "workspace-1", surface_id: null });
}

describe("bounded source resource consumer contract", () => {
  it("limits cumulative native bytes across all roots read in one observer request", () => {
    const { records, reader } = fixture();
    for (let index = 0; index < 8; index += 1) {
      records.insert(hashedRecord("workspace-1", `NEEDLE${"x".repeat(30_000)}`, `large-${index}`));
    }
    let nativeBytes = 0;
    const budget = { ...defaultBudget(), memory_bytes: 50_000 };
    observeField(query(), { workspace_id: "workspace-1", query_text: "NEEDLE", as_of: "2026-09-10T00:00:00.000Z",
      budget, readers: { sourceRootMetadataByteLimit: 8192, sourceRoots: (input) => {
        const page = reader.page(input);
        nativeBytes += page.bytesRead + (page.metadataBytes ?? 0);
        return { ...page, rows: page.rows.map(toSourceRootObserverRow) };
      } } });
    expect(nativeBytes).toBeGreaterThan(0);
    expect(nativeBytes).toBeLessThanOrEqual(budget.memory_bytes);
  });

  it("resumes every unfinished root from a multi-root page without growing nested cursor strings", () => {
    const { records, reader } = fixture();
    const expected = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      expected.add(records.insert(hashedRecord("workspace-1", "xxxxxxxxNEEDLE", `pending-${index}`)).record_id);
    }
    const interpretation = query();
    let cursor = startObserverCursor({ cursor_id: "seed", region_id: "seed", snapshot_id: SNAPSHOT_ID,
      query_id: interpretation.query_id });
    const admitted = new Set<string>();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = observeConditionalField({ workspace_id: "workspace-1", query: interpretation,
        action: { schema_version: 1, action: "seed", region_id: "seed", work_limit: 100 }, cursor,
        lease: { schema_version: 1, lease_id: "source-test", status: "active", snapshot_id: SNAPSHOT_ID,
          query_id: interpretation.query_id }, source_byte_limit: 8, page_limit: 20,
        readers: { sourceRoots: (input) => { const page = reader.page({ ...input, nativeByteLimit: 262144 });
          return { ...page, rows: page.rows.map(toSourceRootObserverRow) }; } } });
      for (const row of result.page.observations) if (row.applicability.verdict === "true") admitted.add(row.object_id);
      cursor = result.page.cursor;
      if (result.page.outcome.status === "exhausted") break;
    }
    expect(admitted).toEqual(expected);
  });

  it("reports native capsule bytes even when hydration rejects the requested source revision", async () => {
    const { capsules, reader } = fixture();
    const capsule = await createCapsule(capsules, "abcdefgh");
    const page = reader.hydrate("workspace-1", sourceRecallTarget({ workspace_id: "workspace-1",
      root_kind: "evidence_capsule", root_id: capsule.object_id, source_version: "stale-version",
      content_digest: SNAPSHOT_ID, evidence_object_id: capsule.object_id }), 4, 0, 16384);
    expect(page.unavailable).toBe(true);
    expect(page.bytesRead).toBe(8);
  });

  it("does not read a content continuation after its native work allowance is exhausted", () => {
    const { records, reader } = fixture();
    const record = records.insert(hashedRecord("workspace-1", "xxxxxxxxNEEDLE", "continuation"));
    const page = reader.page({ workspaceId: "workspace-1", limit: 1, nativeLimit: 1, workLimit: 0,
      afterCursor: `o:source_record\t${record.record_id}\t8`, byteLimit: 8 });
    expect(page.nativeWork ?? page.nativeVisits).toBe(0);
    expect(page.bytesRead).toBe(0);
  });

  it("normalizes a verified capsule binding added after the original root was retained", async () => {
    const { records, capsules, reader } = fixture();
    const record = records.insert(hashedRecord("workspace-1", "retained source", "late-alias"));
    const capsule = await createCapsule(capsules, "retained source");
    records.insert({ ...record, evidence_object_id: capsule.object_id });
    expect(records.listEvidenceBindings("workspace-1")).toContainEqual({ workspace_id: "workspace-1",
      record_id: record.record_id, evidence_object_id: capsule.object_id });
    const page = reader.page({ workspaceId: "workspace-1", limit: 8, nativeLimit: 8, byteLimit: 64, nativeByteLimit: 65536, afterCursor: null });
    expect(page.rows.map((row) => row.root_id)).toEqual([record.record_id]);
    expect(page.rows[0]?.evidence_verified).toBe(true);
  });

  it.each(["source_record", "evidence_capsule"] as const)(
    "keeps missing %s chunk projection unavailable instead of claiming an empty source family", async (kind) => {
      const { database, records, capsules, reader } = fixture();
      const id = kind === "source_record"
        ? records.insert(hashedRecord("workspace-1", "NEEDLE", "missing-chunk")).record_id
        : (await createCapsule(capsules, "NEEDLE")).object_id;
      database.connection.prepare("DELETE FROM retained_source_chunks WHERE root_id = ?").run(id);
      database.connection.pragma("query_only = ON");
      const page = reader.page({ workspaceId: "workspace-1", limit: 8, nativeLimit: 8,
        byteLimit: 64, nativeByteLimit: 65536, afterCursor: null });
      expect(page.rows).toEqual([]);
      expect(page.unavailable).toBe(true);
    }
  );

  it("rejects a corrupted derived chunk instead of relabelling its text with the canonical digest", () => {
    const { database, records, reader } = fixture();
    const record = records.insert(hashedRecord("workspace-1", "NEEDLE", "corrupt-chunk"));
    database.connection.prepare("UPDATE retained_source_chunks SET body = ? WHERE root_id = ?")
      .run(Buffer.from("FORGED"), record.record_id);
    database.connection.pragma("query_only = ON");
    const page = reader.hydrate("workspace-1", sourceRecallTarget({ workspace_id: "workspace-1", root_kind: "source_record",
      root_id: record.record_id, source_version: record.source_version, content_digest: record.content_digest,
      evidence_object_id: null }), 64, 0, 16384);
    expect(page.unavailable).toBe(true);
    expect(page.row).toBeNull();
  });

  it("enforces the physical byte grain for a stored chunk regardless of SQLite value affinity", () => {
    const { database, records } = fixture();
    const record = records.insert(hashedRecord("workspace-1", "NEEDLE", "wrong-chunk-type"));
    expect(() => database.connection.prepare("UPDATE retained_source_chunks SET body = ? WHERE root_id = ?")
      .run("😀".repeat(4096), record.record_id)).toThrow();
  });

  it.each(["source_record", "evidence_capsule"] as const)(
    "cannot turn retained %s content into an empty source through a corrupt derived length", async (kind) => {
      const { database, records, capsules, reader } = fixture();
      if (kind === "source_record") records.insert(hashedRecord("workspace-1", "NEEDLE", "corrupt-length"));
      else await createCapsule(capsules, "NEEDLE");
      const row = reader.page({ workspaceId: "workspace-1", limit: 8, nativeLimit: 8,
        byteLimit: 64, nativeByteLimit: 65536, afterCursor: null }).rows[0]!;
      const table = kind === "source_record" ? "source_records" : "evidence_capsules";
      database.connection.prepare(`UPDATE ${table} SET retained_content_bytes = 0`).run();
      database.connection.pragma("query_only = ON");
      const page = reader.hydrate("workspace-1", sourceRecallTarget({ workspace_id: "workspace-1", root_kind: kind,
        root_id: row.root_id, source_version: row.revision, content_digest: row.digest,
        evidence_object_id: row.evidence_object_id }), 64, 0, 16384);
      expect(page.row === null || page.row.content === "NEEDLE").toBe(true);
      if (page.row === null) expect(page.unavailable).toBe(true);
    }
  );
});
