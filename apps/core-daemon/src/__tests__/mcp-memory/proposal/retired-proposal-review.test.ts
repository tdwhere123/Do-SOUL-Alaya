import { afterEach, expect, it } from "vitest";
import { DynamicsService, MemoryService } from "@do-soul/alaya-core";
import { MemoryGovernanceEventType } from "@do-soul/alaya-protocol";
import { SqliteEventLogRepo, SqliteKarmaEventRepo, SqliteProposalRepo } from "@do-soul/alaya-storage";
import { createDaemonMemoryObjectKeyWriter } from "../../../runtime/daemon/wiring/memory-object-key-writer.js";
import { createMcpMemoryProposalWorkflow } from "../../../mcp-memory/proposal/proposal-workflow.js";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { createMemoryEntry, createProposal, trackedDatabases } from "../../../../../../packages/storage/src/__tests__/repos/proposal/proposal-repo-fixture.js";

afterEach(() => {
  for (const database of trackedDatabases) database.close();
  trackedDatabases.clear();
});

it.each([
  { dossier: "librarian.merge", kind: "memory_entry", prefix: "merge-primary:" },
  { dossier: "librarian.template", kind: "memory_entry", prefix: "template-representative:" },
  { dossier: "librarian.compression", kind: "memory_entry", prefix: "compression:" },
  { dossier: "inspector.strict_governance_promotion", kind: "path_relation", prefix: "" }
])("lists and rejects retired $dossier proposals without changing memory or karma", async ({ dossier, kind, prefix }) => {
  const { database, memoryEntryRepo, evidenceCapsuleRepo } = await createRecallRealStorage(db => trackedDatabases.add(db));
  const memory = await memoryEntryRepo.create(createMemoryEntry({ evidence_refs: [] }));
  const persistedMemory = await memoryEntryRepo.findById(memory.object_id);
  expect(persistedMemory).not.toBeNull();
  const eventLogRepo = new SqliteEventLogRepo(database);
  const karmaEventRepo = new SqliteKarmaEventRepo(database);
  const notifier = { notifyEntry: () => undefined };
  const memoryService = new MemoryService({
    memoryEntryRepo, eventLogRepo, runtimeNotifier: notifier,
    evidenceService: {
      findById: id => evidenceCapsuleRepo.findById(id),
      findByIds: (workspace, ids) => evidenceCapsuleRepo.findByIds(workspace, ids)
    }
  });
  const dynamicsService = new DynamicsService({
    memoryRepo: memoryEntryRepo, karmaEventRepo, eventLogRepo, runtimeNotifier: notifier,
    now: () => "2026-05-02T00:00:00.000Z"
  });
  const writer = createDaemonMemoryObjectKeyWriter(database);
  const proposalRepo = new SqliteProposalRepo(database, value => writer.materializeForMemory(value));
  const proposal = createProposal({
    dossier_ref: dossier,
    derived_from: `${prefix}${memory.object_id}${dossier === "librarian.compression" ? "->other" : ""}`
  });
  await proposalRepo.create({
    proposal, workspace_id: "workspace-1", run_id: "run-1", target_object_kind: kind,
    proposed_changes: kind === "memory_entry" ? { content: "illegitimate merge" } : null,
    proposed_path_relation: null
  });
  const workflow = createMcpMemoryProposalWorkflow({
    proposalRepo, eventLogRepo, runtimeNotifier: notifier, memoryService, dynamicsService,
    now: () => "2026-05-02T00:00:00.000Z",
    reviewerIdentityBinding: { identity: "user:reviewer", token: "reviewer-token" }
  });
  const context = { workspaceId: "workspace-1", runId: "run-1", agentTarget: "cli", sessionId: "session-1" };
  const review = { proposal_id: proposal.proposal_id, reason: null,
    reviewer_identity: "user:reviewer", reviewer_token: "reviewer-token" };

  expect((await workflow.listPendingProposals({}, context)).proposals).toEqual([
    expect.objectContaining({ proposal_id: proposal.proposal_id, target_object_kind: kind })
  ]);
  await expect(workflow.reviewMemoryProposal({ ...review, verdict: "accept" }, context)).rejects.toMatchObject({
    code: "VALIDATION", message: "Historical proposal kind cannot be accepted"
  });
  expect((await proposalRepo.findById(proposal.proposal_id))?.resolution_state).toBe("pending");
  expect(await eventLogRepo.queryByEntityAll("proposal", proposal.proposal_id)).toEqual([]);
  expect(await memoryEntryRepo.findById(memory.object_id)).toEqual(persistedMemory);
  expect(await karmaEventRepo.findByObjectId(memory.object_id)).toEqual([]);

  await expect(workflow.reviewMemoryProposal({ ...review, verdict: "reject" }, context)).resolves.toEqual({
    proposal_id: proposal.proposal_id, resolution_state: "rejected"
  });
  expect((await proposalRepo.findById(proposal.proposal_id))?.resolution_state).toBe("rejected");
  expect((await workflow.listPendingProposals({}, context)).proposals).toEqual([]);
  expect(await memoryEntryRepo.findById(memory.object_id)).toEqual(persistedMemory);
  expect(await karmaEventRepo.findByObjectId(memory.object_id)).toEqual([]);
  expect(await karmaEventRepo.findByObjectId(proposal.derived_from!)).toEqual([]);
  expect((await eventLogRepo.queryByEntityAll("proposal", proposal.proposal_id)).map(event => event.event_type)).toContain(
    MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED
  );
});
