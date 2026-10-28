import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaimService, createGardenProposalWriter, createSourceAdmissionPort, DynamicsService, EventPublisher, fieldContractSha256 } from "@do-soul/alaya-core";
import { GardenTaskKind, GardenTier, sourceRecallTarget, type GardenTaskDescriptor } from "@do-soul/alaya-protocol";
import { createGardenBackgroundDataPorts, SqliteClaimFormRepo, SqliteConflictMatrixRepo, SqliteEventLogRepo, SqliteKarmaEventRepo,
  SqliteProposalRepo, SqliteSynthesisCapsuleRepo, StorageDatabase } from "@do-soul/alaya-storage";
import { openSqliteConnection } from "@do-soul/alaya-storage/sqlite/open-sqlite-connection";
import { Auditor, Librarian } from "@do-soul/alaya-soul";
import { createMcpMemoryProposalWorkflow } from "../../../mcp-memory/proposal/proposal-workflow.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { createEvidenceCapsule } from "../../../../../../packages/storage/src/__tests__/repos/capsules/evidence-capsule-repo-fixture.js";
import { createMemoryEntry, createSynthesisCapsule, trackedDatabases } from "../../../../../../packages/storage/src/__tests__/repos/proposal/proposal-repo-fixture.js";
import { createClaimForm, createClaimInput } from "../../../../../../packages/core/src/__tests__/governance/claim-service.test-support.js";

afterEach(() => { for (const db of trackedDatabases) db.close(); trackedDatabases.clear(); });
const NOW = "2026-05-02T00:00:00.000Z";
const context = { workspaceId: "workspace-1", runId: null, agentTarget: "inspector", sessionId: "review" };

async function fixture(filename?: string, afterGist?: (id: string) => void) {
  const storage = await createRecallRealStorage(db => trackedDatabases.add(db), filename);
  const eventLogRepo = new SqliteEventLogRepo(storage.database);
  const notifier = { notify: () => undefined, notifyEntry: () => undefined };
  const eventPublisher = new EventPublisher({ eventLogRepo, runtimeNotifier: notifier, runHotStateService: { apply: () => undefined } });
  const proposalRepo = new SqliteProposalRepo(storage.database);
  const ports = createGardenBackgroundDataPorts(storage.database, { now: () => NOW,
    proposalWriter: createGardenProposalWriter({ proposalRepo, eventPublisher, now: () => NOW }) });
  const karma = new SqliteKarmaEventRepo(storage.database);
  const dynamics = new DynamicsService({ memoryRepo: storage.memoryEntryRepo, karmaEventRepo: karma, eventLogRepo,
    runtimeNotifier: notifier, now: () => NOW });
  const workflow = createMcpMemoryProposalWorkflow({ proposalRepo, eventLogRepo, runtimeNotifier: notifier,
    dynamicsService: dynamics, now: () => NOW, reviewerIdentityBinding: { identity: "user:reviewer", token: "reviewer-token" },
    synthesisEvidenceReader: { findGistById: async (id, workspace) => {
      const evidence = await storage.evidenceCapsuleRepo.findById(id);
      const gist = evidence?.workspace_id === workspace ? evidence.gist : null;
      afterGist?.(id);
      return gist;
    } } });
  const capsules = new SqliteSynthesisCapsuleRepo(storage.database);
  return { ...storage, eventLogRepo, eventPublisher, ports, proposalRepo, karma, workflow, capsules };
}

function task(kind: GardenTaskDescriptor["task_kind"]): GardenTaskDescriptor {
  return { task_id: `task-${kind}`, task_kind: kind, required_tier: GardenTier.TIER_2,
    workspace_id: "workspace-1", run_id: "run-1", target_object_refs: [], priority: 10, created_at: NOW };
}

async function assertCreation(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const scoped = await f.proposalRepo.findScopedById(id);
  expect(scoped).not.toBeNull();
  const events = await f.eventLogRepo.queryByEntityAll("proposal", id);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ event_type: "soul.proposal.created", entity_id: id,
    workspace_id: "workspace-1", payload_json: { object_id: scoped!.proposal.runtime_id, object_kind: "proposal" } });
  return scoped!;
}

