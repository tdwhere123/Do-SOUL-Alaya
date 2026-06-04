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
import { createMcpMemoryProposalWorkflow } from "../mcp-memory-proposal-workflow.js";
import { registerProposalRoutes } from "../routes/proposals.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

// HTTP review/read-by-id routes are intentionally absent from the active
// surface. These tests pin the removal so a future re-introduction must
// explicitly update the assertions.
describe("proposal routes (HTTP surface narrowed)", () => {
  function buildApp() {
    const app = new Hono();
    const workspaceService = {
      getById: vi.fn(async () => ({ workspace_id: "ws-1" }))
    };
    const proposalService = {
      findByWorkspaceId: vi.fn(async () => []),
      findPending: vi.fn(async () => []),
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
    registerProposalRoutes(app, {
      workspaceService,
      memoryService,
      proposalService,
      mcpMemoryToolHandler
    } as any);
    return { app, workspaceService, proposalService, memoryService, mcpMemoryToolHandler };
  }

  it("removes POST /proposals/:id/review (MR-B01: non-atomic + no workspace scoping)", async () => {
    const { app, proposalService } = buildApp();

    const response = await app.request("/proposals/p1/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "accepted" })
    });

    expect(response.status).toBe(404);
    expect(proposalService.review).not.toHaveBeenCalled();
  });

  it("removes GET /proposals/:id (MR-B02 sibling: no workspace scoping at route layer)", async () => {
    const { app, proposalService } = buildApp();

    const response = await app.request("/proposals/p1");

    expect(response.status).toBe(404);
    expect(proposalService.findById).not.toHaveBeenCalled();
  });

  it("retains GET /workspaces/:wsId/proposals with workspace scoping", async () => {
    const { app, workspaceService, proposalService } = buildApp();

    const response = await app.request("/workspaces/ws-1/proposals");

    expect(response.status).toBe(200);
    expect(workspaceService.getById).toHaveBeenCalledWith("ws-1");
    expect(proposalService.findPending).toHaveBeenCalledWith("ws-1");
  });

  it("creates Inspector memory-action proposals through the MCP proposal workflow", async () => {
    const { app, mcpMemoryToolHandler, memoryService } = buildApp();

    const response = await app.request("/workspaces/ws-1/soul/memory/mem-1/proposals/downgrade", {
      method: "POST"
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { proposal_id: "proposal-1", status: "created" }
    });
    expect(memoryService.findByIdScoped).toHaveBeenCalledWith("mem-1", "ws-1");
    expect(mcpMemoryToolHandler.call).toHaveBeenCalledWith({
      toolName: "soul.propose_memory_update",
      arguments: {
        target_object_id: "mem-1",
        proposed_changes: { confidence: 0.4 },
        reason: "Downgrade memory mem-1: Inspector user requested weaker trust."
      },
      context: {
        workspaceId: "ws-1",
        runId: null,
        agentTarget: "inspector",
        sessionId: expect.stringMatching(/^inspector-/)
      }
    });
  });

  it("encodes retire as a tombstone proposal and never mutates the memory route-side", async () => {
    const { app, mcpMemoryToolHandler } = buildApp();

    const response = await app.request("/workspaces/ws-1/soul/memory/mem-1/proposals/retire", {
      method: "POST"
    });

    expect(response.status).toBe(200);
    expect(mcpMemoryToolHandler.call).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "soul.propose_memory_update",
        arguments: expect.objectContaining({
          proposed_changes: {
            retention_state: "tombstoned",
            storage_tier: "cold"
          }
        })
      })
    );
  });

  // M-1 (Phase 2 review-loop): a second click of the same Inspector action
  // button on the same memory must not spam-create duplicate pending
  // proposals. The route should detect an existing pending proposal whose
  // target + proposed_changes match and return its proposal_id with
  // status=already_pending instead of creating another one.
  it("dedupes a repeated retire click against an existing pending tombstone proposal", async () => {
    const app = new Hono();
    const workspaceService = { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) };
    const memoryService = {
      findByIdScoped: vi.fn(async () => ({ object_id: "mem-1", confidence: 0.6 }))
    };
    const proposalService = {
      findByWorkspaceId: vi.fn(async () => []),
      findPending: vi.fn(async () => [])
    };
    const propose = vi.fn(async () => ({
      ok: true as const,
      output: { proposal_id: "fresh-proposal", status: "created" }
    }));
    const listPending = vi.fn(async () => ({
      ok: true as const,
      output: {
        proposals: [
          {
            proposal_id: "existing-tombstone-proposal",
            target_object_id: "mem-1",
            target_object_kind: "memory_entry",
            created_at: "2026-05-09T00:00:00.000Z",
            proposed_change_summary: "retire mem-1",
            proposed_changes: { retention_state: "tombstoned", storage_tier: "cold" },
            assigned_reviewer_identity: null,
            assigned_at: null,
            deadline_at: null,
            is_overdue: false
          }
        ]
      }
    }));
    const mcpMemoryToolHandler = {
      call: vi.fn(async (input: { toolName: string }) =>
        input.toolName === "soul.list_pending_proposals" ? await listPending() : await propose()
      )
    };
    registerProposalRoutes(app, {
      workspaceService,
      memoryService,
      proposalService,
      mcpMemoryToolHandler
    } as any);

    const response = await app.request("/workspaces/ws-1/soul/memory/mem-1/proposals/retire", {
      method: "POST"
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { proposal_id: "existing-tombstone-proposal", status: "already_pending" }
    });
    // The propose_memory_update path must NOT be invoked when a duplicate is detected.
    expect(propose).not.toHaveBeenCalled();
  });

  // invariant: governance promotion to strictly_governed is auditable and
  // must travel through the Proposal lifecycle, not a direct mutation.
  it("creates a typed path_relation Proposal when promote-strictly-governed is invoked", async () => {
    const app = new Hono();
    const workspaceService = { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) };
    const memoryService = {
      findByIdScoped: vi.fn(async () => ({ object_id: "mem-1" }))
    };
    const proposalService = {
      findByWorkspaceId: vi.fn(async () => []),
      findPending: vi.fn(async () => [])
    };
    const mcpMemoryToolHandler = { call: vi.fn() };
    const createProposalWithEvents = vi.fn(async (input: { proposal: { proposal_id: string } }) => ({
      proposal: input.proposal,
      events: [{ event_id: "evt-1" }]
    }));
    const notifyEntry = vi.fn();
    registerProposalRoutes(app, {
      workspaceService,
      memoryService,
      proposalService,
      proposalRepo: { createProposalWithEvents },
      runtimeNotifier: { notifyEntry },
      mcpMemoryToolHandler
    } as any);

    const response = await app.request(
      "/workspaces/ws-1/soul/memory/mem-1/proposals/promote-strictly-governed",
      { method: "POST" }
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: {
        status: string;
        target_object_kind: string;
        requested_governance_class: string;
        target_object_id: string;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("created");
    expect(body.data.target_object_kind).toBe("path_relation");
    expect(body.data.requested_governance_class).toBe("strictly_governed");
    expect(body.data.target_object_id).toBe("mem-1");

    expect(createProposalWithEvents).toHaveBeenCalledTimes(1);
    const callInput = createProposalWithEvents.mock.calls[0][0] as unknown as {
      target_object_kind: string;
      proposed_change_summary: string;
      proposal: { derived_from: string; resolution_state: string };
    };
    expect(callInput.target_object_kind).toBe("path_relation");
    expect(callInput.proposal.derived_from).toBe("mem-1");
    expect(callInput.proposal.resolution_state).toBe("pending");
    expect(callInput.proposed_change_summary).toContain("strictly_governed");
    // The MCP propose path must NOT be used; the path_relation Proposal
    // does not match SoulProposeMemoryUpdateRequestSchema's
    // PublicMemoryEntryMutableFields constraint.
    expect(mcpMemoryToolHandler.call).not.toHaveBeenCalled();
    expect(notifyEntry).toHaveBeenCalledTimes(1);
  });

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
    registerProposalRoutes(app, {
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
    } as any);

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
          reviewer_identity: "user:inspector"
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
          reviewer_identity: "user:inspector"
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

  it("rejects accept-apply of a path_relation proposal whose object target anchor names a foreign memory", async () => {
    const governedMemoryId = "11111111-1111-4111-8111-111111111111";
    // An object anchor naming a memory that does not exist in this workspace —
    // the latent bypass NR-7 targets: the storage accept-apply would insert it
    // into the durable path plane without the B3 existence/ownership gate.
    const foreignTargetMemoryId = "99999999-9999-4999-8999-999999999999";
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    const proposalRepo = new SqliteProposalRepo(database);
    const eventLogRepo = new SqliteEventLogRepo(database);
    const workspaceRepo = new SqliteWorkspaceRepo(database);
    const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
    const pathRelationRepo = new SqlitePathRelationRepo(database);
    const coUsageCounterRepo = new SqliteCoUsageCounterRepo(database);
    await workspaceRepo.create({
      workspace_id: "ws-1",
      name: "workspace one",
      root_path: "/tmp/workspace-one",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    await memoryEntryRepo.create(createMemoryEntry(governedMemoryId, "ws-1"));

    const eventPublisher = new EventPublisher({
      eventLogRepo,
      runHotStateService: { apply: () => {} },
      runtimeNotifier: { notify: () => {}, notifyEntry: () => {} }
    });
    // The REAL B3 gate, backed by the same memory existence/ownership lookup the
    // daemon wires. Reused, not duplicated.
    const objectAnchorGate = new PathRelationProposalService({
      repo: {
        create: (relation) => pathRelationRepo.create(relation),
        findByAnchorMemoryId: async (memoryId, workspaceId) =>
          await pathRelationRepo.findByAnchors(workspaceId, [{ kind: "object", object_id: memoryId }])
      },
      counterStore: coUsageCounterRepo,
      memoryExistence: {
        workspaceOfObject: async (objectId) => {
          const entry = await memoryEntryRepo.findById(objectId);
          return entry === null ? null : entry.workspace_id;
        }
      },
      eventPublisher,
      now: () => "2026-05-18T00:00:00.000Z"
    });

    // A path_relation proposal whose proposed target anchor is an OBJECT anchor
    // aimed at a memory absent from this workspace.
    const foreignObjectProposal: PathRelationProposalPayload = {
      target_anchor: { kind: "object", object_id: foreignTargetMemoryId },
      constitution: {
        relation_kind: "supports",
        why_this_relation_exists: ["inspector requested associative link"]
      },
      effect_vector: {
        salience: 0.5,
        recall_bias: 0.5,
        verification_bias: 0,
        unfinishedness_bias: 0,
        default_manifestation_preference: "lens_entry"
      },
      plasticity_state: {
        strength: 0.5,
        direction_bias: "source_to_target",
        stability_class: "stable",
        support_events_count: 1,
        contradiction_events_count: 0
      },
      lifecycle: { status: "active", retirement_rule: "manual" },
      legitimacy: {
        evidence_basis: ["inspector:object-anchor-proposal"],
        governance_class: "recall_allowed"
      }
    };

    const proposalId = "22222222-2222-4222-8222-222222222222";
    const proposal = ProposalSchema.parse({
      runtime_id: proposalId,
      object_kind: ControlPlaneObjectKind.PROPOSAL,
      task_surface_ref: null,
      expires_at: null,
      derived_from: governedMemoryId,
      retention_policy: RetentionPolicy.SESSION_ONLY,
      proposal_id: proposalId,
      dossier_ref: null,
      recommended_option_id: null,
      proposal_options: [
        {
          option_id: `path_relation_${proposalId}`,
          option_kind: ProposalOptionKind.REQUEST_CONFIRMATION,
          preserves_protected_constraints: true,
          dropped_candidates: [],
          unresolved_after_apply: [],
          requires_confirmation: true
        }
      ],
      resolution_state: ProposalResolutionState.PENDING,
      last_updated_at: "2026-05-18T00:00:00.000Z"
    });
    await proposalRepo.createProposalWithEvents(
      {
        proposal,
        workspace_id: "ws-1",
        run_id: null,
        target_object_kind: "path_relation",
        proposed_change_summary: "associate governed memory with a foreign object",
        proposed_path_relation: foreignObjectProposal,
        created_at: "2026-05-18T00:00:00.000Z"
      },
      [
        {
          event_type: MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED,
          entity_type: "proposal",
          entity_id: proposalId,
          workspace_id: "ws-1",
          run_id: null,
          caused_by: "inspector",
          payload_json: SoulProposalCreatedPayloadSchema.parse({
            object_id: proposalId,
            object_kind: ControlPlaneObjectKind.PROPOSAL,
            workspace_id: "ws-1",
            run_id: null
          })
        }
      ]
    );

    const workflow = createMcpMemoryProposalWorkflow({
      now: () => "2026-05-18T00:00:00.000Z",
      generateObjectId: () => "path-foreign-1",
      eventLogRepo,
      proposalRepo,
      runtimeNotifier: { notifyEntry: vi.fn() },
      memoryService: {
        findByIdScoped: async (objectId, workspaceId) => {
          const memory = await memoryEntryRepo.findById(objectId);
          return memory !== null && memory.workspace_id === workspaceId ? memory : null;
        },
        update: async () => {
          throw new Error("memory update must not be used for path_relation proposal accept");
        }
      },
      objectAnchorGate
    });

    await expect(
      workflow.reviewMemoryProposal(
        {
          proposal_id: proposalId,
          verdict: "accept",
          reason: "approved associative link",
          reviewer_identity: "user:inspector"
        },
        {
          workspaceId: "ws-1",
          runId: null,
          agentTarget: "inspector",
          sessionId: "inspector-foreign-anchor-review"
        }
      )
    ).rejects.toMatchObject({ code: "VALIDATION" });

    // No durable path landed for either endpoint.
    await expect(
      pathRelationRepo.findByAnchor("ws-1", { kind: "object", object_id: governedMemoryId })
    ).resolves.toEqual([]);
    await expect(
      pathRelationRepo.findByAnchor("ws-1", { kind: "object", object_id: foreignTargetMemoryId })
    ).resolves.toEqual([]);
    // The proposal is NOT accepted (stays pending; the storage transaction never ran).
    const after = await proposalRepo.findById(proposalId);
    expect(after?.resolution_state).toBe("pending");
    // The same path.relation_rejected audit the mint sink uses was emitted.
    const rejectionEvents = await eventLogRepo.queryByWorkspaceAndType(
      "ws-1",
      RuntimeGovernanceEventType.PATH_RELATION_REJECTED
    );
    expect(rejectionEvents).toHaveLength(1);
    expect(rejectionEvents[0]).toMatchObject({
      entity_type: "path_relation",
      workspace_id: "ws-1",
      payload_json: {
        rejected_object_id: foreignTargetMemoryId,
        rejection_reason: "object_missing"
      }
    });
  });

  it("returns 404 when the target memory does not exist", async () => {
    const app = new Hono();
    const workspaceService = { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) };
    const memoryService = { findByIdScoped: vi.fn(async () => null) };
    const proposalService = {
      findByWorkspaceId: vi.fn(async () => []),
      findPending: vi.fn(async () => [])
    };
    const createProposalWithEvents = vi.fn();
    registerProposalRoutes(app, {
      workspaceService,
      memoryService,
      proposalService,
      proposalRepo: { createProposalWithEvents },
      runtimeNotifier: { notifyEntry: vi.fn() },
      mcpMemoryToolHandler: { call: vi.fn() }
    } as any);

    const response = await app.request(
      "/workspaces/ws-1/soul/memory/missing/proposals/promote-strictly-governed",
      { method: "POST" }
    );
    expect(response.status).toBe(404);
    expect(createProposalWithEvents).not.toHaveBeenCalled();
  });

  it("still creates a new proposal when the existing pending proposal has different proposed_changes", async () => {
    const app = new Hono();
    const workspaceService = { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) };
    const memoryService = {
      findByIdScoped: vi.fn(async () => ({ object_id: "mem-1", confidence: 0.6 }))
    };
    const proposalService = {
      findByWorkspaceId: vi.fn(async () => []),
      findPending: vi.fn(async () => [])
    };
    const propose = vi.fn(async () => ({
      ok: true as const,
      output: { proposal_id: "new-rewrite-proposal", status: "created" }
    }));
    const listPending = vi.fn(async () => ({
      ok: true as const,
      output: {
        proposals: [
          {
            proposal_id: "existing-keep-proposal",
            target_object_id: "mem-1",
            target_object_kind: "memory_entry",
            created_at: "2026-05-09T00:00:00.000Z",
            proposed_change_summary: "keep mem-1",
            // Different shape than retire — dedupe must NOT match.
            proposed_changes: { confidence: 0.65 },
            assigned_reviewer_identity: null,
            assigned_at: null,
            deadline_at: null,
            is_overdue: false
          }
        ]
      }
    }));
    const mcpMemoryToolHandler = {
      call: vi.fn(async (input: { toolName: string }) =>
        input.toolName === "soul.list_pending_proposals" ? await listPending() : await propose()
      )
    };
    registerProposalRoutes(app, {
      workspaceService,
      memoryService,
      proposalService,
      mcpMemoryToolHandler
    } as any);

    const response = await app.request("/workspaces/ws-1/soul/memory/mem-1/proposals/retire", {
      method: "POST"
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { proposal_id: "new-rewrite-proposal", status: "created" }
    });
    expect(propose).toHaveBeenCalled();
  });
});

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
