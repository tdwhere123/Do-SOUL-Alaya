import { afterEach, expect, it } from "vitest";
import { sourceRecallTarget, type EvidenceCapsule } from "@do-soul/alaya-protocol";
import { createSourceAdmissionPort, DynamicsService, fieldContractSha256, MemoryService } from "@do-soul/alaya-core";
import { SqliteEventLogRepo, SqliteKarmaEventRepo, SqliteProposalRepo } from "@do-soul/alaya-storage";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { createDaemonMemoryObjectKeyWriter } from "../../../runtime/daemon/wiring/memory-object-key-writer.js";
import { createMcpMemoryProposalWorkflow } from "../../../mcp-memory/proposal/proposal-workflow.js";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { createMemoryEntry, trackedDatabases } from "../../../../../../packages/storage/src/__tests__/repos/proposal/proposal-repo-fixture.js";

afterEach(() => { for (const db of trackedDatabases) db.close(); trackedDatabases.clear(); });

it("rolls back reviewed reattachment and real karma when source erasure wins after validation", async () => {
  const { database, memoryEntryRepo, evidenceCapsuleRepo } = await createRecallRealStorage(db => trackedDatabases.add(db));
  const repos = createDaemonFieldRepos({ database });
  const admission = createSourceAdmissionPort({ sha256: fieldContractSha256,
    stores: createSqliteFieldFormationStores({ database, repos }) });
  const source = admission.admit({ workspace_id: "workspace-1", source_id: "private-turn", source_version: "1",
    content_bytes: "private source", evidence_object_id: null, recorded_at: "2026-05-01T00:00:00.000Z",
    event_time: null, valid_from: null, valid_to: null, spans: [] }).record;
  const target = sourceRecallTarget({ workspace_id: source.workspace_id, root_kind: "source_record", root_id: source.identity,
    source_version: source.source_version, content_digest: source.content_digest, evidence_object_id: null });
  const evidenceId = "aaaaaaaa-1111-4111-8111-111111111111";
  const evidence: EvidenceCapsule = { object_id: evidenceId, object_kind: "evidence_capsule", schema_version: 1,
    lifecycle_state: "active", created_at: "2026-05-01T00:00:00.000Z", updated_at: "2026-05-01T00:00:00.000Z",
    created_by: "test", evidence_kind: "tool_output", semantic_anchor: { topic: "test", keywords: [], summary: "test" },
    event_anchor: null, physical_anchor: null, evidence_health_state: "verified", gist: JSON.stringify({
      contract: "published-source-interpretation-v4", source_target: target, broken: true }),
    excerpt: null, source_hash: null, run_id: "run-1", workspace_id: "workspace-1", surface_id: null };
  await evidenceCapsuleRepo.create(evidence);
  const memory = await memoryEntryRepo.create(createMemoryEntry({ evidence_refs: [] }));
  const eventLogRepo = new SqliteEventLogRepo(database), karmaEventRepo = new SqliteKarmaEventRepo(database);
  const notifier = { notifyEntry: () => undefined };
  const realMemory = new MemoryService({ memoryEntryRepo, eventLogRepo, runtimeNotifier: notifier,
    evidenceService: { findById: id => evidenceCapsuleRepo.findById(id),
      findByIds: (workspace, ids) => evidenceCapsuleRepo.findByIds(workspace, ids) } });
  const writer = createDaemonMemoryObjectKeyWriter(database);
  const proposalRepo = new SqliteProposalRepo(database, value => writer.materializeForMemory(value));
  const dynamics = new DynamicsService({ memoryRepo: memoryEntryRepo, karmaEventRepo, eventLogRepo,
    runtimeNotifier: notifier, now: () => "2026-05-02T00:00:00.000Z" });
  const workflow = createMcpMemoryProposalWorkflow({ proposalRepo, eventLogRepo, runtimeNotifier: notifier,
    now: () => "2026-05-02T00:00:00.000Z", generateObjectId: () => "bbbbbbbb-2222-4222-8222-222222222222",
    reviewerIdentityBinding: { identity: "user:reviewer", token: "reviewer-token" },
    dynamicsService: dynamics, memoryService: {
      findByIdScoped: (id, workspace) => realMemory.findByIdScoped(id, workspace),
      update: (id, fields, reason) => realMemory.update(id, fields, reason),
      validateUpdate: async (id, patch) => {
        await realMemory.validateUpdate(id, patch);
        repos.erase.apply({ barrier_id: "erase-before-review", workspace_id: "workspace-1", generation_id: null,
          subject_kind: "source_record", subject_id: source.identity, erased_at: "2026-05-02T00:00:00.000Z" });
      }
    } });
  const context = { workspaceId: "workspace-1", runId: "run-1", agentTarget: "codex", sessionId: "session-1" };
  const proposal = await workflow.proposeMemoryUpdate({ target_object_id: memory.object_id,
    proposed_changes: { evidence_refs: [evidenceId] }, reason: "attach evidence" }, context);
  await expect(workflow.reviewMemoryProposal({ proposal_id: proposal.proposal_id, verdict: "accept", reason: null,
    reviewer_identity: "user:reviewer", reviewer_token: "reviewer-token" }, { ...context, agentTarget: "cli" })).rejects.toThrow();
  expect((await evidenceCapsuleRepo.findById(evidenceId))?.lifecycle_state).toBe("tombstone");
  expect((await memoryEntryRepo.findById(memory.object_id))?.evidence_refs).toEqual([]);
  expect((await proposalRepo.findById(proposal.proposal_id))?.resolution_state).toBe("pending");
  expect(await karmaEventRepo.findByObjectId(memory.object_id)).toEqual([]);
});
