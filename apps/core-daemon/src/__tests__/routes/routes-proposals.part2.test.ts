import { Hono } from "hono";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ControlPlaneObjectKind,
  FormationKind,
  MemoryDimension,
  ProposalOptionKind,
  ProposalResolutionState,
  ProposalSchema,
  RetentionPolicy,
  ScopeClass,
  SoulProposalCreatedPayloadSchema,
  SourceKind,
  StorageTier,
  MemoryGovernanceEventType,
  RuntimeGovernanceEventType,
  WorkspaceKind,
  WorkspaceState,
  type MemoryEntry
} from "@do-soul/alaya-protocol";

import {
  initDatabase,
  SqliteCoUsageCounterRepo,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo,
  SqlitePathRelationRepo,
  SqliteProposalRepo,
  SqliteWorkspaceRepo,
  type PathRelationProposalPayload,
  type StorageDatabase
} from "@do-soul/alaya-storage";

import { EventPublisher, PathRelationProposalService } from "@do-soul/alaya-core";

import { createMcpMemoryProposalWorkflow } from "../../mcp-memory/proposal-workflow.js";

import { registerProposalRoutes } from "../../routes/proposals.js";
import { proposalRouteServices } from "../support/route-service-stubs.js";

const databases = new Set<StorageDatabase>();