it("audits the Librarian producer and accepts its evidence-backed synthesis without synthetic-target karma", async () => {
  const f = await fixture();
  const evidenceIds = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2"];
  for (const [index, id] of evidenceIds.entries()) await f.evidenceCapsuleRepo.create(createEvidenceCapsule({
    object_id: id, gist: `Evidence ${index}`, semantic_anchor: { topic: "tooling", keywords: [], summary: "tooling" }
  }));
  const prior = await f.capsules.create(createSynthesisCapsule({ topic_key: "tooling", evidence_refs: [] }));
  const librarian = new Librarian({ neighborPort: f.ports.neighborPort, synthesisPort: f.ports.synthesisPort,
    scheduler: { reportCompletion: async () => undefined }, now: () => NOW });
  const result = await librarian.run(task(GardenTaskKind.SYNTHESIS_REVIEW));
  expect(result.success).toBe(true);
  expect(result.objects_affected).toHaveLength(1);
  const id = result.objects_affected[0]!;
  const scoped = await assertCreation(f, id);
  expect(scoped.proposal.derived_from).toBe("synthesis-subject:tooling");
  await expect(f.workflow.reviewMemoryProposal({ proposal_id: id, verdict: "accept", reason: null,
    reviewer_identity: "user:reviewer", reviewer_token: "reviewer-token" }, context)).resolves.toMatchObject({ resolution_state: "accepted" });
  const capsules = await f.capsules.findByWorkspaceId("workspace-1");
  expect(capsules).toHaveLength(2);
  const created = capsules.find(capsule => capsule.object_id !== prior.object_id);
  expect(created).toMatchObject({ topic_key: "tooling", evidence_refs: evidenceIds, synthesis_status: "working" });
  expect(created!.summary).toContain("Evidence 0");
  expect(await f.karma.findByObjectId(scoped.proposal.derived_from!)).toEqual([]);
});

