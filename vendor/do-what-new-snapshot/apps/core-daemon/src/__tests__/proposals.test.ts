import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceKind, type ClaimForm, type Proposal, type SynthesisCapsule } from "@do-what/protocol";
import {
  ClaimService,
  EventPublisher,
  InMemoryKarmaEventStore,
  ProposalService,
  RunHotStateService,
  RunService,
  SynthesisService,
  WorkspaceService
} from "@do-what/core";
import {
  SqliteClaimFormRepo,
  SqliteEventLogRepo,
  SqliteProposalRepo,
  SqliteRunRepo,
  SqliteSynthesisCapsuleRepo,
  SqliteWorkspaceRepo,
  initDatabase,
  type StorageDatabase
} from "@do-what/storage";
import { createApp } from "../app.js";
import {
  configureWorkspacePrincipalCodingEngine,
  createNoopConversationService,
  createStubEngineBindingService,
  createUnusedEvidenceService,
  createUnusedMemoryService,
  createUnusedSignalService,
  createUnusedSurfaceService
} from "./helpers/mock-services.js";
import { SseManager } from "../sse/sse-manager.js";

interface TestContext {
  readonly app: ReturnType<typeof createApp>;
  readonly database: StorageDatabase;
  readonly claimService: ClaimService;
  readonly synthesisService: SynthesisService;
  readonly proposalService: ProposalService;
  readonly eventLogRepo: SqliteEventLogRepo;
}

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("proposal routes", () => {
  it("lists pending proposals by workspace", async () => {
    const { app, claimService, synthesisService, proposalService } = createTestContext();
    const workspace = await createWorkspace(app, "proposal-workspace");
    const runId = await createRun(app, workspace.workspace_id, "proposal run");

    const synthesis = await createCandidateSynthesis(synthesisService, workspace.workspace_id, runId);
    const claim = await createDraftClaim(claimService, workspace.workspace_id);
    await proposalService.createFromSynthesisPromotion(synthesis.object_id, claim.object_id);

    const response = await app.request(`/workspaces/${workspace.workspace_id}/proposals`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          object_kind: "proposal",
          resolution_state: "pending"
        })
      ]
    });
  });

  it("returns proposal by id", async () => {
    const { app, claimService, synthesisService, proposalService } = createTestContext();
    const workspace = await createWorkspace(app, "proposal-by-id");
    const runId = await createRun(app, workspace.workspace_id, "proposal id run");

    const synthesis = await createCandidateSynthesis(synthesisService, workspace.workspace_id, runId);
    const claim = await createDraftClaim(claimService, workspace.workspace_id);
    const proposal = await proposalService.createFromSynthesisPromotion(synthesis.object_id, claim.object_id);

    const response = await app.request(`/proposals/${proposal.proposal_id}`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        proposal_id: proposal.proposal_id,
        resolution_state: "pending"
      }
    });
  });

  it("reviews proposal as accepted", async () => {
    const { app, claimService, synthesisService, proposalService, eventLogRepo } = createTestContext();
    const workspace = await createWorkspace(app, "proposal-accept");
    const runId = await createRun(app, workspace.workspace_id, "proposal accept run");

    const synthesis = await createCandidateSynthesis(synthesisService, workspace.workspace_id, runId);
    const claim = await createDraftClaim(claimService, workspace.workspace_id);
    const proposal = await proposalService.createFromSynthesisPromotion(synthesis.object_id, claim.object_id);

    const response = await app.request(`/proposals/${proposal.proposal_id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "accepted",
        note: "approve",
        reviewed_by: "reviewer-1"
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        proposal_id: proposal.proposal_id,
        resolution_state: "accepted"
      }
    });

    const updatedClaim = await claimService.findById(claim.object_id);
    expect(updatedClaim?.claim_status).toBe("active");

    const reviewEvents = await eventLogRepo.queryByEntity("proposal", proposal.proposal_id);
    const reviewCreated = reviewEvents.find((event) => event.event_type === "soul.review.created");
    expect(reviewCreated?.caused_by).toBe("reviewer-1");
  });

  it("reviews proposal as rejected", async () => {
    const { app, claimService, synthesisService, proposalService } = createTestContext();
    const workspace = await createWorkspace(app, "proposal-reject");
    const runId = await createRun(app, workspace.workspace_id, "proposal reject run");

    const synthesis = await createCandidateSynthesis(synthesisService, workspace.workspace_id, runId);
    const claim = await createDraftClaim(claimService, workspace.workspace_id);
    const proposal = await proposalService.createFromSynthesisPromotion(synthesis.object_id, claim.object_id);

    const response = await app.request(`/proposals/${proposal.proposal_id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "rejected",
        note: "needs more evidence"
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        proposal_id: proposal.proposal_id,
        resolution_state: "rejected"
      }
    });

    const updatedSynthesis = await synthesisService.findById(synthesis.object_id);
    expect(updatedSynthesis?.promotion_state).toBe("rejected");
    expect(updatedSynthesis?.cooldown_until).not.toBeNull();
  });

  it("returns 400 when reviewing a non-pending proposal", async () => {
    const { app, claimService, synthesisService, proposalService } = createTestContext();
    const workspace = await createWorkspace(app, "proposal-non-pending");
    const runId = await createRun(app, workspace.workspace_id, "proposal non-pending run");

    const synthesis = await createCandidateSynthesis(synthesisService, workspace.workspace_id, runId);
    const claim = await createDraftClaim(claimService, workspace.workspace_id);
    const proposal = await proposalService.createFromSynthesisPromotion(synthesis.object_id, claim.object_id);

    await app.request(`/proposals/${proposal.proposal_id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "accepted" })
    });

    const secondResponse = await app.request(`/proposals/${proposal.proposal_id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "accepted" })
    });

    expect(secondResponse.status).toBe(400);
    await expect(secondResponse.json()).resolves.toMatchObject({
      success: false
    });
  });
});

