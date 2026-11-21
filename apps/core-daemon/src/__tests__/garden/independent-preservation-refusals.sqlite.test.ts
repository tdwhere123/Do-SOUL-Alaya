import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import {
  canonicalGovernanceSubject,
  canonicalJson,
  createHistoricalMemoryCapture,
  type SourceStatementContextSource
} from "@do-soul/alaya-protocol";
import { SqliteClaimFormRepo, SqliteSlotRepo } from "@do-soul/alaya-storage";
import { createClaimForm } from "../../../../../packages/core/src/__tests__/governance/claim-service.test-support.js";
import {
  createPreservationFixture,
  PRESERVATION_CLOCK,
  PRESERVATION_WORKSPACE
} from "./independent-preservation.test-support.js";

const WS = PRESERVATION_WORKSPACE;
const CLOCK = PRESERVATION_CLOCK;


const fixtures: Awaited<ReturnType<typeof createPreservationFixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fixture of fixtures) await fixture.dispose(); fixtures.length = 0; });
async function fixture() { const value = await createPreservationFixture(); fixtures.push(value); return value; }
type Fixture = Awaited<ReturnType<typeof fixture>>;
function reference(source: Awaited<ReturnType<Fixture["admit"]>>): SourceStatementContextSource {
  const record = source.record;
  return { workspace_id: WS, root_id: record.identity, source_id: record.source_id,
    source_version: record.source_version, content_digest: record.content_digest };
}
function barrier(id: string) {
  return { barrier_id: `erase-${id}`, workspace_id: WS, generation_id: null,
    subject_kind: "source_record" as const, subject_id: id, erased_at: "2020-01-03T00:00:00.000Z" };
}
async function downstream(f: Fixture, memberId: string, capsuleId: string) {
  const claims = new SqliteClaimFormRepo(f.database), slots = new SqliteSlotRepo(f.database);
  const direct = randomUUID(), indirect = randomUUID(), control = randomUUID(), slot = randomUUID();
  const subject = canonicalGovernanceSubject("private", { topic: "retained secret" });
  for (const [id, refs] of [[direct, [memberId]], [indirect, [capsuleId]], [control, []]] as const) {
    await claims.create(createClaimForm({ object_id: id, workspace_id: WS, governance_subject: subject,
      proposition_digest: id === control ? "independent support" : "retained secret",
      evidence_refs: [], source_object_refs: refs, claim_status: "active" }));
  }
  const base = { workspace_id: WS, run_id: null, caused_by: "system" };
  const canonical = await f.eventLogRepo.append({ ...base, entity_type: "claim_form", entity_id: direct,
    event_type: "canonicalization.applied", payload_json: { input: "retained secret", canonical: "retained secret",
      domain: "governance_subject.topic", was_alias_resolved: false, applied_at: CLOCK } });
  const created = await f.eventLogRepo.append({ ...base, entity_type: "slot", entity_id: slot,
    event_type: "soul.slot.created", payload_json: { object_id: slot, object_kind: "slot", workspace_id: WS,
      run_id: null, governance_subject: subject, claim_kind: "constraint", scope_class: "project", winner_claim_id: direct } });
  await slots.create({ object_id: slot, object_kind: "slot", schema_version: 1, lifecycle_state: "active",
    created_at: CLOCK, updated_at: CLOCK, created_by: "system", workspace_id: WS, governance_subject: subject,
    claim_kind: "constraint", scope_class: "project", winner_claim_id: direct, incumbent_since: CLOCK, flip_conditions: [] }, direct);
  await slots.updateWinner(slot, control, CLOCK, CLOCK, direct);
  return { claims, slots, direct, indirect, control, slot, canonical, created };
}

