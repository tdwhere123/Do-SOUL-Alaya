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
  type EventLogEntry,
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

import { EventPublisher, PathRelationProposalService, ProposalService } from "@do-soul/alaya-core";

import { createMcpMemoryProposalWorkflow } from "../../mcp-memory/proposal-workflow.js";

import { registerProposalRoutes } from "../../routes/proposals.js";
import { proposalRouteServices } from "../support/route-service-stubs.js";

const databases = new Set<StorageDatabase>();

function createAuditEventLogAppend() {
  return vi.fn((event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
    ...event,
    event_id: "audit-evt-1",
    created_at: "2026-05-18T00:00:00.000Z",
    revision: 0
  }));
}

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
    expect(proposalService.findPending).toHaveBeenCalledWith("ws-1", {
      limit: 200,
      offset: 0
    });
    expect(proposalService.countPending).toHaveBeenCalledWith("ws-1");
  });

  it("passes pagination to GET /workspaces/:wsId/proposals without handler-level slicing", async () => {
    const { app, proposalService } = buildApp();
    proposalService.findPending.mockImplementation(async (...args: unknown[]) => {
      const page = args[1];
      expect(page).toEqual({ limit: 2, offset: 1 });
      return [{ proposal_id: "p2" }, { proposal_id: "p3" }];
    });

    const response = await app.request("/workspaces/ws-1/proposals?limit=2&offset=1");

    expect(response.status).toBe(200);
    expect(response.headers.get("x-total-count")).toBe("3");
    expect(response.headers.get("x-limit")).toBe("2");
    expect(response.headers.get("x-offset")).toBe("1");
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: [{ proposal_id: "p2" }, { proposal_id: "p3" }]
    });
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
    registerProposalRoutes(app, proposalRouteServices({
      workspaceService,
      memoryService,
      proposalService,
      mcpMemoryToolHandler
    }));

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
    const createProposalWithEventsIfAbsent = vi.fn(async (input: { proposal: { proposal_id: string } }) => ({
      proposal: input.proposal,
      events: [{ event_id: "evt-1" }],
      status: "created" as const
    }));
    const notifyEntry = vi.fn();
    registerProposalRoutes(app, proposalRouteServices({
      workspaceService,
      memoryService,
      proposalService,
      proposalRepo: { createProposalWithEventsIfAbsent },
      eventLogRepo: { append: createAuditEventLogAppend() },
      runtimeNotifier: { notifyEntry },
      mcpMemoryToolHandler
    }));

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

    expect(createProposalWithEventsIfAbsent).toHaveBeenCalledTimes(1);
    const callInput = createProposalWithEventsIfAbsent.mock.calls[0][0] as unknown as {
      target_object_kind: string;
      proposed_change_summary: string;
      proposal: { derived_from: string; dossier_ref: string; resolution_state: string };
    };
    expect(callInput.target_object_kind).toBe("path_relation");
    expect(callInput.proposal.derived_from).toBe("mem-1");
    expect(callInput.proposal.dossier_ref).toBe("inspector.strict_governance_promotion");
    expect(callInput.proposal.resolution_state).toBe("pending");
    expect(callInput.proposed_change_summary).toContain("strictly_governed");
    // The MCP propose path must NOT be used; the path_relation Proposal
    // does not match SoulProposeMemoryUpdateRequestSchema's
    // PublicMemoryEntryMutableFields constraint.
    expect(mcpMemoryToolHandler.call).not.toHaveBeenCalled();
    expect(notifyEntry).toHaveBeenCalledTimes(1);
  });

  it("dedupes a repeated promote-strictly-governed click against an existing pending proposal", async () => {
    const app = new Hono();
    const workspaceService = { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) };
    const memoryService = {
      findByIdScoped: vi.fn(async () => ({ object_id: "mem-1" }))
    };
    const existingProposalId = "11111111-1111-4111-8111-111111111111";
    const existingProposal = ProposalSchema.parse({
      runtime_id: existingProposalId,
      object_kind: ControlPlaneObjectKind.PROPOSAL,
      task_surface_ref: null,
      expires_at: null,
      derived_from: "mem-1",
      retention_policy: RetentionPolicy.SESSION_ONLY,
      proposal_id: existingProposalId,
      dossier_ref: null,
      recommended_option_id: null,
      proposal_options: [
        {
          option_id: `promote_strictly_governed_${existingProposalId}`,
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
    const proposalService = {
      findByWorkspaceId: vi.fn(async () => []),
      findPending: vi.fn(async () => [existingProposal])
    };
    const createProposalWithEventsIfAbsent = vi.fn();
    const notifyEntry = vi.fn();
    registerProposalRoutes(app, proposalRouteServices({
      workspaceService,
      memoryService,
      proposalService,
      proposalRepo: { createProposalWithEventsIfAbsent },
      eventLogRepo: { append: createAuditEventLogAppend() },
      runtimeNotifier: { notifyEntry },
      mcpMemoryToolHandler: { call: vi.fn() }
    }));

    const response = await app.request(
      "/workspaces/ws-1/soul/memory/mem-1/proposals/promote-strictly-governed",
      { method: "POST" }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        proposal_id: existingProposalId,
        status: "already_pending",
        target_object_id: "mem-1",
        target_object_kind: "path_relation",
        requested_governance_class: "strictly_governed"
      }
    });
    expect(proposalService.findPending).toHaveBeenCalledWith("ws-1");
    expect(createProposalWithEventsIfAbsent).not.toHaveBeenCalled();
    expect(notifyEntry).not.toHaveBeenCalled();
  });

  it("dedupes concurrent promote-strictly-governed clicks in storage", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    const proposalRepo = new SqliteProposalRepo(database);
    const eventLogRepo = new SqliteEventLogRepo(database);
    const notifyEntry = vi.fn();
    const proposalService = new ProposalService({
      proposalRepo,
      eventLogRepo,
      runtimeNotifier: { notifyEntry }
    });
    const app = new Hono();
    registerProposalRoutes(app, proposalRouteServices({
      workspaceService: {
        getById: vi.fn(async () => ({ workspace_id: "ws-1" }))
      },
      memoryService: {
        findByIdScoped: vi.fn(async () => ({ object_id: "mem-1" }))
      },
      proposalService,
      proposalRepo,
      eventLogRepo,
      runtimeNotifier: { notifyEntry },
      mcpMemoryToolHandler: { call: vi.fn() }
    }));

    const [first, second] = await Promise.all([
      app.request("/workspaces/ws-1/soul/memory/mem-1/proposals/promote-strictly-governed", {
        method: "POST"
      }),
      app.request("/workspaces/ws-1/soul/memory/mem-1/proposals/promote-strictly-governed", {
        method: "POST"
      })
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const bodies = [await first.json(), await second.json()] as Array<{
      readonly success: true;
      readonly data: { readonly proposal_id: string; readonly status: string };
    }>;
    expect(bodies.map((body) => body.data.status).sort()).toEqual(["already_pending", "created"]);
    expect(new Set(bodies.map((body) => body.data.proposal_id)).size).toBe(1);
    const pending = await proposalRepo.findPending("ws-1");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.dossier_ref).toBe("inspector.strict_governance_promotion");
    expect(notifyEntry).toHaveBeenCalledTimes(1);
  });

  it("audits promote-strictly-governed notification failures durably", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const app = new Hono();
    const workspaceService = { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) };
    const memoryService = {
      findByIdScoped: vi.fn(async () => ({ object_id: "mem-1" }))
    };
    const proposalService = {
      findByWorkspaceId: vi.fn(async () => []),
      findPending: vi.fn(async () => [])
    };
    const createProposalWithEventsIfAbsent = vi.fn(async (input: { proposal: { proposal_id: string } }) => ({
      proposal: input.proposal,
      events: [{ event_id: "evt-1" }],
      status: "created" as const
    }));
    const append = createAuditEventLogAppend();
    const notifyEntry = vi.fn(async () => {
      throw new Error("notifier unavailable");
    });
    registerProposalRoutes(app, proposalRouteServices({
      workspaceService,
      memoryService,
      proposalService,
      proposalRepo: { createProposalWithEventsIfAbsent },
      eventLogRepo: { append },
      runtimeNotifier: { notifyEntry },
      mcpMemoryToolHandler: { call: vi.fn() }
    }));

    const response = await app.request(
      "/workspaces/ws-1/soul/memory/mem-1/proposals/promote-strictly-governed",
      { method: "POST" }
    );

    expect(response.status).toBe(200);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: RuntimeGovernanceEventType.RUNTIME_SIDE_EFFECT_FAILED,
        entity_type: "proposal",
        workspace_id: "ws-1",
        caused_by: "inspector",
        payload_json: expect.objectContaining({
          source: "daemon.proposals.promote_strictly_governed",
          operation: "runtime_notify",
          committed_event_id: "evt-1",
          error_message: "notifier unavailable"
        })
      })
    );
    emitWarning.mockRestore();
  });
});