function createTestContext(): TestContext {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const synthesisCapsuleRepo = new SqliteSynthesisCapsuleRepo(database);
  const claimFormRepo = new SqliteClaimFormRepo(database);
  const proposalRepo = new SqliteProposalRepo(database);

  const runHotStateService = new RunHotStateService({ runRepo, eventLogRepo });
  const sseManager = new SseManager(eventLogRepo);
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService,
    sseBroadcaster: sseManager
  });

  const workspaceService = new WorkspaceService({
    workspaceRepo,
    runRepo,
    eventPublisher
  });
  const runService = new RunService({
    workspaceRepo,
    runRepo,
    eventPublisher,
    isPrincipalCodingEngineAvailable: () => true
  });

  const slotService = {
    findById: async () => null,
    findByWorkspace: async () => [],
    onClaimActivated: async () =>
      ({
        decision: "new_slot_created",
        reason: "proposal_route_test_slot_seed",
        slot: { winner_claim_id: null }
      }) as any
  };

  const claimService = new ClaimService({
    claimFormRepo,
    eventLogRepo,
    sseBroadcaster: sseManager,
    slotService: slotService as any
  });

  const synthesisService = new SynthesisService({
    synthesisCapsuleRepo,
    evidenceService: createUnusedEvidenceService("proposal route tests") as any,
    memoryService: createUnusedMemoryService("proposal route tests") as any,
    eventLogRepo,
    sseBroadcaster: sseManager
  });

  const proposalService = new ProposalService({
    proposalRepo,
    claimService,
    synthesisService,
    eventLogRepo,
    karmaEventStore: new InMemoryKarmaEventStore(),
    sseBroadcaster: sseManager
  });

  return {
    eventLogRepo,
    app: createApp({
      workspaceService,
      runService,
      principalCodingEngineAvailable: true,
      conversationService: createNoopConversationService("proposal route tests") as any,
      engineBindingService: createStubEngineBindingService() as any,
      runHotStateService,
      sseManager,
      signalService: createUnusedSignalService("proposal route tests") as any,
      evidenceService: createUnusedEvidenceService("proposal route tests") as any,
      memoryService: createUnusedMemoryService("proposal route tests") as any,
      slotService: slotService as any,
      surfaceService: createUnusedSurfaceService("proposal route tests") as any,
      synthesisService,
      claimService,
      proposalService
    }),
    database,
    claimService,
    synthesisService,
    proposalService
  };
}

async function createWorkspace(app: ReturnType<typeof createApp>, name: string): Promise<{
  readonly workspace_id: string;
}> {
  const response = await app.request("/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      root_path: `/tmp/${name}`,
      workspace_kind: WorkspaceKind.LOCAL_REPO
    })
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as any;
  const workspace = body.data;
  await configureWorkspacePrincipalCodingEngine(app, workspace.workspace_id);
  return workspace;
}

async function createRun(
  app: ReturnType<typeof createApp>,
  workspaceId: string,
  title: string
): Promise<string> {
  const response = await app.request(`/workspaces/${workspaceId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title,
      goal: null,
      run_mode: "chat"
    })
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as any;
  return body.data.run_id as string;
}

async function createCandidateSynthesis(
  synthesisService: SynthesisService,
  workspaceId: string,
  runId: string
): Promise<Readonly<SynthesisCapsule>> {
  const synthesis = await synthesisService.create({
    created_by: "user_action",
    topic_key: "security/keys",
    synthesis_type: "phase_synthesis",
    summary: "Never print secrets.",
    evidence_refs: [],
    source_memory_refs: [],
    workspace_id: workspaceId,
    run_id: runId
  });

  return await synthesisService.requestPromotion(synthesis.object_id);
}

async function createDraftClaim(
  claimService: ClaimService,
  workspaceId: string
): Promise<Readonly<ClaimForm>> {
  return await claimService.create({
    created_by: "user_action",
    governance_subject_domain: "security",
    governance_subject_qualifiers: {
      category: "secrets"
    },
    claim_kind: "constraint",
    scope_class: "project",
    enforcement_level: "strict",
    origin_tier: "user_explicit",
    precedence_basis: "authority",
    proposition_digest: "Never print secrets.",
    evidence_refs: [],
    source_object_refs: [],
    workspace_id: workspaceId
  });
}
