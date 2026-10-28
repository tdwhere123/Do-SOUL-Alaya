import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createProjectionEraseBarrier, createSourceAdmissionPort, fieldContractSha256 } from "@do-soul/alaya-core";
import { CanonicalizationAppliedPayloadSchema, SoulSlotCreatedPayloadSchema, canonicalGovernanceSubject,
  sourceRecallTarget } from "@do-soul/alaya-protocol";
import { initDatabase, SqliteClaimFormRepo, SqliteConflictMatrixRepo, SqliteEventLogRepo, SqliteFieldEraseBarrierRepo,
  SqliteSlotRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { createClaimForm } from "../../../../../../packages/core/src/__tests__/governance/claim-service.test-support.js";
import { createEvidenceCapsule } from "../../../../../../packages/storage/src/__tests__/repos/capsules/evidence-capsule-repo-fixture.js";
import { createMemoryEntry } from "../../../../../../packages/storage/src/__tests__/repos/proposal/proposal-repo-fixture.js";

const NOW = "2026-05-02T00:00:00.000Z";
const ERASED_AT = "2026-05-02T01:00:00.000Z";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const C = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
const SLOT = "dddddddd-dddd-4ddd-8ddd-ddddddddddd4";
const EDGE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5";
const LEGACY_EVIDENCE = "ffffffff-ffff-4fff-8fff-fffffffffff6";
const LEGACY_CLAIM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7";
const LATER_WINNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8";
const UNKNOWN_EVIDENCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9";
const UNKNOWN_CLAIM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10";
const subject = canonicalGovernanceSubject("private", { topic: "source_secret" });
const databases = new Set<StorageDatabase>();
const directories = new Set<string>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

async function fixture(filename?: string) {
  const storage = await createRecallRealStorage(database => databases.add(database), filename);
  const repos = createDaemonFieldRepos({ database: storage.database });
  const admission = createSourceAdmissionPort({ sha256: fieldContractSha256,
    stores: createSqliteFieldFormationStores({ database: storage.database, repos }) });
  const source = admission.admit({ workspace_id: "workspace-1", source_id: "erase-claims", source_version: "1",
    content_bytes: "source_secret", evidence_object_id: null, recorded_at: NOW,
    event_time: null, valid_from: null, valid_to: null, spans: [] }).record;
  const claims = new SqliteClaimFormRepo(storage.database);
  const slots = new SqliteSlotRepo(storage.database);
  const edges = new SqliteConflictMatrixRepo(storage.database);
  const events = new SqliteEventLogRepo(storage.database);
  claims.create(createClaimForm({ object_id: A, governance_subject: subject, proposition_digest: "source_secret",
    evidence_refs: [], source_object_refs: [source.identity], claim_status: "active" }));
  claims.create(createClaimForm({ object_id: B, governance_subject: subject, proposition_digest: "independent support",
    evidence_refs: [], source_object_refs: [], claim_status: "winner" }));
  claims.create(createClaimForm({ object_id: C, proposition_digest: "derived source_secret",
    evidence_refs: [], source_object_refs: [A], claim_status: "active" }));
  edges.create({ object_id: EDGE, object_kind: "conflict_matrix_edge", schema_version: 1,
    lifecycle_state: "active", created_at: NOW, updated_at: NOW, created_by: "system",
    source_claim_id: A, target_claim_id: B, edge_type: "incompatible_with", workspace_id: "workspace-1" });
  const base = { workspace_id: "workspace-1", run_id: null, caused_by: "system" };
  const canonical = await events.append({ ...base, entity_type: "claim_form", entity_id: A,
    event_type: "canonicalization.applied", payload_json: { input: "source_secret", canonical: "source_secret",
      domain: "governance_subject.topic", was_alias_resolved: false, applied_at: NOW } });
  const created = await events.append({ ...base, entity_type: "slot", entity_id: SLOT, event_type: "soul.slot.created",
    payload_json: { object_id: SLOT, object_kind: "slot", workspace_id: "workspace-1", run_id: null,
      governance_subject: subject, claim_kind: "constraint", scope_class: "project", winner_claim_id: A } });
  slots.create({ object_id: SLOT, object_kind: "slot", schema_version: 1, lifecycle_state: "active",
    created_at: NOW, updated_at: NOW, created_by: "system", workspace_id: "workspace-1",
    governance_subject: subject, claim_kind: "constraint", scope_class: "project",
    winner_claim_id: A, incumbent_since: NOW, flip_conditions: [] }, A);
  slots.updateWinner(SLOT, B, NOW, NOW, A);
  storage.database.connection.prepare("UPDATE claim_forms SET claim_status = 'superseded' WHERE object_id = ?").run(A);
  const resolution = await events.append({ ...base, entity_type: "soul_resolution", entity_id: A,
    event_type: "soul.resolution.reject_applied", payload_json: { reason: "independent human rationale" } });
  const barrier = { barrier_id: "erase-claims", workspace_id: "workspace-1", generation_id: null,
    subject_kind: "source_record" as const, subject_id: source.identity, erased_at: ERASED_AT };
  return { ...storage, source, repos, claims, slots, edges, events, canonical, created, resolution, barrier };
}

it("scrubs linked claims and audit fields while retaining an independent current winner", async () => {
  const f = await fixture();
  f.repos.erase.apply(f.barrier);
  expect(await f.claims.findById(A)).toMatchObject({ lifecycle_state: "tombstone", claim_status: "archived",
    proposition_digest: "erased", governance_subject: { canonical_key: "erased" } });
  expect(await f.claims.findById(C)).toMatchObject({ lifecycle_state: "tombstone", proposition_digest: "erased" });
  expect(await f.claims.findById(B)).toMatchObject({ lifecycle_state: "active", proposition_digest: "independent support" });
  expect(await f.slots.findById(SLOT)).toMatchObject({ winner_claim_id: B, governance_subject: subject });
  expect(await f.edges.findById(EDGE)).toBeNull();
  const [canonical] = await f.events.queryByEntityAll("claim_form", A);
  const [created] = await f.events.queryByEntityAll("slot", SLOT);
  expect(canonical).toMatchObject({ event_id: f.canonical.event_id, revision: f.canonical.revision, created_at: f.canonical.created_at });
  expect(CanonicalizationAppliedPayloadSchema.parse(canonical!.payload_json)).toMatchObject({ input: null, canonical: null,
    domain: null, redaction: { kind: "source_erase", barrier_id: f.barrier.barrier_id } });
  expect(created).toMatchObject({ event_id: f.created.event_id, revision: f.created.revision, created_at: f.created.created_at });
  expect(SoulSlotCreatedPayloadSchema.parse(created!.payload_json)).toMatchObject({ governance_subject: null,
    winner_claim_id: A, redaction: { kind: "source_erase", barrier_id: f.barrier.barrier_id } });
  expect((await f.events.queryByEntityAll("soul_resolution", A))[0]).toEqual(f.resolution);
  expect(() => f.database.connection.prepare("UPDATE slots SET winner_claim_id = ? WHERE object_id = ?").run(A, SLOT)).toThrow();
  expect(() => f.database.connection.prepare("UPDATE claim_forms SET proposition_digest = 'restored' WHERE object_id = ?").run(A)).toThrow();
  expect(f.repos.erase.apply(f.barrier)).toEqual(expect.objectContaining({ barrier_id: f.barrier.barrier_id }));
  expect((await f.events.queryByEntityAll("slot", SLOT))[0]).toEqual(created);
});

it("rolls back the complete erase if audit redaction cannot be applied", async () => {
  const f = await fixture();
  const unsafe = new SqliteFieldEraseBarrierRepo(f.database, fieldContractSha256);
  expect(() => unsafe.apply(f.barrier)).toThrow();
  f.database.connection.exec("CREATE TRIGGER refuse_audit_redaction BEFORE UPDATE OF payload_json ON event_log BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
  expect(() => f.repos.erase.apply(f.barrier)).toThrow();
  expect(f.repos.records.findById("workspace-1", f.source.identity)?.source_body).toBe("source_secret");
  expect(await f.claims.findById(A)).toMatchObject({ lifecycle_state: "active", proposition_digest: "source_secret" });
  expect(f.database.connection.prepare("SELECT COUNT(*) AS count FROM projection_erase_barriers").get()).toEqual({ count: 0 });
  expect((await f.events.queryByEntityAll("slot", SLOT))[0]).toEqual(f.created);
});

it("clears an erased winner without redacting an independently created slot", async () => {
  const f = await fixture();
  f.database.connection.prepare(`UPDATE event_log SET payload_json = json_set(payload_json, '$.winner_claim_id', ?)
    WHERE event_id = ?`).run(B, f.created.event_id);
  f.database.connection.prepare("UPDATE slots SET subject_claim_id = ? WHERE object_id = ?").run(B, SLOT);
  f.database.connection.prepare("UPDATE slots SET winner_claim_id = ? WHERE object_id = ?").run(A, SLOT);
  const [before] = await f.events.queryByEntityAll("slot", SLOT);
  f.repos.erase.apply(f.barrier);
  expect(await f.slots.findById(SLOT)).toMatchObject({ winner_claim_id: null, governance_subject: subject });
  expect((await f.events.queryByEntityAll("slot", SLOT))[0]).toEqual(before);
  expect(await f.claims.findById(B)).toMatchObject({ proposition_digest: "independent support" });
});

it("does not rebuild an erased creator's slot from an unavailable winner", async () => {
  const f = await fixture();
  f.database.connection.prepare(`INSERT INTO privacy_dependency_quarantine(workspace_id, object_kind, object_id)
    VALUES ('workspace-1', 'claim_form', ?)`).run(B);
  f.repos.erase.apply(f.barrier);
  expect(await f.slots.findById(SLOT)).toBeNull();
  expect(f.database.connection.prepare("SELECT proposition_digest FROM claim_forms WHERE object_id = ?").get(B))
    .toEqual({ proposition_digest: "independent support" });
  expect((await f.events.queryByEntityAll("slot", SLOT))[0]).toMatchObject({
    payload_json: { governance_subject: null, redaction: { barrier_id: f.barrier.barrier_id } }
  });
});

it.each(["missing", "null"] as const)("quarantines a slot with %s creation provenance without deleting its subject", async mode => {
  const f = await fixture();
  f.database.connection.prepare("UPDATE slots SET winner_claim_id = ?, subject_claim_id = NULL WHERE object_id = ?").run(A, SLOT);
  if (mode === "missing") {
    f.database.connection.prepare("DELETE FROM event_log WHERE event_id = ?").run(f.created.event_id);
  } else {
    f.database.connection.prepare(`UPDATE event_log SET payload_json = json_set(payload_json, '$.winner_claim_id', NULL)
      WHERE event_id = ?`).run(f.created.event_id);
  }
  f.repos.erase.apply(f.barrier);
  expect(f.database.connection.prepare("SELECT winner_claim_id, governance_subject FROM slots WHERE object_id = ?").get(SLOT))
    .toEqual({ winner_claim_id: null, governance_subject: JSON.stringify(subject) });
  expect(f.database.connection.prepare(`SELECT reason FROM privacy_current_quarantine
    WHERE workspace_id = 'workspace-1' AND object_kind = 'slot' AND object_id = ?`).get(SLOT))
    .toEqual({ reason: "unavailable_dependency" });
  await expect(f.slots.findById(SLOT)).rejects.toThrow();
});

it("tracks a rebuilt subject through a later winner change and a second source erase", async () => {
  const f = await fixture();
  const admission = createSourceAdmissionPort({ sha256: fieldContractSha256,
    stores: createSqliteFieldFormationStores({ database: f.database, repos: f.repos }) });
  const second = admission.admit({ workspace_id: "workspace-1", source_id: "independent-second", source_version: "1",
    content_bytes: "independent support", evidence_object_id: null, recorded_at: NOW,
    event_time: null, valid_from: null, valid_to: null, spans: [] }).record;
  f.database.connection.prepare("UPDATE claim_forms SET source_object_refs = ? WHERE object_id = ?")
    .run(JSON.stringify([second.identity]), B);
  f.repos.erase.apply(f.barrier);
  expect(f.database.connection.prepare("SELECT subject_claim_id FROM slots WHERE object_id = ?").get(SLOT))
    .toEqual({ subject_claim_id: B });
  f.claims.create(createClaimForm({ object_id: LATER_WINNER, governance_subject: subject, proposition_digest: "third support",
    evidence_refs: [], source_object_refs: [], claim_status: "winner" }));
  f.slots.updateWinner(SLOT, LATER_WINNER, NOW, ERASED_AT, B);
  f.repos.erase.apply({ ...f.barrier, barrier_id: "erase-second-source", subject_id: second.identity,
    erased_at: "2026-05-02T02:00:00.000Z" });
  expect(await f.slots.findById(SLOT)).toMatchObject({ winner_claim_id: LATER_WINNER, governance_subject: subject });
  expect(f.database.connection.prepare("SELECT subject_claim_id FROM slots WHERE object_id = ?").get(SLOT))
    .toEqual({ subject_claim_id: LATER_WINNER });
  expect(await f.claims.findById(B)).toMatchObject({ lifecycle_state: "tombstone", proposition_digest: "erased" });
  expect(await f.claims.findById(LATER_WINNER)).toMatchObject({ lifecycle_state: "active", proposition_digest: "third support" });
});

it("does not confuse an erased memory ID with an independent evidence ID", async () => {
  const f = await fixture();
  const derivedEvidence = "11111111-1111-4111-8111-111111111111";
  const sharedId = "22222222-2222-4222-8222-222222222222";
  const independentClaim = "33333333-3333-4333-8333-333333333333";
  const target = sourceRecallTarget({ workspace_id: "workspace-1", root_kind: "source_record", root_id: f.source.identity,
    source_version: f.source.source_version, content_digest: f.source.content_digest, evidence_object_id: null });
  await f.evidenceCapsuleRepo.create(createEvidenceCapsule({ object_id: derivedEvidence,
    gist: JSON.stringify({ contract: "published-source-interpretation-v4", source_target: target, text: "source_secret" }) }));
  await f.evidenceCapsuleRepo.create(createEvidenceCapsule({ object_id: sharedId, gist: "independent evidence" }));
  await f.memoryEntryRepo.create(createMemoryEntry({ object_id: sharedId, evidence_refs: [derivedEvidence], content: "source_secret" }));
  f.claims.create(createClaimForm({ object_id: independentClaim, proposition_digest: "independent claim",
    evidence_refs: [sharedId], source_object_refs: [], claim_status: "active" }));
  f.repos.erase.apply(f.barrier);
  expect((await f.memoryEntryRepo.findById(sharedId))?.lifecycle_state).toBe("tombstone");
  expect((await f.evidenceCapsuleRepo.findById(sharedId))?.lifecycle_state).toBe("active");
  expect(await f.claims.findById(independentClaim)).toMatchObject({ lifecycle_state: "active", proposition_digest: "independent claim" });
});

it("repairs an attributable historical barrier on reopen without reauthoring its receipt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alaya-source-erase-repair-"));
  directories.add(directory);
  const filename = join(directory, "alaya.db");
  const f = await fixture(filename);
  await f.evidenceCapsuleRepo.create(createEvidenceCapsule({ object_id: LEGACY_EVIDENCE, gist: "source_secret" }));
  await f.evidenceCapsuleRepo.create(createEvidenceCapsule({ object_id: UNKNOWN_EVIDENCE, gist: "unattributed historical text" }));
  f.claims.create(createClaimForm({ object_id: LEGACY_CLAIM, proposition_digest: "legacy source_secret",
    evidence_refs: [LEGACY_EVIDENCE], source_object_refs: [], claim_status: "active" }));
  f.claims.create(createClaimForm({ object_id: UNKNOWN_CLAIM, proposition_digest: "unattributed historical text",
    evidence_refs: [UNKNOWN_EVIDENCE], source_object_refs: [], claim_status: "active" }));
  await f.events.append({ workspace_id: "workspace-1", run_id: "run-1", caused_by: "reviewer",
    entity_type: "evidence_capsule", entity_id: LEGACY_EVIDENCE, event_type: "source.interpretation.invalidated",
    payload_json: { workspace_id: "workspace-1", run_id: "run-1", source_interpretation_id: `sha256:${"a".repeat(64)}`,
      source: { source_id: f.source.source_id, source_version: f.source.source_version, content_digest: f.source.content_digest },
      evidence_object_id: LEGACY_EVIDENCE, error_basis: { reason: "independent review" }, provenance: { reporter_id: "reviewer" },
      authorized_scopes: { mode: "unrestricted" }, from_state: "active", to_state: "archived",
      semantic_status: "unreviewed", occurred_at: NOW } });
  await f.events.append({ workspace_id: "workspace-1", run_id: "run-1", caused_by: "reviewer",
    entity_type: "evidence_capsule", entity_id: UNKNOWN_EVIDENCE, event_type: "source.interpretation.invalidated",
    payload_json: { workspace_id: "workspace-1", run_id: "run-1", source_interpretation_id: `sha256:${"b".repeat(64)}`,
      source: { source_id: f.source.source_id, source_version: f.source.source_version, content_digest: f.source.content_digest },
      evidence_object_id: LEGACY_EVIDENCE, error_basis: { reason: "independent review" }, provenance: { reporter_id: "reviewer" },
      authorized_scopes: { mode: "unrestricted" }, from_state: "active", to_state: "archived",
      semantic_status: "unreviewed", occurred_at: NOW } });
  const receipt = createProjectionEraseBarrier(f.barrier, fieldContractSha256);
  f.database.connection.prepare(`INSERT INTO projection_erase_barriers
    (barrier_id, receipt_identity, workspace_id, generation_id, subject_kind, subject_id, erased_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(receipt.barrier_id, receipt.identity, receipt.workspace_id,
      receipt.generation_id, receipt.subject_kind, receipt.subject_id, receipt.erased_at);
  f.database.connection.prepare("UPDATE source_records SET source_body = NULL WHERE workspace_id = ? AND record_id = ?")
    .run("workspace-1", f.source.identity);
  f.database.connection.prepare(`UPDATE evidence_capsules SET lifecycle_state = 'tombstone', evidence_health_state = 'broken',
    gist = 'erased', excerpt = NULL, source_hash = NULL WHERE object_id IN (?, ?)`).run(LEGACY_EVIDENCE, UNKNOWN_EVIDENCE);
  const migrationTriggers = [
    "synthesis_capsules_reject_tombstoned_evidence_insert", "synthesis_capsules_reject_tombstoned_evidence_update",
    "synthesis_capsules_reject_tombstoned_content_update", "claim_forms_reject_tombstoned_content_update",
    "claim_forms_reject_tombstoned_dependencies_insert", "claim_forms_reject_tombstoned_dependencies_update",
    "conflict_edges_reject_tombstoned_claim_insert", "conflict_edges_reject_tombstoned_claim_update",
    "slots_reject_tombstoned_winner_insert", "slots_reject_tombstoned_winner_update",
    "slots_require_subject_creation_provenance", "slots_require_subject_rebuild_provenance"
  ];
  for (const trigger of migrationTriggers) f.database.connection.exec(`DROP TRIGGER ${trigger}`);
  const quarantineTriggers = f.database.connection.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND (
    name GLOB 'quarantine_*' OR name GLOB 'claim_reject_unknown_*' OR name GLOB 'synthesis_reject_unknown_*'
    OR name GLOB 'slot_reject_unknown_*' OR name GLOB 'edge_reject_unknown_*')`).all() as { name: string }[];
  for (const trigger of quarantineTriggers) f.database.connection.exec(`DROP TRIGGER ${trigger.name}`);
  f.database.connection.exec("DROP VIEW privacy_current_quarantine");
  f.database.connection.exec("DROP VIEW privacy_dependency_candidates");
  f.database.connection.exec("DROP TABLE privacy_dependency_quarantine");
  f.database.connection.exec("ALTER TABLE slots DROP COLUMN subject_claim_id");
  f.database.connection.prepare("DELETE FROM schema_version WHERE version IN (35, 36)").run();
  f.database.close();
  const reopened = initDatabase({ filename });
  databases.add(reopened);
  createDaemonFieldRepos({ database: reopened });
  const claims = new SqliteClaimFormRepo(reopened);
  const events = new SqliteEventLogRepo(reopened);
  expect(await claims.findById(A)).toMatchObject({ lifecycle_state: "tombstone", proposition_digest: "erased" });
  expect(await claims.findById(LEGACY_CLAIM)).toMatchObject({ lifecycle_state: "tombstone", proposition_digest: "erased" });
  expect(reopened.connection.prepare("SELECT lifecycle_state, proposition_digest FROM claim_forms WHERE object_id = ?")
    .get(UNKNOWN_CLAIM)).toEqual({ lifecycle_state: "active", proposition_digest: "unattributed historical text" });
  await expect(claims.findById(UNKNOWN_CLAIM)).rejects.toThrow();
  expect(await claims.findById(B)).toMatchObject({ lifecycle_state: "active", proposition_digest: "independent support" });
  expect((await events.queryByEntityAll("slot", SLOT))[0]).toMatchObject({ event_id: f.created.event_id,
    payload_json: { governance_subject: null, redaction: { barrier_id: receipt.barrier_id } } });
  expect(reopened.connection.prepare("SELECT COUNT(*) AS count FROM projection_erase_barriers").get()).toEqual({ count: 1 });
});
