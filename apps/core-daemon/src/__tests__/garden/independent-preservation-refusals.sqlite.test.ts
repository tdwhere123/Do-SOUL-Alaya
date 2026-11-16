import { afterEach, describe, expect, it, vi } from "vitest";
import { createHistoricalMemoryCapture, canonicalJson } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { createPreservationFixture, PRESERVATION_CLOCK, PRESERVATION_WORKSPACE } from "./independent-preservation.test-support.js";

const fixtures: Awaited<ReturnType<typeof createPreservationFixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures) await f.dispose(); fixtures.length = 0; });
async function fixture() {
  const f = await createPreservationFixture(); fixtures.push(f);
  const { memory } = await f.publishMember("refusal-source");
  const capsule = await f.createCapsule([memory.object_id]);
  const tombstone = () => f.memoryService.autonomousTombstone(memory.object_id, "compressed", capsule.object_id,
    "historical retention", "deterministic_rule");
  const history = () => f.synthesisService.readHistoricalMember(PRESERVATION_WORKSPACE, capsule.object_id, memory.object_id);
  return { ...f, memory, capsule, tombstone, history };
}
function count(f: Awaited<ReturnType<typeof fixture>>, table: string) {
  return f.database.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
}

describe("historical capture refuses incomplete authority and mutation races", () => {
  it.each(["pinned", "hazard", "canon", "consolidated"])("refuses %s protection without capture or audit", async protection => {
    const f = await fixture();
    f.database.connection.prepare(`UPDATE memory_entries SET ${protection === "canon" || protection === "consolidated"
      ? "retention_state" : "decay_profile"}=? WHERE object_id=?`).run(protection, f.memory.object_id);
    const audits = count(f, "event_log");
    await expect(f.tombstone()).rejects.toThrow(/protected/);
    expect(count(f, "historical_memory_captures")).toEqual({ n: 0 });
    expect(count(f, "event_log")).toEqual(audits);
  });

  it.each(["binding", "dependency", "content", "member-scope", "missing-capsule"])("refuses %s instead of treating membership as proof", async defect => {
    const f = await fixture();
    const db = f.database.connection;
    if (defect === "binding") db.prepare("DELETE FROM source_statement_memory_bindings WHERE memory_id=?").run(f.memory.object_id);
    if (defect === "dependency") db.prepare("DELETE FROM source_statement_dependencies WHERE artifact_id=?").run(f.memory.evidence_refs[0]);
    if (defect === "content") db.prepare("UPDATE memory_entries SET content='not the bound statement' WHERE object_id=?").run(f.memory.object_id);
    if (defect === "member-scope") db.prepare("UPDATE memory_entries SET scope_class='global_domain' WHERE object_id=?").run(f.memory.object_id);
    if (defect === "missing-capsule") db.prepare("DELETE FROM synthesis_capsules WHERE object_id=?").run(f.capsule.object_id);
    const audits = count(f, "event_log");
    await expect(f.tombstone()).rejects.toThrow();
    expect(count(f, "historical_memory_captures")).toEqual({ n: 0 });
    expect(count(f, "event_log")).toEqual(audits);
    expect(f.database.connection.prepare("SELECT lifecycle_state FROM memory_entries WHERE object_id=?").get(f.memory.object_id))
      .toEqual({ lifecycle_state: "dormant" });
    if (defect === "dependency") await expect(f.memoryService.findById(f.memory.object_id)).rejects.toThrow();
  });

  it("refuses a partial dependency set even when the direct input remains current", async () => {
    const f = await fixture();
    const context = await f.admit("required-context", "context outside direct evidence refs");
    const published = await f.publishMember("context-bound-member", "contextual statement", [{
      workspace_id: PRESERVATION_WORKSPACE, root_id: context.record.identity, source_id: context.record.source_id,
      source_version: context.record.source_version, content_digest: context.record.content_digest
    }]);
    const capsule = await f.createCapsule([published.memory.object_id]);
    f.database.connection.prepare("DELETE FROM source_statement_dependencies WHERE artifact_id=? AND record_id=?")
      .run(published.memory.evidence_refs[0], context.record.identity);
    await expect(f.memoryService.autonomousTombstone(published.memory.object_id, "compressed", capsule.object_id,
      "incomplete context", "deterministic_rule")).rejects.toMatchObject({ subCode: "PRESERVATION_INELIGIBLE" });
    expect(count(f, "historical_memory_captures")).toEqual({ n: 0 });
  });

  it.each(["member", "capsule", "protection", "source"])("rechecks the %s at the actual transition boundary", async race => {
    const f = await fixture();
    const original = f.memoryEntryRepo.autonomousTombstone.bind(f.memoryEntryRepo);
    vi.spyOn(f.memoryEntryRepo, "autonomousTombstone").mockImplementationOnce(async (...args) => {
      const db = f.database.connection;
      if (race === "member") db.prepare("UPDATE memory_entries SET confidence=0.123 WHERE object_id=?").run(f.memory.object_id);
      if (race === "capsule") db.prepare("UPDATE synthesis_capsules SET summary='changed' WHERE object_id=?").run(f.capsule.object_id);
      if (race === "protection") db.prepare("UPDATE memory_entries SET decay_profile='pinned' WHERE object_id=?").run(f.memory.object_id);
      if (race === "source") await f.admit("refusal-source", "replacement source", "2");
      return original(...args);
    });
    await expect(f.tombstone()).rejects.toThrow();
    expect(count(f, "historical_memory_captures")).toEqual({ n: 0 });
    expect(f.database.connection.prepare("SELECT lifecycle_state FROM memory_entries WHERE object_id=?").get(f.memory.object_id))
      .toEqual({ lifecycle_state: "dormant" });
    if (race === "source") await expect(f.memoryService.findById(f.memory.object_id)).rejects.toThrow();
  });

  it("refuses an erased source and never repairs pre-existing quarantine by capturing", async () => {
    const f = await fixture();
    const source = f.field.fieldRepos.records.findCurrent(PRESERVATION_WORKSPACE, "refusal-source")!;
    f.field.fieldRepos.erase.apply({ barrier_id: "erased-before-adoption", workspace_id: PRESERVATION_WORKSPACE,
      generation_id: null, subject_kind: "source_record", subject_id: source.record_id, erased_at: PRESERVATION_CLOCK });
    await expect(f.tombstone()).rejects.toThrow();
    expect(count(f, "historical_memory_captures")).toEqual({ n: 0 });
    expect(await f.history()).toEqual({ status: "missing" });
  });

  it("does not release a capsule quarantined before adoption", async () => {
    const f = await fixture();
    f.database.connection.prepare("INSERT INTO privacy_dependency_quarantine(workspace_id,object_kind,object_id) VALUES(?,'synthesis_capsule',?)")
      .run(PRESERVATION_WORKSPACE, f.capsule.object_id);
    await expect(f.tombstone()).rejects.toThrow();
    expect(count(f, "historical_memory_captures")).toEqual({ n: 0 });
    expect(f.database.connection.prepare("SELECT object_id FROM privacy_dependency_quarantine WHERE object_id=?").get(f.capsule.object_id))
      .toEqual({ object_id: f.capsule.object_id });
  });

  it("rejects a recomputed but forged capture at storage adoption", async () => {
    const f = await fixture();
    const nomination = await f.memoryEntryRepo.readHistoricalCaptureCandidate(PRESERVATION_WORKSPACE, f.memory.object_id, f.capsule.object_id);
    expect(nomination.status).toBe("ready");
    if (nomination.status !== "ready") throw new Error("expected native candidate");
    const capture = createHistoricalMemoryCapture(nomination.candidate, PRESERVATION_CLOCK, fieldContractSha256)!;
    const { capture_id: ignored, ...material } = capture;
    void ignored;
    const forgedMaterial = { ...material, member: { ...material.member, domain_tags: ["forged retained metadata"] } };
    const forged = { ...forgedMaterial, capture_id: `sha256:${fieldContractSha256(canonicalJson(forgedMaterial))}` };
    await expect(f.memoryEntryRepo.autonomousTombstone({ objectId: f.memory.object_id, disposition: "compressed",
      dispositionRef: f.capsule.object_id, updatedAt: PRESERVATION_CLOCK, preservation: forged }, {
        onTransition: () => { throw new Error("forged capture must fail before audit"); }
      })).rejects.toThrow();
    expect(count(f, "historical_memory_captures")).toEqual({ n: 0 });
  });

  it("rolls back capture, terminal row, audit and quarantine together, then retries", async () => {
    const f = await fixture();
    const other = await f.createCapsule([f.memory.object_id]);
    const before = await f.memoryService.findById(f.memory.object_id);
    const audits = count(f, "event_log");
    f.database.connection.exec(`CREATE TRIGGER refuse_terminal_audit BEFORE INSERT ON event_log
      WHEN json_extract(NEW.payload_json,'$.to_state')='tombstone'
      BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`);
    await expect(f.tombstone()).rejects.toThrow();
    expect(await f.memoryService.findById(f.memory.object_id)).toEqual(before);
    expect(count(f, "historical_memory_captures")).toEqual({ n: 0 });
    expect(count(f, "historical_memory_capture_sources")).toEqual({ n: 0 });
    expect(count(f, "event_log")).toEqual(audits);
    expect(await f.synthesisService.findByIdScoped(other.object_id, PRESERVATION_WORKSPACE)).toEqual(other);
    f.database.connection.exec("DROP TRIGGER refuse_terminal_audit");
    await f.tombstone();
    expect(await f.history()).toMatchObject({ status: "ready", history: { member: before } });
    await expect(f.synthesisService.findByIdScoped(other.object_id, PRESERVATION_WORKSPACE)).rejects.toThrow();
  });

  it("keeps a committed capture on notification failure and does not adopt twice", async () => {
    const f = await fixture();
    f.notifier.notifyEntry.mockRejectedValueOnce(new Error("notifier unavailable"));
    await expect(f.tombstone()).rejects.toThrow(/notifier unavailable/);
    expect(await f.history()).toMatchObject({ status: "ready" });
    expect(await f.memoryService.findById(f.memory.object_id)).toMatchObject({ lifecycle_state: "tombstone" });
    await expect(f.tombstone()).rejects.toThrow(/dormant/);
    expect(count(f, "historical_memory_captures")).toEqual({ n: 1 });
  });

  it.each(["member", "evidence", "audit"])("irreversibly invalidates %s changes, including field restoration", async changed => {
    const f = await fixture();
    await f.tombstone();
    const db = f.database.connection;
    if (changed === "evidence") {
      db.prepare("UPDATE evidence_capsules SET updated_at=updated_at, gist=gist, lifecycle_state=lifecycle_state WHERE object_id=?")
        .run(f.memory.evidence_refs[0]);
      expect(await f.history()).toMatchObject({ status: "ready" });
    }
    if (changed === "member") {
      db.prepare("UPDATE memory_entries SET decay_profile='pinned' WHERE object_id=?").run(f.memory.object_id);
      db.prepare("UPDATE memory_entries SET decay_profile=? WHERE object_id=?").run(f.memory.decay_profile, f.memory.object_id);
    }
    if (changed === "evidence") db.prepare("UPDATE evidence_capsules SET updated_at='2020-01-02T00:00:00.000Z' WHERE object_id=?").run(f.memory.evidence_refs[0]);
    if (changed === "audit") db.prepare("DELETE FROM event_log WHERE event_id IN (SELECT audit_event_id FROM historical_memory_captures)").run();
    expect(await f.history()).toEqual({ status: "invalidated" });
    expect(await f.memoryEntryRepo.hardDeleteTombstonedWithDisposition(f.memory.object_id, { requireLiveCapsuleRef: true })).toBe(false);
    await expect(f.synthesisService.findByIdScoped(f.capsule.object_id, PRESERVATION_WORKSPACE)).rejects.toThrow();
    expect(() => db.exec("UPDATE historical_memory_captures SET state='active'")).toThrow();
  });

  it("rechecks preservation after Core GC admission and rolls back DELETE when its audit fails", async () => {
    const f = await fixture();
    await f.tombstone();
    f.database.connection.exec(`CREATE TRIGGER refuse_delete_audit BEFORE INSERT ON event_log
      WHEN json_extract(NEW.payload_json,'$.to_state')='deleted'
      BEGIN SELECT RAISE(ABORT,'delete audit unavailable'); END`);
    await expect(f.memoryService.autonomousHardDeleteTombstoned(f.memory.object_id, "GC", "deterministic_rule"))
      .rejects.toThrow();
    expect(await f.history()).toMatchObject({ status: "ready" });
    expect(await f.memoryService.findById(f.memory.object_id)).not.toBeNull();
    f.database.connection.exec("DROP TRIGGER refuse_delete_audit");
    const original = f.memoryEntryRepo.hardDeleteTombstonedWithDisposition.bind(f.memoryEntryRepo);
    vi.spyOn(f.memoryEntryRepo, "hardDeleteTombstonedWithDisposition").mockImplementationOnce(async (id, options) => {
      f.database.connection.prepare("UPDATE memory_entries SET decay_profile='pinned' WHERE object_id=?").run(f.memory.object_id);
      return original(id, options);
    });
    expect(await f.memoryService.autonomousHardDeleteTombstoned(f.memory.object_id, "GC", "deterministic_rule")).toBe(false);
    expect(await f.memoryService.findById(f.memory.object_id)).not.toBeNull();
  });
});
