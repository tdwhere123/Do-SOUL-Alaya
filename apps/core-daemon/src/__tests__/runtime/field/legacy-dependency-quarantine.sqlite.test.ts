import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { canonicalGovernanceSubject } from "@do-soul/alaya-protocol";
import { initDatabase, scanObjectKeyRetrofitSources, SqliteClaimFormRepo, SqliteEventLogRepo, SqliteMemoryEntryRepo,
  SqliteMemoryObjectKeyRepo, SqliteSlotRepo, SqliteSynthesisCapsuleRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { createClaimForm } from "../../../../../../packages/core/src/__tests__/governance/claim-service.test-support.js";
import { createEvidenceCapsule } from "../../../../../../packages/storage/src/__tests__/repos/capsules/evidence-capsule-repo-fixture.js";
import { createMemoryEntry, createSynthesisCapsule } from "../../../../../../packages/storage/src/__tests__/repos/proposal/proposal-repo-fixture.js";
import { SqliteMemoryRecallReader } from "../../../../../../packages/storage/src/repos/memory-entry/reads/bounded-recall-reader.js";
import { readBoundedActiveConstraints } from "../../../../../../packages/storage/src/repos/governance/reads/bounded-active-constraints.js";
import { createGardenBackgroundDataPorts } from "../../../../../../packages/storage/src/repos/garden/garden-data-ports.js";

const EVIDENCE = "00000000-0000-4000-8000-000000000101";
const MEMORY = "00000000-0000-4000-8000-000000000102";
const SYNTHESIS = "00000000-0000-4000-8000-000000000103";
const CLAIM = "00000000-0000-4000-8000-000000000104";
const SLOT = "00000000-0000-4000-8000-000000000105";
const HEALTHY_MEMORY = "00000000-0000-4000-8000-000000000106";
const HEALTHY_CLAIM = "00000000-0000-4000-8000-000000000107";
const HEALTHY_SYNTHESIS = "00000000-0000-4000-8000-000000000108";
const NOW = "2026-05-02T00:00:00.000Z";
const tracked = new Set<StorageDatabase>();
const directories = new Set<string>();

afterEach(() => {
  for (const database of tracked) database.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  tracked.clear();
  directories.clear();
});

it("quarantines unindexed tombstone descendants on upgrade and retains independent records", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alaya-legacy-quarantine-"));
  directories.add(directory);
  const filename = join(directory, "alaya.db");
  const f = await createRecallRealStorage(database => tracked.add(database), filename);
  const syntheses = new SqliteSynthesisCapsuleRepo(f.database);
  const claims = new SqliteClaimFormRepo(f.database);
  const events = new SqliteEventLogRepo(f.database);
  const slots = new SqliteSlotRepo(f.database);
  const subject = canonicalGovernanceSubject("legacy", { topic: "copied secret" });
  await f.evidenceCapsuleRepo.create(createEvidenceCapsule({ object_id: EVIDENCE, gist: "copied secret" }));
  await f.memoryEntryRepo.create(createMemoryEntry({ object_id: MEMORY, content: "copied secret", evidence_refs: [EVIDENCE] }));
  await f.memoryEntryRepo.create(createMemoryEntry({ object_id: HEALTHY_MEMORY, content: "independent", evidence_refs: [] }));
  await syntheses.create(createSynthesisCapsule({ object_id: SYNTHESIS, summary: "copied secret",
    evidence_refs: [], source_memory_refs: [MEMORY] }));
  await syntheses.create(createSynthesisCapsule({ object_id: HEALTHY_SYNTHESIS, summary: "independent synthesis",
    evidence_refs: [], source_memory_refs: [] }));
  claims.create(createClaimForm({ object_id: CLAIM, governance_subject: subject, proposition_digest: "copied secret",
    source_object_refs: [SYNTHESIS], evidence_refs: [], claim_status: "winner" }));
  claims.create(createClaimForm({ object_id: HEALTHY_CLAIM, proposition_digest: "independent claim",
    source_object_refs: [], evidence_refs: [], claim_status: "active" }));
  await events.append({ workspace_id: "workspace-1", run_id: null, caused_by: "system", entity_type: "claim_form",
    entity_id: CLAIM, event_type: "canonicalization.applied", payload_json: { input: "copied secret", canonical: "copied secret",
      domain: "governance_subject.topic", was_alias_resolved: false, applied_at: NOW } });
  await events.append({ workspace_id: "workspace-1", run_id: null, caused_by: "system", entity_type: "slot",
    entity_id: SLOT, event_type: "soul.slot.created", payload_json: { object_id: SLOT, object_kind: "slot",
      workspace_id: "workspace-1", run_id: null, governance_subject: subject, claim_kind: "constraint",
      scope_class: "project", winner_claim_id: CLAIM } });
  slots.create({ object_id: SLOT, object_kind: "slot", schema_version: 1, lifecycle_state: "active",
    created_at: NOW, updated_at: NOW, created_by: "system", workspace_id: "workspace-1", governance_subject: subject,
    claim_kind: "constraint", scope_class: "project", winner_claim_id: CLAIM, incumbent_since: NOW, flip_conditions: [] }, CLAIM);

  removeQuarantineMigration(f.database);
  f.database.connection.prepare(`UPDATE evidence_capsules SET lifecycle_state = 'tombstone',
    evidence_health_state = 'broken', gist = 'erased', excerpt = NULL, source_hash = NULL WHERE object_id = ?`).run(EVIDENCE);
  expect(f.database.connection.prepare("SELECT COUNT(*) AS count FROM source_record_evidence_refs WHERE evidence_object_id = ?").get(EVIDENCE))
    .toEqual({ count: 0 });
  f.database.close();

  const reopened = initDatabase({ filename });
  tracked.add(reopened);
  const memory = new SqliteMemoryEntryRepo(reopened);
  const synthesis = new SqliteSynthesisCapsuleRepo(reopened);
  const claim = new SqliteClaimFormRepo(reopened);
  const slot = new SqliteSlotRepo(reopened);
  const audit = new SqliteEventLogRepo(reopened);
  await expect(memory.findById(MEMORY)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(synthesis.findById(SYNTHESIS)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(claim.findById(CLAIM)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(slot.findById(SLOT)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(audit.queryByEntityAll("claim_form", CLAIM)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(audit.queryByEntityAll("slot", SLOT)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(claim.findByWorkspaceId("workspace-1")).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(memory.updateDynamics(MEMORY, {
    activation_score: 0.1, retention_score: 0.8, manifestation_state: "full_eligible"
  }, NOW)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(() => claim.updateStatusSync(CLAIM, "active", NOW, "winner")).toThrow(/provenance/u);
  expect(() => slot.updateWinner(SLOT, HEALTHY_CLAIM, NOW, NOW, CLAIM)).toThrow(/provenance/u);
  expect(() => reopened.connection.prepare("UPDATE memory_entries SET content = 'stale caller text' WHERE object_id = ?")
    .run(MEMORY)).toThrow(/provenance unavailable/u);
  expect(reopened.connection.prepare("SELECT content, activation_score FROM memory_entries WHERE object_id = ?").get(MEMORY))
    .toEqual({ content: "copied secret", activation_score: 0.9 });
  expect(reopened.connection.prepare("SELECT claim_status FROM claim_forms WHERE object_id = ?").get(CLAIM))
    .toEqual({ claim_status: "winner" });
  expect(await memory.findById(HEALTHY_MEMORY)).toMatchObject({ content: "independent" });
  expect(await synthesis.findById(HEALTHY_SYNTHESIS)).toMatchObject({ summary: "independent synthesis" });
  expect(await claim.findById(HEALTHY_CLAIM)).toMatchObject({ proposition_digest: "independent claim" });
  expect(new SqliteMemoryRecallReader(reopened).source("workspace-1", MEMORY)).toMatchObject({ row: null, unavailable: true });
  const keys = new SqliteMemoryObjectKeyRepo(reopened);
  expect(() => keys.listByOwner("workspace-1", MEMORY)).toThrow(/provenance/u);
  expect(keys.listByOwner("workspace-1", HEALTHY_MEMORY)).toEqual([]);
  expect(() => scanObjectKeyRetrofitSources(reopened)).toThrow(/provenance/u);
  const constraints = readBoundedActiveConstraints(reopened, { workspaceId: "workspace-1", snapshotId: "snapshot-1",
    asOf: "2026-05-19T00:00:00.000Z", authorizedScopes: { mode: "unrestricted" }, cap: 20, nativeLimit: 128,
    byteLimit: 65536 }, () => ({ rows: [], rowsRead: 0, bytesRead: 0, truncated: false, unavailable: false, temporalUncertain: false }));
  expect(constraints).toMatchObject({ completeness: "incomplete", total_count: null });
  expect(constraints.constraints.some((value) => value.object_id === MEMORY)).toBe(false);
  await expect(createGardenBackgroundDataPorts(reopened).neighborPort.findSubjectNeighbors("workspace-1"))
    .rejects.toMatchObject({ code: "CONFLICT" });
  expect(() => reopened.connection.prepare("UPDATE slots SET winner_claim_id = ? WHERE object_id = ?")
    .run(HEALTHY_CLAIM, SLOT)).toThrow(/provenance unavailable/u);
  reopened.connection.prepare("UPDATE slots SET winner_claim_id = NULL WHERE object_id = ?").run(SLOT);
  await expect(slot.findById(SLOT)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(reopened.connection.prepare("SELECT COUNT(*) AS count FROM projection_erase_barriers").get()).toEqual({ count: 0 });

  // Removing refs cannot make a retained, previously copied payload safe.
  reopened.connection.prepare("UPDATE memory_entries SET evidence_refs = '[]' WHERE object_id = ?").run(MEMORY);
  reopened.connection.prepare("UPDATE synthesis_capsules SET source_memory_refs = '[]' WHERE object_id = ?").run(SYNTHESIS);
  reopened.connection.prepare("UPDATE claim_forms SET source_object_refs = '[]' WHERE object_id = ?").run(CLAIM);
  reopened.close();
  const again = initDatabase({ filename });
  tracked.add(again);
  await expect(new SqliteClaimFormRepo(again).findById(CLAIM)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await new SqliteMemoryEntryRepo(again).findById(HEALTHY_MEMORY)).toMatchObject({ content: "independent" });
});

function removeQuarantineMigration(database: StorageDatabase): void {
  const triggers = database.connection.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND
    (name GLOB 'quarantine_*' OR name GLOB 'claim_reject_unknown_*' OR name GLOB 'synthesis_reject_unknown_*'
    OR name GLOB 'slot_reject_unknown_*' OR name GLOB 'edge_reject_unknown_*')`).all() as { name: string }[];
  for (const trigger of triggers) database.connection.exec(`DROP TRIGGER ${trigger.name}`);
  database.connection.exec("DROP VIEW privacy_current_quarantine; DROP VIEW privacy_dependency_candidates; DROP TABLE privacy_dependency_quarantine");
  database.connection.prepare("DELETE FROM schema_version WHERE version = 36").run();
}
