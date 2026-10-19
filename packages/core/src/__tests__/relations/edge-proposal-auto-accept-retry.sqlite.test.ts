import { afterEach, describe, expect, it } from "vitest";
import {
  EdgeProposalStatus,
  EdgeProposalTriggerSource,
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEdgeProposalRepo,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { EdgeProposalService } from "../../relations/edge-proposals/edge-proposal-service.js";
import { createMemoryEntry } from "../memory/memory-service-test-fixtures.js";
import { createEventPublisher, createPathCandidatePort } from "./edge-proposal-service-test-fixtures.js";

const WORKSPACE_ID = "workspace-1";
const RUN_ID = "run-1";
const SOURCE_MEMORY_ID = "00000000-0000-4000-8000-0000000000a1";
const TARGET_MEMORY_ID = "00000000-0000-4000-8000-0000000000a2";

const databases: StorageDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

// The recovery read is durable state, not an in-memory copy: findPendingDuplicate
// matches status='pending' in SQLite, updateReview CAS-gates on the same status,
// and a transient mint failure reverts the review row through the
// pending-unique index. This exercises that boundary end to end.
describe("EdgeProposalService auto-accept retry over SQLite", () => {
  it("finishes an interrupted create->accept on re-propose without creating a duplicate row", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.push(database);
    await seedWorkspaceAndRun(database);
    const memoryRepo = new SqliteMemoryEntryRepo(database);
    await memoryRepo.create(createMemoryEntry({ object_id: SOURCE_MEMORY_ID, workspace_id: WORKSPACE_ID }));
    await memoryRepo.create(createMemoryEntry({ object_id: TARGET_MEMORY_ID, workspace_id: WORKSPACE_ID }));

    const proposalRepo = new SqliteEdgeProposalRepo(database);
    const pathCandidatePort = createPathCandidatePort();
    pathCandidatePort.submitCandidate.mockImplementationOnce(async () => "failed");
    let generated = 0;
    const service = new EdgeProposalService({
      memoryRepo,
      proposalRepo,
      pathCandidatePort,
      eventPublisher: createEventPublisher(),
      generateId: () => `proposal-${++generated}`,
      now: () => "2026-05-24T00:00:00.000Z"
    });
    const params = {
      sourceMemoryId: SOURCE_MEMORY_ID,
      targetMemoryId: TARGET_MEMORY_ID,
      edgeType: "recalls" as const,
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
      confidence: 0.9
    };

    await expect(service.proposeEdge(params)).rejects.toMatchObject({ code: "OBLIGATION_VIOLATION" });
    expect(proposalRepo.findPendingDuplicate({
      workspaceId: WORKSPACE_ID,
      sourceMemoryId: SOURCE_MEMORY_ID,
      targetMemoryId: TARGET_MEMORY_ID,
      edgeType: "recalls"
    })?.proposal_id).toBe("edge_prop_proposal-1");

    const resumed = await service.proposeEdge(params);

    expect(resumed).toMatchObject({
      proposal_id: "edge_prop_proposal-1",
      status: EdgeProposalStatus.AUTO_ACCEPTED
    });
    expect(proposalRepo.findById("edge_prop_proposal-1")?.status).toBe(EdgeProposalStatus.AUTO_ACCEPTED);
    expect(proposalRepo.listPending(WORKSPACE_ID)).toEqual([]);
    expect(countEdgeProposalRows(database)).toBe(1);
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(2);
  });
});

async function seedWorkspaceAndRun(database: StorageDatabase): Promise<void> {
  await new SqliteWorkspaceRepo(database).create({
    workspace_id: WORKSPACE_ID,
    name: "edge proposal retry",
    root_path: "/tmp/edge-proposal-retry",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await new SqliteRunRepo(database).create({
    run_id: RUN_ID,
    workspace_id: WORKSPACE_ID,
    title: "edge proposal retry",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}

function countEdgeProposalRows(database: StorageDatabase): number {
  const row = database.connection
    .prepare("SELECT COUNT(*) AS total FROM edge_proposals")
    .get() as { readonly total: number };
  return row.total;
}
