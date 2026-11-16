import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalGovernanceSubject, type SourceStatementContextSource } from "@do-soul/alaya-protocol";
import { SqliteClaimFormRepo, SqliteSlotRepo } from "@do-soul/alaya-storage";
import { createClaimForm } from "../../../../../packages/core/src/__tests__/governance/claim-service.test-support.js";
import { createPreservationFixture, PRESERVATION_WORKSPACE as WS, PRESERVATION_CLOCK as CLOCK } from "./independent-preservation.test-support.js";

const fixtures: Awaited<ReturnType<typeof createPreservationFixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures) await f.dispose(); fixtures.length = 0; });
async function fixture() { const f = await createPreservationFixture(); fixtures.push(f); return f; }
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