describe("historical capture refuses incomplete authority and mutation races", () => {
  async function fixture() {
    const f = await createPreservationFixture();
    fixtures.push(f);
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

it.each(["input", "context-one", "context-two", "projection-origin"])("erases retained material and downstream copies from %s after member GC", async erased => {
  const f = await fixture();
  const origin = await f.admit("projection-origin", "origin input");
  const one = await f.admit("context-one", "context not in member evidence refs");
  const two = await f.admit("context-two", "second context");
  const published = await f.publishMember("input", "retained secret", [reference(one), reference(two)], [origin.record.identity]);
  const capsule = await f.createCapsule([published.memory.object_id]);
  const independent = await f.publishMember("independent", "independent retained material");
  const independentCapsule = await f.createCapsule([independent.memory.object_id]);
  const copies = await downstream(f, published.memory.object_id, capsule.object_id);
  expect(await f.sweep()).toMatchObject({ success: true });
  await expect(copies.claims.findById(copies.direct)).rejects.toThrow();
  expect(await copies.claims.findById(copies.indirect)).toMatchObject({ proposition_digest: "retained secret" });
  const history = await f.synthesisService.readHistoricalMember(WS, capsule.object_id, published.memory.object_id);
  expect(history).toMatchObject({ status: "ready", history: { source_roots: expect.arrayContaining([
    reference(origin), reference(one), reference(two), reference(published.source)
  ]) } });
  expect(await f.sweep(true)).toMatchObject({ success: true });
  expect(await f.memoryService.findById(published.memory.object_id)).toBeNull();
  expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM source_statement_memory_bindings").get()).toEqual({ n: 0 });
  const sourceId = { input: published.source.record.identity, "context-one": one.record.identity,
    "context-two": two.record.identity, "projection-origin": origin.record.identity }[erased]!;
  const receipt = f.field.fieldRepos.erase.apply(barrier(sourceId));
  expect(await f.synthesisService.readHistoricalMember(WS, capsule.object_id, published.memory.object_id)).toEqual({ status: "erased" });
  expect(f.database.connection.prepare("SELECT material_json,state FROM historical_memory_captures WHERE memory_id=?")
    .get(published.memory.object_id)).toEqual({ material_json: null, state: "erased" });
  for (const id of [copies.direct, copies.indirect]) {
    expect(await copies.claims.findById(id)).toMatchObject({ lifecycle_state: "tombstone", proposition_digest: "erased" });
  }
  expect(await copies.claims.findById(copies.control)).toMatchObject({ lifecycle_state: "active", proposition_digest: "independent support" });
  expect(await copies.slots.findById(copies.slot)).toMatchObject({ winner_claim_id: copies.control });
  const [canonical] = await f.eventLogRepo.queryByEntityAll("claim_form", copies.direct);
  expect(canonical).toMatchObject({ event_id: copies.canonical.event_id, revision: copies.canonical.revision,
    payload_json: { input: null, canonical: null, redaction: { barrier_id: receipt.barrier_id } } });
  const [created] = await f.eventLogRepo.queryByEntityAll("slot", copies.slot);
  expect(created).toMatchObject({ event_id: copies.created.event_id, revision: copies.created.revision,
    payload_json: { governance_subject: null, redaction: { barrier_id: receipt.barrier_id } } });
  expect(await f.synthesisService.readHistoricalMember(WS, independentCapsule.object_id, independent.memory.object_id)).toMatchObject({ status: "ready" });
  expect(() => f.database.connection.exec("UPDATE historical_memory_captures SET state='active' WHERE state='erased'" )).toThrow();
  expect(() => copies.claims.create(createClaimForm({ object_id: randomUUID(), workspace_id: WS,
    evidence_refs: [], source_object_refs: [published.memory.object_id] }))).toThrow();
  // Identity lineage, not caller-retained refs, prevents post-GC resurrection.
  await expect(f.memoryEntryRepo.create({ ...published.memory, evidence_refs: [], lifecycle_state: "active" }))
    .rejects.toThrow();
  expect(() => f.database.connection.prepare("UPDATE synthesis_capsules SET source_memory_refs='[]',summary='restored' WHERE object_id=?")
    .run(capsule.object_id)).toThrow();
  const restoredCapsule = { ...capsule, evidence_refs: [], source_memory_refs: [] };
  f.database.connection.prepare("DELETE FROM synthesis_capsules WHERE object_id=?").run(capsule.object_id);
  await expect(f.synthesisCapsuleRepo.create(restoredCapsule)).rejects.toThrow();
  expect(f.field.fieldRepos.erase.apply(barrier(sourceId))).toEqual(receipt);
  const reopened = f.reopen();
  expect(await reopened.synthesisService.readHistoricalMember(WS, capsule.object_id, published.memory.object_id)).toEqual({ status: "erased" });
  expect(await reopened.synthesisService.readHistoricalMember(WS, independentCapsule.object_id, independent.memory.object_id)).toMatchObject({ status: "ready" });
});

it("rolls back source erase and retained descendants when downstream audit redaction fails, then retries", async () => {
  const f = await fixture();
  const published = await f.publishMember("erase-rollback", "retained secret");
  const capsule = await f.createCapsule([published.memory.object_id]);
  const copies = await downstream(f, published.memory.object_id, capsule.object_id);
  await f.sweep(); await f.sweep(true);
  f.database.connection.exec("CREATE TRIGGER reject_redaction BEFORE UPDATE OF payload_json ON event_log BEGIN SELECT RAISE(ABORT,'redaction unavailable'); END");
  expect(() => f.field.fieldRepos.erase.apply(barrier(published.source.record.identity))).toThrow();
  expect(await f.synthesisService.readHistoricalMember(WS, capsule.object_id, published.memory.object_id)).toMatchObject({ status: "ready" });
  expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM projection_erase_barriers").get()).toEqual({ n: 0 });
  await expect(f.eventLogRepo.queryByEntityAll("slot", copies.slot)).rejects.toThrow();
  const persisted = f.database.connection.prepare("SELECT payload_json FROM event_log WHERE event_id=?").get(copies.created.event_id) as { payload_json: string };
  expect(JSON.parse(persisted.payload_json)).toEqual(copies.created.payload_json);
  f.database.connection.exec("DROP TRIGGER reject_redaction");
  f.field.fieldRepos.erase.apply(barrier(published.source.record.identity));
  expect(await f.synthesisService.readHistoricalMember(WS, capsule.object_id, published.memory.object_id)).toEqual({ status: "erased" });
});

it("repairs at most 32 receipts per batch and dirties only the captured source's clean checkpoint", async () => {
  const f = await fixture();
  const published = await f.publishMember("dirty-capture", "retained secret");
  const capsule = await f.createCapsule([published.memory.object_id]);
  await f.sweep(); await f.sweep(true);
  f.field.fieldRepos.erase.apply(barrier(published.source.record.identity));
  for (let i = 0; i < 33; i++) {
    const source = await f.admit(`other-${i}`, `independent ${i}`);
    f.field.fieldRepos.erase.apply(barrier(source.record.identity));
  }
  const erase = f.field.fieldRepos.erase, apply = vi.spyOn(erase, "apply");
  expect(erase.repairSourceClosureBatch()).toBe(true);
  expect(apply).toHaveBeenCalledTimes(32);
  expect(erase.repairSourceClosureBatch()).toBe(true);
  expect(apply).toHaveBeenCalledTimes(34);
  expect(erase.repairSourceClosureBatch()).toBe(false);
  apply.mockClear();
  f.database.connection.prepare("UPDATE historical_memory_captures SET state=state WHERE memory_id=?").run(published.memory.object_id);
  const dirty = f.database.connection.prepare("SELECT barrier_id FROM source_erase_closure_progress WHERE dirty=1").all();
  expect(dirty).toEqual([{ barrier_id: barrier(published.source.record.identity).barrier_id }]);
  const receipts = f.database.connection.prepare("SELECT * FROM projection_erase_barriers ORDER BY barrier_id").all();
  const reopened = f.reopen();
  expect(reopened.database.connection.prepare("SELECT barrier_id FROM source_erase_closure_progress WHERE dirty=1").all()).toEqual([]);
  expect(reopened.database.connection.prepare("SELECT * FROM projection_erase_barriers ORDER BY barrier_id").all()).toEqual(receipts);
  expect(await reopened.synthesisService.readHistoricalMember(WS, capsule.object_id, published.memory.object_id)).toEqual({ status: "erased" });
  const replay = vi.spyOn(reopened.field.fieldRepos.erase, "apply");
  reopened.field.fieldRepos.erase.repairExistingSourceClosures();
  expect(replay).not.toHaveBeenCalled();
});
