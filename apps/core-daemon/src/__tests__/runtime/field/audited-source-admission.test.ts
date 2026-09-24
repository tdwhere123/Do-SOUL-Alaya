import { afterEach, describe, expect, it } from "vitest";
import { createAuditedSourceAdmission, deriveAddressableSpanViews, fieldContractSha256 } from "@do-soul/alaya-core";
import { initDatabase, SqliteEventLogRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { UTTERANCE_ATTRIBUTION_CONTRACT, type SourceAdmissionRequest,
  type UtteranceAttribution } from "@do-soul/alaya-protocol";
import { createDaemonFieldComposition } from "../../../runtime/field/field-composition.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const db of databases) db.close(); databases.clear(); });
const CLOCK = "2026-09-13T00:00:00.000Z";
const captured = (author: string): UtteranceAttribution => ({ contract: UTTERANCE_ATTRIBUTION_CONTRACT,
  status: "captured", issuer_scope: "authored-harness", utterances: [{ occurrence_id: "utterance-1",
    utf8_span: [0, Buffer.byteLength("A café record.")], conversation_ref: "conversation-1", author_ref: author }] });
function request(overrides: Partial<SourceAdmissionRequest> = {}): SourceAdmissionRequest {
  return { workspace_id: "workspace-a", source_id: "message-a", source_version: "1", content_bytes: "A café record.",
    evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
    speaker: "user", scope_class: "project", spans: deriveAddressableSpanViews("A café record."), ...overrides };
}
function fixture() {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  database.connection.prepare(`INSERT INTO workspaces (workspace_id, name, root_path, workspace_kind,
    default_engine_binding, workspace_state, created_at, archived_at, default_engine_class)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("workspace-a", "Source workspace", "/tmp/source-workspace",
    "local_repo", null, "active", CLOCK, null, null);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const field = createDaemonFieldComposition({ database, eventLogRepo, fieldProjectionAdmissionMode: "explicit_checkpoint" });
  const admission = createAuditedSourceAdmission({ stores: field.stores, eventLogRepo, sha256: fieldContractSha256,
    runtimeNotifier: { notifyEntry: () => undefined } });
  return { database, eventLogRepo, field, admission };
}

describe("mandatory audited source admission", () => {
  it("persists exact source bytes and stable duplicate identities without capsules", async () => {
    const f = fixture();
    const first = await f.admission.admit(request(), { workspaceId: "workspace-a" });
    const again = await f.admission.admit(request(), { workspaceId: "workspace-a" });
    expect(again).toEqual(first);
    expect(f.field.stores.listStoredRecords("workspace-a")).toHaveLength(1);
    expect(f.field.stores.getStoredRecord("workspace-a", first.record.identity)?.content_bytes).toBe("A café record.");
    expect(first.record).toMatchObject({ evidence_object_id: null, event_time: null, valid_from: null, valid_to: null });
    expect(f.database.connection.prepare("SELECT count(*) AS n FROM evidence_capsules").get()).toMatchObject({ n: 0 });
    await expect(f.admission.admit(request({ event_time: CLOCK }), { workspaceId: "workspace-a" })).rejects.toThrow();
    await expect(f.admission.admit(request(), { workspaceId: "workspace-b" })).rejects.toThrow(/workspace/);
    expect(f.field.stores.listRecords("workspace-b")).toEqual([]);
  });

  it("rolls back record and earlier spans when a later UTF-8 span is malformed", async () => {
    const f = fixture();
    await expect(f.admission.admit(request({ spans: [
      { start_offset: 0, end_offset: 1, purpose: "native_structure" },
      { start_offset: 0, end_offset: 6, purpose: "native_structure" }
    ] }), { workspaceId: "workspace-a" })).rejects.toThrow(/UTF-8/);
    expect(f.field.stores.listRecords("workspace-a")).toEqual([]);
    expect(f.field.stores.listSpans("workspace-a")).toEqual([]);
  });

  it("requires a new later source revision for an attribution correction while retaining old metadata", async () => {
    const f = fixture();
    const first = await f.admission.admit(request({ attribution_context: captured("person-1") }),
      { workspaceId: "workspace-a" });
    expect((await f.admission.admit(request({ attribution_context: captured("person-1") }),
      { workspaceId: "workspace-a" })).record).toEqual(first.record);
    await expect(f.admission.admit(request({ attribution_context: captured("person-2") }),
      { workspaceId: "workspace-a" })).rejects.toThrow();
    await expect(f.admission.admit(request({ source_version: "2", attribution_context: captured("person-2") }),
      { workspaceId: "workspace-a" })).rejects.toThrow(/later recorded time/);
    await expect(f.admission.admit(request({ content_bytes: "A café record. Revised.",
      recorded_at: "2026-09-13T00:00:01.000Z", attribution_context: captured("person-2") }),
    { workspaceId: "workspace-a" })).rejects.toThrow(/new source revision/);
    const second = await f.admission.admit(request({ source_version: "2",
      recorded_at: "2026-09-13T00:00:01.000Z", attribution_context: captured("person-2") }),
    { workspaceId: "workspace-a" });
    expect(second.record.identity).not.toBe(first.record.identity);
    expect(second.record.content_digest).toBe(first.record.content_digest);
    expect(f.field.stores.getCurrentRecord("workspace-a", "message-a")?.identity).toBe(second.record.identity);
    expect(f.field.stores.getStoredRecord("workspace-a", first.record.identity)?.record.attribution_context)
      .toEqual(captured("person-1"));
    expect(f.field.stores.getStoredRecord("workspace-a", second.record.identity)?.content_bytes)
      .toBe("A café record.");
    expect((await f.admission.admit(request({ attribution_context: captured("person-1") }),
      { workspaceId: "workspace-a" })).record).toEqual(first.record);
    expect(f.field.stores.getCurrentRecord("workspace-a", "message-a")?.identity).toBe(second.record.identity);
  });

  it("does not reinterpret an old missing attribution as newly asserted unknown", async () => {
    const f = fixture();
    await expect(f.admission.admit(request({ attribution_context: null }),
      { workspaceId: "workspace-a" })).rejects.toThrow();
    const first = await f.admission.admit(request(), { workspaceId: "workspace-a" });
    f.database.connection.prepare("UPDATE source_records SET attribution_context_json = NULL WHERE record_id = ?")
      .run(first.record.identity);
    expect(f.field.stores.getStoredRecord("workspace-a", first.record.identity)?.record.attribution_context).toBeNull();
    expect((await f.admission.admit(request({ attribution_context: null }),
      { workspaceId: "workspace-a" })).record.identity).toBe(first.record.identity);
    await expect(f.admission.admit(request(), { workspaceId: "workspace-a" })).rejects.toThrow();
    expect(f.field.stores.getStoredRecord("workspace-a", first.record.identity)?.record.attribution_context).toBeNull();
  });

  it("leaves committed identity on audit failure and completes audit on retry", async () => {
    const f = fixture();
    let fail = true;
    const admission = createAuditedSourceAdmission({ stores: f.field.stores, sha256: fieldContractSha256,
      runtimeNotifier: { notifyEntry: () => undefined },
      eventLogRepo: { append: (event) => { if (fail) throw new Error("audit unavailable"); return f.eventLogRepo.append(event); } } });
    await expect(admission.admit(request(), { workspaceId: "workspace-a" })).rejects.toThrow("audit unavailable");
    const committed = f.field.stores.listRecords("workspace-a");
    expect(committed).toHaveLength(1);
    fail = false;
    expect((await admission.admit(request(), { workspaceId: "workspace-a" })).record.identity).toBe(committed[0]!.identity);
    await f.field.fieldProjectionCheckpoint.refresh();
    expect(f.field.fieldRepos.generations.readActive("workspace-a")).not.toBeNull();
  });

  it("does not turn a retired source body back into an admitted source", async () => {
    const f = fixture();
    const first = await f.admission.admit(request(), { workspaceId: "workspace-a" });
    f.database.connection.prepare("UPDATE source_records SET source_body = NULL WHERE workspace_id = ? AND record_id = ?")
      .run("workspace-a", first.record.identity);
    await expect(f.admission.admit(request(), { workspaceId: "workspace-a" })).rejects.toThrow(/retired/);
    expect(f.field.stores.getStoredRecord("workspace-a", first.record.identity)).toBeNull();
  });
});
