import { afterEach, expect, it } from "vitest";
import type { EvidenceCapsule } from "@do-soul/alaya-protocol";
import { SqliteEvidenceCapsuleRepo, SqliteMemoryEntryRepo, SqliteMemoryObjectKeyRepo,
  SqliteProposalRepo } from "@do-soul/alaya-storage";
import { createDaemonMemoryObjectKeyWriter } from "../../../runtime/daemon/wiring/memory-object-key-writer.js";
import { createMemoryEntry, createProposal, createRepo, createReviewEvents,
  trackedDatabases } from "../../../../../../packages/storage/src/__tests__/repos/proposal/proposal-repo-fixture.js";

const EVIDENCE_A = "aaaaaaaa-1111-4111-8111-111111111111";
const EVIDENCE_B = "bbbbbbbb-2222-4222-8222-222222222222";

afterEach(() => { for (const database of trackedDatabases) database.close(); trackedDatabases.clear(); });

it("atomically replaces old object keys when an accepted review replaces evidence", async () => {
  const { database } = createRepo();
  const writer = createDaemonMemoryObjectKeyWriter(database);
  const proposalRepo = new SqliteProposalRepo(database, memory => writer.materializeForMemory(memory));
  const evidenceRepo = new SqliteEvidenceCapsuleRepo(database);
  await evidenceRepo.create(capsule(EVIDENCE_A, "Golden Retriever"));
  await evidenceRepo.create(capsule(EVIDENCE_B, "Blue Bicycle"));
  const memoryRepo = new SqliteMemoryEntryRepo(database);
  const memory = await memoryRepo.create(createMemoryEntry({ content: "A visit happened.", evidence_refs: [EVIDENCE_A] }));
  writer.materializeForMemory(memory);
  const keys = new SqliteMemoryObjectKeyRepo(database);
  expect(keys.listByOwner("workspace-1", memory.object_id).map(key => key.surface)).toContain("Golden Retriever");
  const proposal = createProposal();
  await proposalRepo.create({ proposal, workspace_id: "workspace-1", run_id: "run-1",
    target_object_kind: "memory_entry", proposed_change_summary: "Replace evidence",
    proposed_changes: { evidence_refs: [EVIDENCE_B] } });
  await proposalRepo.acceptPendingMemoryUpdateWithEvents(proposal.proposal_id, "2026-03-21T03:00:00.000Z",
    createReviewEvents(proposal), { target_object_id: memory.object_id, workspace_id: "workspace-1",
      proposed_changes: { evidence_refs: [EVIDENCE_B] }, updated_at: "2026-03-21T03:00:00.000Z",
      caused_by: "proposal_accept:test" }, { reviewerIdentity: "user:alice" });
  const surfaces = keys.listByOwner("workspace-1", memory.object_id).map(key => key.surface);
  expect(surfaces).toContain("Blue Bicycle");
  expect(surfaces).not.toContain("Golden Retriever");
});

it("does not accept a content change when the projection writer is unavailable", async () => {
  const { database } = createRepo();
  const repo = new SqliteProposalRepo(database);
  const memoryRepo = new SqliteMemoryEntryRepo(database);
  const memory = await memoryRepo.create(createMemoryEntry());
  const proposal = createProposal();
  await repo.create({ proposal, workspace_id: "workspace-1", run_id: "run-1", target_object_kind: "memory_entry",
    proposed_change_summary: "Change content", proposed_changes: { content: "changed" } });
  await expect(repo.acceptPendingMemoryUpdateWithEvents(proposal.proposal_id, "2026-03-21T03:00:00.000Z",
    createReviewEvents(proposal), { target_object_id: memory.object_id, workspace_id: "workspace-1",
      proposed_changes: { content: "changed" }, updated_at: "2026-03-21T03:00:00.000Z",
      caused_by: "proposal_accept:test" }, { reviewerIdentity: "user:alice" }))
    .rejects.toThrow(/projection writer/u);
  expect((await memoryRepo.findById(memory.object_id))?.content).toBe(memory.content);
  expect((await repo.findById(proposal.proposal_id))?.resolution_state).toBe("pending");
});

function capsule(id: string, gist: string): EvidenceCapsule {
  return { object_id: id, object_kind: "evidence_capsule", schema_version: 1, lifecycle_state: "active",
    created_at: "2026-03-20T00:00:00.000Z", updated_at: "2026-03-20T00:00:00.000Z", created_by: "user",
    evidence_kind: "tool_output", semantic_anchor: { topic: "visit", keywords: ["visit"], summary: "A visit" },
    event_anchor: null, physical_anchor: null, evidence_health_state: "verified", gist, excerpt: null,
    source_hash: null, run_id: "run-1", workspace_id: "workspace-1", surface_id: null };
}