function createMemoryEntry(objectId: string, workspaceId: string): MemoryEntry {
  return {
    object_id: objectId,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-18T00:00:00.000Z",
    updated_at: "2026-05-18T00:00:00.000Z",
    created_by: "routes-proposals-test",
    dimension: MemoryDimension.CONSTRAINT,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Do not bypass review.",
    domain_tags: ["governance"],
    evidence_refs: [],
    workspace_id: workspaceId,
    run_id: "run-routes-proposals",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: 0.8,
    retention_score: 1,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 1,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null
  };
}

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("proposal routes (HTTP surface narrowed)", () => {

  function buildApp() {
    const app = new Hono();
    const workspaceService = {
      getById: vi.fn(async () => ({ workspace_id: "ws-1" }))
    };
    const proposalService = {
      findByWorkspaceId: vi.fn(async () => [{ proposal_id: "p1" }, { proposal_id: "p2" }, { proposal_id: "p3" }]),
      countByWorkspaceId: vi.fn(async () => 3),
      findPending: vi.fn(async () => [{ proposal_id: "p1" }, { proposal_id: "p2" }, { proposal_id: "p3" }]),
      countPending: vi.fn(async () => 3),
      findById: vi.fn(async () => ({ proposal_id: "p1" })),
      review: vi.fn(async () => {
        throw new Error("review must not be reachable from HTTP");
      })
    };
    const memoryService = {
      findByIdScoped: vi.fn(async () => ({ object_id: "mem-1", confidence: 0.6 }))
    };
    const mcpMemoryToolHandler = {
      call: vi.fn(async () => ({
        ok: true,
        output: { proposal_id: "proposal-1", status: "created" }
      }))
    };
    registerProposalRoutes(app, proposalRouteServices({
      workspaceService,
      memoryService,
      proposalService,
      mcpMemoryToolHandler
    }));
    return { app, workspaceService, proposalService, memoryService, mcpMemoryToolHandler };
  }

  it("applies an Inspector-created path_relation proposal into path_relations on accept", async () => {
    const governedMemoryId = "11111111-1111-4111-8111-111111111111";
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    const proposalRepo = new SqliteProposalRepo(database);
    const eventLogRepo = new SqliteEventLogRepo(database);
    const workspaceRepo = new SqliteWorkspaceRepo(database);
    const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
    const pathRelationRepo = new SqlitePathRelationRepo(database);
    await workspaceRepo.create({
      workspace_id: "ws-1",
      name: "workspace one",
      root_path: "/tmp/workspace-one",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    await memoryEntryRepo.create(createMemoryEntry(governedMemoryId, "ws-1"));

    const app = new Hono();
    registerProposalRoutes(app, proposalRouteServices({
      workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) },
      memoryService: {
        findByIdScoped: memoryEntryRepo.findById.bind(memoryEntryRepo)
      },
      proposalService: {
        findByWorkspaceId: vi.fn(async () => []),
        findPending: vi.fn(async () => [])
      },
      proposalRepo,
      runtimeNotifier: { notifyEntry: vi.fn() },
      mcpMemoryToolHandler: { call: vi.fn() }
    }));

    const createdResponse = await app.request(
      `/workspaces/ws-1/soul/memory/${governedMemoryId}/proposals/promote-strictly-governed`,
      { method: "POST" }
    );
    expect(createdResponse.status).toBe(200);
    const createdBody = (await createdResponse.json()) as { data: { proposal_id: string } };
    const proposalId = createdBody.data.proposal_id as string;

    const workflow = createMcpMemoryProposalWorkflow({
      now: () => "2026-05-18T00:00:00.000Z",
      generateObjectId: () => "path-governed-1",
      eventLogRepo,
      proposalRepo,
      runtimeNotifier: { notifyEntry: vi.fn() },
      reviewerIdentityBinding: { token: "reviewer-token", identity: "user:inspector" },
      memoryService: {
        findByIdScoped: async (objectId, workspaceId) => {
          const memory = await memoryEntryRepo.findById(objectId);
          return memory !== null && memory.workspace_id === workspaceId ? memory : null;
        },
        update: async () => {
          throw new Error("memory update must not be used for path_relation proposal accept");
        }
      }
    });

    await expect(
      workflow.reviewMemoryProposal(
        {
          proposal_id: proposalId,
          verdict: "accept",
          reason: "approved governance promotion",
          reviewer_identity: "user:inspector",
          reviewer_token: "reviewer-token"
        },
        {
          workspaceId: "ws-1",
          runId: null,
          agentTarget: "inspector",
          sessionId: "inspector-path-relation-review"
        }
      )
    ).resolves.toMatchObject({ proposal_id: proposalId, resolution_state: "accepted" });

    const relations = await pathRelationRepo.findByAnchor("ws-1", {
      kind: "object",
      object_id: governedMemoryId
    });
    expect(relations).toHaveLength(1);
    expect(relations[0]?.legitimacy.governance_class).toBe("strictly_governed");

    const secondCreatedResponse = await app.request(
      `/workspaces/ws-1/soul/memory/${governedMemoryId}/proposals/promote-strictly-governed`,
      { method: "POST" }
    );
    expect(secondCreatedResponse.status).toBe(200);
    const secondCreatedBody = (await secondCreatedResponse.json()) as { data: { proposal_id: string } };
    const secondProposalId = secondCreatedBody.data.proposal_id as string;

    await expect(
      workflow.reviewMemoryProposal(
        {
          proposal_id: secondProposalId,
          verdict: "accept",
          reason: "approved legitimacy refresh",
          reviewer_identity: "user:inspector",
          reviewer_token: "reviewer-token"
        },
        {
          workspaceId: "ws-1",
          runId: null,
          agentTarget: "inspector",
          sessionId: "inspector-path-relation-review"
        }
      )
    ).resolves.toMatchObject({ proposal_id: secondProposalId, resolution_state: "accepted" });

    const updateEvents = await eventLogRepo.queryByWorkspaceAndType(
      "ws-1",
      RuntimeGovernanceEventType.PATH_RELATION_LEGITIMACY_UPDATED
    );
    expect(updateEvents).toHaveLength(1);
    expect(updateEvents[0]).toMatchObject({
      entity_type: "path_relation",
      workspace_id: "ws-1",
      caused_by: `proposal_accept:${secondProposalId}`,
      payload_json: {
        path_id: relations[0]?.path_id,
        workspace_id: "ws-1",
        previous_governance_class: "strictly_governed",
        new_governance_class: "strictly_governed",
        previous_evidence_basis: expect.arrayContaining([
          "inspector:promote-strictly-governed",
          `proposal_accept:${proposalId}`
        ]),
        new_evidence_basis: expect.arrayContaining([
          "inspector:promote-strictly-governed",
          `proposal_accept:${proposalId}`,
          `proposal_accept:${secondProposalId}`
        ])
      }
    });
  });
});