it("audits the Auditor producer and supports both empty-evidence acceptance and rejection", async () => {
  const f = await fixture();
  for (let index = 1; index <= 3; index++) await f.memoryEntryRepo.create(createMemoryEntry({
    object_id: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${index}`, content: "A repeated pattern", evidence_refs: []
  }));
  const auditor = new Auditor({ evidenceCheckPort: f.ports.evidenceCheckPort, pointerHealthPort: f.ports.pointerHealthPort,
    greenMaintenancePort: f.ports.greenMaintenancePort, bootstrappingPort: f.ports.bootstrappingPort,
    scheduler: { reportCompletion: async () => undefined }, now: () => NOW });
  const run = () => auditor.run(task(GardenTaskKind.CRYSTALLIZATION_SCAN));
  const first = await run();
  expect(first.success).toBe(true);
  expect(first.objects_affected).toHaveLength(1);
  const accepted = await assertCreation(f, first.objects_affected[0]!);
  await f.workflow.reviewMemoryProposal({ proposal_id: accepted.proposal.proposal_id, verdict: "accept", reason: null,
    reviewer_identity: "user:reviewer", reviewer_token: "reviewer-token" }, context);
  const capsules = await f.capsules.findByWorkspaceId("workspace-1");
  expect(capsules).toHaveLength(1);
  expect(capsules[0]).toMatchObject({ evidence_refs: [], synthesis_status: "working" });
  expect(capsules[0]!.summary).toContain("no member evidence");
  const second = await run();
  const rejected = await assertCreation(f, second.objects_affected[0]!);
  await expect(f.workflow.reviewMemoryProposal({ proposal_id: rejected.proposal.proposal_id, verdict: "reject", reason: null,
    reviewer_identity: "user:reviewer", reviewer_token: "reviewer-token" }, context)).resolves.toMatchObject({ resolution_state: "rejected" });
  expect(await f.karma.findByObjectId(rejected.proposal.derived_from!)).toEqual([]);
  expect(await f.capsules.findByWorkspaceId("workspace-1")).toHaveLength(1);
});

it("rolls back the creation audit when the proposal insert fails", async () => {
  const f = await fixture();
  f.database.connection.exec(`CREATE TRIGGER refuse_garden_proposal BEFORE INSERT ON proposals
    BEGIN SELECT RAISE(ABORT, 'proposal unavailable'); END;`);
  await expect(f.ports.synthesisPort.createSynthesisReviewCandidate("workspace-1", "tooling", [] )).rejects.toThrow();
  expect(await f.eventLogRepo.queryByTypeAll("soul.proposal.created")).toEqual([]);
  expect(f.database.connection.prepare("SELECT COUNT(*) AS count FROM proposals").get()).toEqual({ count: 0 });
});

it("rolls back synthesis acceptance when an unindexed source interpretation is erased after its gist is read", async () => {
  const privateId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
  let eraseAfterRead = (_id: string) => {};
  const f = await fixture(undefined, id => eraseAfterRead(id));
  const repos = createDaemonFieldRepos({ database: f.database });
  const admission = createSourceAdmissionPort({ sha256: fieldContractSha256,
    stores: createSqliteFieldFormationStores({ database: f.database, repos }) });
  const source = admission.admit({ workspace_id: "workspace-1", source_id: "private-synthesis", source_version: "1",
    content_bytes: "private synthesis content", evidence_object_id: null, recorded_at: NOW,
    event_time: null, valid_from: null, valid_to: null, spans: [] }).record;
  const target = sourceRecallTarget({ workspace_id: source.workspace_id, root_kind: "source_record", root_id: source.identity,
    source_version: source.source_version, content_digest: source.content_digest, evidence_object_id: null });
  await f.evidenceCapsuleRepo.create(createEvidenceCapsule({ object_id: privateId,
    semantic_anchor: { topic: "privacy", keywords: [], summary: "privacy" },
    gist: JSON.stringify({ contract: "published-source-interpretation-v4", source_target: target, text: "private synthesis content" }) }));
  await f.evidenceCapsuleRepo.create(createEvidenceCapsule({ object_id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc2",
    semantic_anchor: { topic: "privacy", keywords: [], summary: "privacy" }, gist: "other evidence" }));
  expect(f.database.connection.prepare("SELECT COUNT(*) AS count FROM source_record_evidence_refs WHERE evidence_object_id = ?")
    .get(privateId)).toEqual({ count: 0 });
  const librarian = new Librarian({ neighborPort: f.ports.neighborPort, synthesisPort: f.ports.synthesisPort,
    scheduler: { reportCompletion: async () => undefined }, now: () => NOW });
  const result = await librarian.run(task(GardenTaskKind.SYNTHESIS_REVIEW));
  const id = result.objects_affected[0]!;
  await assertCreation(f, id);
  eraseAfterRead = evidenceId => {
    if (evidenceId !== privateId) return;
    eraseAfterRead = () => {};
    repos.erase.apply({ barrier_id: "erase-during-synthesis-review", workspace_id: "workspace-1", generation_id: null,
      subject_kind: "source_record", subject_id: source.identity, erased_at: "2026-05-02T00:00:01.000Z" });
  };
  await expect(f.workflow.reviewMemoryProposal({ proposal_id: id, verdict: "accept", reason: null,
    reviewer_identity: "user:reviewer", reviewer_token: "reviewer-token" }, context)).rejects.toThrow();
  expect((await f.evidenceCapsuleRepo.findById(privateId))?.lifecycle_state).toBe("tombstone");
  expect((await f.proposalRepo.findById(id))?.resolution_state).toBe("pending");
  expect(await f.capsules.findByWorkspaceId("workspace-1")).toEqual([]);
  expect((await f.eventLogRepo.queryByEntityAll("proposal", id)).map(event => event.event_type)).toEqual(["soul.proposal.created"]);
});

it("does not commit a claim after its evidence-backed memory is erased", async () => {
  const f = await fixture();
  const repos = createDaemonFieldRepos({ database: f.database });
  const admission = createSourceAdmissionPort({ sha256: fieldContractSha256,
    stores: createSqliteFieldFormationStores({ database: f.database, repos }) });
  const source = admission.admit({ workspace_id: "workspace-1", source_id: "private-claim", source_version: "1",
    content_bytes: "private claim content", evidence_object_id: null, recorded_at: NOW,
    event_time: null, valid_from: null, valid_to: null, spans: [] }).record;
  const target = sourceRecallTarget({ workspace_id: source.workspace_id, root_kind: "source_record", root_id: source.identity,
    source_version: source.source_version, content_digest: source.content_digest, evidence_object_id: null });
  const evidenceId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
  await f.evidenceCapsuleRepo.create(createEvidenceCapsule({ object_id: evidenceId,
    gist: JSON.stringify({ contract: "published-source-interpretation-v4", source_target: target, text: "private claim content" }) }));
  const memory = await f.memoryEntryRepo.create(createMemoryEntry({ evidence_refs: [evidenceId], content: "private claim content" }));
  const claimId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
  const claimRepo = new SqliteClaimFormRepo(f.database);
  const claimService = new ClaimService({ claimFormRepo: claimRepo, eventLogRepo: f.eventLogRepo,
    eventPublisher: f.eventPublisher, runtimeNotifier: { notifyEntry: () => undefined }, generateObjectId: () => claimId, now: () => NOW });
  repos.erase.apply({ barrier_id: "erase-before-claim", workspace_id: "workspace-1", generation_id: null,
    subject_kind: "source_record", subject_id: source.identity, erased_at: "2026-05-02T00:00:01.000Z" });
  expect((await f.memoryEntryRepo.findById(memory.object_id))?.lifecycle_state).toBe("tombstone");
  await expect(claimService.create(createClaimInput({ proposition_digest: "private claim content", evidence_refs: [evidenceId],
    source_object_refs: [memory.object_id] }))).rejects.toThrow();
  expect(await claimRepo.findById(claimId)).toBeNull();
  expect(await f.eventLogRepo.queryByEntityAll("claim_form", claimId)).toEqual([]);
});

it("prevents stale writers from restoring tombstoned synthesis and claim content or edges", async () => {
  const f = await fixture();
  const claimRepo = new SqliteClaimFormRepo(f.database);
  const erasedId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
  const activeId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2";
  claimRepo.create(createClaimForm({ object_id: activeId, evidence_refs: [], source_object_refs: [] }));
  claimRepo.create(createClaimForm({ object_id: erasedId, lifecycle_state: "tombstone", claim_status: "archived",
    proposition_digest: "erased", evidence_refs: [], source_object_refs: [activeId],
    governance_subject: { subject_domain: "erased", subject_qualifiers: {}, canonical_key: "erased" } }));
  const erasedSynthesis = await f.capsules.create(createSynthesisCapsule({ lifecycle_state: "tombstone",
    synthesis_status: "archived", topic_key: "erased", summary: "erased", evidence_refs: [], source_memory_refs: [activeId] }));
  expect(() => f.database.connection.prepare("UPDATE claim_forms SET governance_subject = ? WHERE object_id = ?")
    .run(JSON.stringify({ subject_domain: "private", subject_qualifiers: {}, canonical_key: "private" }), erasedId)).toThrow();
  await expect(claimRepo.clearSourceObjectRef(erasedId, activeId, NOW)).rejects.toThrow();
  expect(() => f.database.connection.prepare("UPDATE synthesis_capsules SET summary = ? WHERE object_id = ?")
    .run("private cached summary", erasedSynthesis.object_id)).toThrow();
  await expect(f.capsules.clearSourceMemoryRef(erasedSynthesis.object_id, activeId, NOW)).rejects.toThrow();
  const edges = new SqliteConflictMatrixRepo(f.database);
  expect(() => edges.create({ object_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3", object_kind: "conflict_matrix_edge",
    schema_version: 1, lifecycle_state: "active", created_at: NOW, updated_at: NOW, created_by: "test",
    source_claim_id: erasedId, target_claim_id: activeId, edge_type: "supports", workspace_id: "workspace-1" })).toThrow();
});

it("allows erasure to scrub a historical tombstoned synthesis that still contains text", async () => {
  const f = await fixture();
  const repos = createDaemonFieldRepos({ database: f.database });
  const admission = createSourceAdmissionPort({ sha256: fieldContractSha256,
    stores: createSqliteFieldFormationStores({ database: f.database, repos }) });
  const source = admission.admit({ workspace_id: "workspace-1", source_id: "historical-tombstone", source_version: "1",
    content_bytes: "private history", evidence_object_id: null, recorded_at: NOW,
    event_time: null, valid_from: null, valid_to: null, spans: [] }).record;
  const target = sourceRecallTarget({ workspace_id: source.workspace_id, root_kind: "source_record", root_id: source.identity,
    source_version: source.source_version, content_digest: source.content_digest, evidence_object_id: null });
  const evidenceId = "ffffffff-ffff-4fff-8fff-fffffffffff1";
  await f.evidenceCapsuleRepo.create(createEvidenceCapsule({ object_id: evidenceId,
    gist: JSON.stringify({ contract: "published-source-interpretation-v4", source_target: target }) }));
  const old = await f.capsules.create(createSynthesisCapsule({ lifecycle_state: "tombstone", synthesis_status: "working",
    topic_key: "private", summary: "private history", evidence_refs: [evidenceId] }));
  repos.erase.apply({ barrier_id: "erase-historical-tombstone", workspace_id: "workspace-1", generation_id: null,
    subject_kind: "source_record", subject_id: source.identity, erased_at: "2026-05-02T00:00:01.000Z" });
  expect(await f.capsules.findById(old.object_id)).toMatchObject({ lifecycle_state: "tombstone",
    synthesis_status: "archived", topic_key: "erased", summary: "erased" });
  expect(() => f.database.connection.prepare("UPDATE synthesis_capsules SET summary = ? WHERE object_id = ?")
    .run("private history", old.object_id)).toThrow();
});

it.each(["librarian", "auditor"] as const)("deduplicates concurrent %s creation across SQLite connections", async producer => {
  const directory = mkdtempSync(join(tmpdir(), "alaya-garden-proposal-"));
  const filename = join(directory, "garden.sqlite");
  const f = await fixture(filename);
  const peer = new StorageDatabase(filename, openSqliteConnection(filename));
  try {
    expect(peer.connection).not.toBe(f.database.connection);
    const eventLogRepo = new SqliteEventLogRepo(peer);
    const eventPublisher = new EventPublisher({ eventLogRepo, runtimeNotifier: { notify: () => undefined, notifyEntry: () => undefined },
      runHotStateService: { apply: () => undefined } });
    const other = createGardenBackgroundDataPorts(peer, { now: () => NOW,
      proposalWriter: createGardenProposalWriter({ proposalRepo: new SqliteProposalRepo(peer), eventPublisher, now: () => NOW }) });
    if (producer === "librarian") {
      expect(await Promise.all([f.ports.synthesisPort.hasPendingSynthesisForSubject("workspace-1", "tooling"),
        other.synthesisPort.hasPendingSynthesisForSubject("workspace-1", "tooling")])).toEqual([false, false]);
    } else {
      expect(await Promise.all([f.ports.bootstrappingPort.hasPendingSynthesisCandidate("workspace-1", "pattern"),
        other.bootstrappingPort.hasPendingSynthesisCandidate("workspace-1", "pattern")])).toEqual([false, false]);
    }
    const create = (ports: typeof f.ports) => producer === "librarian"
      ? ports.synthesisPort.createSynthesisReviewCandidate("workspace-1", "tooling", [])
      : ports.bootstrappingPort.createSynthesisCandidate("workspace-1", "pattern");
    const results = await Promise.all([create(f.ports), create(other)]);
    expect(new Set(results.map(result => result.candidate_id)).size).toBe(1);
    expect(results.map(result => result.created).sort()).toEqual([false, true]);
    await assertCreation(f, results[0]!.candidate_id);
    expect(f.database.connection.prepare("SELECT COUNT(*) AS count FROM proposals").get()).toEqual({ count: 1 });
  } finally {
    peer.close(); f.database.close(); trackedDatabases.delete(f.database); rmSync(directory, { recursive: true, force: true });
  }
});
