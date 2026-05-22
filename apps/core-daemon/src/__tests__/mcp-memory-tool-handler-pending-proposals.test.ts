import { describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  ProposalResolutionState,
  ScopeClass,
  type CandidateMemorySignal,
  type ContextDeliveryRecord,
  type MemoryEntry,
  type Proposal,
  type SoulPendingProposalSummary,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";
import {
  createMcpMemoryToolHandler,
  type McpMemoryToolHandlerDependencies
} from "../mcp-memory-tool-handler.js";

const context = {
  workspaceId: "ws1",
  runId: "run1",
  agentTarget: "codex",
      sessionId: "mcp-memory-tool-handler-pending-proposals-session",
};

describe("mcp memory tool handler — soul.list_pending_proposals (A1)", () => {
  it("forwards workspace + filters and returns the projected summary list", async () => {
    const summary: SoulPendingProposalSummary = {
      proposal_id: "prop-1",
      target_object_id: "mem-1",
      target_object_kind: "memory_entry",
      created_at: "2026-04-30T00:00:00.000Z",
      proposed_change_summary: "Switch to pnpm",
      proposed_changes: { content: "Use pnpm for workspace commands." },
      assigned_reviewer_identity: "user:local-reviewer",
      assigned_at: "2026-04-30T00:00:00.000Z",
      deadline_at: null,
      is_overdue: false
    };
    const listPendingProposals = vi.fn(async () => ({
      proposals: [summary],
      total_count: 1
    }));
    const deps = createDeps({ listPendingProposals });
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.list_pending_proposals",
      arguments: { limit: 25 },
      context
    });

    expect(result.ok).toBe(true);
    expect(listPendingProposals).toHaveBeenCalledWith(
      { limit: 25 },
      context
    );
    expect(result.ok && result.output).toEqual({
      proposals: [summary],
      total_count: 1
    });
  });

  it("rejects a workspace_id payload field at schema parse time (A1 finding-2)", async () => {
    // workspace_id is no longer declared on the request schema; .strict()
    // rejects it at parse time. An attached agent that tries to spoof a
    // foreign workspace via the payload fails closed before reaching the
    // workflow.
    const listPendingProposals = vi.fn();
    const deps = createDeps({ listPendingProposals });
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.list_pending_proposals",
      arguments: { workspace_id: "ws-foreign" },
      context
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" }
    });
    expect(listPendingProposals).not.toHaveBeenCalled();
  });

  it("fails closed when the proposal workflow is unavailable", async () => {
    const handler = createMcpMemoryToolHandler(createDeps({ omitWorkflow: true }));

    const result = await handler.call({
      toolName: "soul.list_pending_proposals",
      arguments: {},
      context
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" }
    });
  });

  it("threads reviewer_identity into the workflow review call", async () => {
    const reviewMemoryProposal = vi.fn(async () => ({
      proposal_id: "prop-1",
      resolution_state: ProposalResolutionState.ACCEPTED satisfies Proposal["resolution_state"]
    }));
    const deps = createDeps({ reviewMemoryProposal });
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.review_memory_proposal",
      arguments: {
        proposal_id: "prop-1",
        verdict: "accept",
        reason: "looks right",
        reviewer_identity: "user:alice"
      },
      context
    });

    expect(result.ok).toBe(true);
    expect(reviewMemoryProposal).toHaveBeenCalledWith(
      expect.objectContaining({ reviewer_identity: "user:alice" }),
      context
    );
  });
});

interface CreateDepsOptions {
  readonly listPendingProposals?: (...args: unknown[]) => Promise<{
    readonly proposals: readonly SoulPendingProposalSummary[];
    readonly total_count: number;
  }>;
  readonly reviewMemoryProposal?: (...args: unknown[]) => Promise<{
    readonly proposal_id: string;
    readonly resolution_state: Proposal["resolution_state"];
  }>;
  readonly omitWorkflow?: boolean;
}

function createDeps(options: CreateDepsOptions = {}): McpMemoryToolHandlerDependencies {
  let idCounter = 0;
  const proposalWorkflow = options.omitWorkflow
    ? undefined
    : {
        proposeMemoryUpdate: vi.fn(async () => ({ proposal_id: "prop-1", status: "created" as const })),
        reviewMemoryProposal:
          options.reviewMemoryProposal ??
          vi.fn(async () => ({
            proposal_id: "prop-1",
            resolution_state: ProposalResolutionState.ACCEPTED satisfies Proposal["resolution_state"]
          })),
        listPendingProposals:
          options.listPendingProposals ??
          vi.fn(async () => ({ proposals: [], total_count: 0 }))
      };

  return {
    now: () => "2026-04-30T00:00:00.000Z",
    generateId: () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`,
    recallService: {
      recall: vi.fn(async () => ({
        candidates: [],
        active_constraints: [],
        active_constraints_count: 0,
        total_scanned: 0,
        coarse_filter_count: 0,
        fine_assessment_count: 0
      }))
    },
    memoryService: {
      findById: vi.fn(async () => createMemory()),
      findByIdScoped: vi.fn(async () => createMemory()),
      update: vi.fn(async (_objectId, fields) => createMemory(fields)),
      updateScoped: vi.fn(async (_objectId, _workspaceId, fields) => createMemory(fields))
    },
    signalService: {
      receiveSignal: vi.fn(async (signal: CandidateMemorySignal) => ({ signal }))
    },
    graphExploreService: {
      exploreOneHop: vi.fn(async () => [])
    },
    sessionOverrideService: {
      apply: vi.fn(async () => ({ runtime_id: "override1" }))
    },
    trustStateRecorder: {
      recordDelivery: vi.fn(async (input: Omit<ContextDeliveryRecord, "audit_event_id">) => ({
        ...input,
        audit_event_id: "event1"
      })),
      recordUsage: vi.fn(async (input: Omit<UsageProofRecord, "audit_event_id">) => ({
        ...input,
        audit_event_id: "event2"
      }))
    },
    ...(proposalWorkflow ? { proposalWorkflow } : {})
  };
}

function createMemory(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "mem1",
    object_kind: "memory_entry",
    schema_version: 1,
    created_at: "2026-04-30T00:00:00.000Z",
    updated_at: "2026-04-30T00:00:00.000Z",
    created_by: "test",
    lifecycle_state: "active",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "deployment rules",
    domain_tags: [],
    evidence_refs: [],
    workspace_id: "ws1",
    run_id: "run1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.9,
    retention_score: 0.9,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 1,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}
