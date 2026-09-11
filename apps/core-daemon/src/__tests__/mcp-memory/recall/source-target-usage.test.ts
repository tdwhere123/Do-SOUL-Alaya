import { afterEach, describe, expect, it } from "vitest";
import { fieldContractSha256, runConditionalFieldRecallWithReceipt } from "@do-soul/alaya-core";
import { SqliteEvidenceCapsuleRepo, SqliteFieldSourceRecordRepo, SqliteSourceRootRecallReader, type StorageDatabase } from "@do-soul/alaya-storage";
import type { SourceEvidenceTarget } from "@do-soul/alaya-protocol";
import { validateReportedRecallHits } from "../../../mcp-memory/usage/recall-usage-object-validation.js";
import { createConditionalFieldObserverReaders } from "../../../runtime/recall-read-worker/observer-operations.js";
import { createDeps, createDeliveryRecord } from "../tool/mcp-memory-tool-handler-fixture.js";
import { openBoundSlice, plantSourceRecord, WS, defaultBudget, INTERPRETATION_CLOCK, SNAPSHOT_ID } from "../../runtime/recall/conditional-field-acceptance/planted-handler.js";

const CAPSULE = "cccccccc-cccc-4ccc-8ccc-000000000201";
const databases: StorageDatabase[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

async function fixture() {
  const slice = await openBoundSlice((database) => databases.push(database));
  const records = new SqliteFieldSourceRecordRepo(slice.database, fieldContractSha256);
  const capsules = new SqliteEvidenceCapsuleRepo(slice.database);
  const roots = new SqliteSourceRootRecallReader(records, capsules);
  return { ...slice, records, capsules, roots };
}

async function createCapsule(capsules: SqliteEvidenceCapsuleRepo) {
  return capsules.create({ object_id: CAPSULE, object_kind: "evidence_capsule", schema_version: 1,
    lifecycle_state: "active", created_at: INTERPRETATION_CLOCK, updated_at: INTERPRETATION_CLOCK,
    created_by: "user_action", evidence_kind: "conversation_excerpt",
    semantic_anchor: { topic: "source", keywords: ["needle"], summary: "retained source" },
    event_anchor: null, physical_anchor: null, evidence_health_state: "verified", gist: "gist",
    excerpt: "needle 😀 original", source_hash: "original-turn-digest", run_id: "run-1", workspace_id: WS, surface_id: null });
}

function recalledTarget(database: StorageDatabase): SourceEvidenceTarget {
  const index = runConditionalFieldRecallWithReceipt({ workspace_id: WS, query_text: "needle", result_kind_view: "source_only",
    budget: defaultBudget(), snapshot_id: SNAPSHOT_ID, interpretation_clock: INTERPRETATION_CLOCK,
    as_of: INTERPRETATION_CLOCK, expires_at: "2099-01-01T00:00:00Z", lifetime_now: INTERPRETATION_CLOCK,
    authorized_scopes: null, readers: createConditionalFieldObserverReaders(database),
    protocol_version: 1, supports_source_evidence: true, supported_result_kinds: ["memory_entry", "source_evidence"] }).index;
  const target = index.entries[0]?.target;
  if (target?.kind !== "source_evidence") throw new Error("expected a delivered source target");
  return target;
}

function reportUsed(slice: Awaited<ReturnType<typeof fixture>>, target: SourceEvidenceTarget) {
  const delivery = { ...createDeliveryRecord("delivery-source"), workspace_id: WS, delivered_object_ids: [],
    delivered_objects: [{ object_kind: "source_evidence" as const, target }] };
  return validateReportedRecallHits({ ...createDeps(), fieldSource: slice.roots,
    evidenceService: { findByIdScoped: async (id) => slice.capsules.getById(id) } }, {
    delivery_id: delivery.delivery_id, usage_state: "used",
    delivered_objects: [{ object_kind: "source_evidence", target, usage_status: "used" }]
  }, WS, delivery);
}

describe("current canonical source usage identity", () => {
  it("accepts later formation aliases and rejects the old alias after capsule retirement", async () => {
    const slice = await fixture();
    const record = plantSourceRecord(slice.database, "needle 😀 original");
    const before = recalledTarget(slice.database);
    expect(before.evidence_object_id).toBeNull();
    await createCapsule(slice.capsules);
    slice.records.insert({ ...record, evidence_object_id: CAPSULE });
    const delivered = recalledTarget(slice.database);
    expect(delivered.evidence_object_id).toBe(CAPSULE);
    await expect(reportUsed(slice, delivered)).resolves.toBeUndefined();
    await expect(reportUsed(slice, before)).rejects.toThrow(/current retained source/);
    slice.database.connection.prepare("UPDATE evidence_capsules SET lifecycle_state = 'archived' WHERE object_id = ?").run(CAPSULE);
    await expect(reportUsed(slice, delivered)).rejects.toThrow(/current retained source/);
  });

  it("validates capsule revision and retained-text digest against the exact delivered target", async () => {
    const slice = await fixture();
    await createCapsule(slice.capsules);
    const delivered = recalledTarget(slice.database);
    expect(delivered.root_kind).toBe("evidence_capsule");
    expect(delivered.content_digest).not.toBe("original-turn-digest");
    await expect(reportUsed(slice, delivered)).resolves.toBeUndefined();
    await expect(reportUsed(slice, { ...delivered, content_digest: `sha256:${"f".repeat(64)}` })).rejects.toThrow();
    slice.database.connection.prepare("UPDATE evidence_capsules SET updated_at = ? WHERE object_id = ?")
      .run("2026-09-10T00:00:00Z", CAPSULE);
    await expect(reportUsed(slice, delivered)).rejects.toThrow(/current retained source/);
  });

  it.each(["source_record", "evidence_capsule"] as const)("rejects out-of-body and split UTF-8 spans for %s", async (kind) => {
    const slice = await fixture();
    if (kind === "source_record") plantSourceRecord(slice.database, "needle 😀 original");
    else await createCapsule(slice.capsules);
    const delivered = recalledTarget(slice.database);
    const span = { content_start: 0, content_end: 10000, retained_extent: kind === "source_record" ? "body" as const : "excerpt" as const,
      content_complete: false, original_complete: kind === "source_record" };
    await expect(reportUsed(slice, { ...delivered, span })).rejects.toThrow();
    await expect(reportUsed(slice, { ...delivered, span: { ...span, content_start: 8, content_end: 11 } })).rejects.toThrow();
  });
});
