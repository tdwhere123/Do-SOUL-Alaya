import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  ControlPlaneObjectKind,
  ProposalOptionKind,
  ProposalResolutionState,
  RetentionPolicy,
  type CandidateMemorySignal,
  type ContextDeliveryRecord,
  type EventLogEntry,
  type MemoryEntry,
  type Proposal,
  type RecallCandidate,
  type RecallPolicy,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";

import { createApp } from "../../runtime/app.js";

import type { ProposalRouteServices } from "../../routes/governance/proposals.js";

import { ALAYA_SYSEXITS, type AlayaCliContext } from "../../cli/bridge.js";

import { createReviewCommand } from "../../cli/review.js";

import { callAlayaMcpMemoryTool } from "../../mcp/mcp-server.js";

import { createMcpMemoryProposalWorkflow } from "../../mcp-memory/proposal-workflow.js";

import {
  createMcpMemoryToolHandler,
  type McpMemoryToolCallContext,
  type McpMemoryToolHandler,
  type McpMemoryToolHandlerDependencies
} from "../../mcp-memory/tool-handler.js";

import { createInspectorApp } from "../../../../inspector/src/runtime/app.js";

export const reviewerArgs = {
  proposal_id: "prop-1",
  verdict: "accept",
  reason: "approved locally",
  reviewer_identity: "user:server-reviewer",
  reviewer_token: "review-token"
} as const;

// Error-shape parity across MCP / Inspector HTTP / CLI must cover the
// failure path, not just successful review. These cases drive each
// surface through the same workflow with an injected failure and assert
// error.code + error.message identity. Per-surface transport severity
// intentionally differs by design and is asserted as deterministic per
// surface, not equal across surfaces.

export interface ReviewParitySurfaces {
  readonly mcp: { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };
  readonly inspector: { readonly status: number; readonly body: { readonly error?: { readonly code?: string; readonly message?: string } } };
  readonly cli: { readonly exitCode: number; readonly stderr: string; readonly json: unknown };
}

export async function runReviewParityScenario(
  buildHandler: () => McpMemoryToolHandler
): Promise<ReviewParitySurfaces> {
  const mcpResult = await callAlayaMcpMemoryTool(
    {
      memoryToolHandler: buildHandler(),
      contextProvider: () => ({ workspaceId: "ws1", runId: null, agentTarget: "codex", sessionId: "review-parity-buildhandler-session" })
    },
    "soul.review_memory_proposal",
    reviewerArgs
  );
  const mcpEnvelope = mcpResult.structuredContent as ReviewParitySurfaces["mcp"];

  const daemonApp = createApp({
    requestProtection: {
      allowedOrigin: "http://localhost:5173",
      requestToken: "daemon-request-token"
    },
    routes: {
      proposals: {
        workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws1" })) } as any,
        memoryService: { findByIdScoped: vi.fn(async () => null) } as any,
        proposalService: {
          findByWorkspaceId: vi.fn(async () => []),
          findPending: vi.fn(async () => [])
        } as any,
        mcpMemoryToolHandler: buildHandler()
      } as unknown as ProposalRouteServices
    }
  });
  const inspectorApp = createInspectorApp({
    token: "inspector-token",
    workspaceId: "ws1",
    daemonUrl: "http://daemon.local",
    env: {
      ALAYA_REQUEST_TOKEN: "daemon-request-token",
      ALAYA_REVIEWER_TOKEN: "review-token",
      ALAYA_REVIEWER_IDENTITY: "user:server-reviewer"
    },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      return await daemonApp.request(`${url.pathname}${url.search}`, {
        method: init?.method,
        headers: init?.headers,
        body: init?.body
      });
    }
  });
  const inspectorResponse = await inspectorApp.request(
    "/api/proposals/ws1/prop-1/review",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-alaya-inspector-token": "inspector-token"
      },
      body: JSON.stringify({
        verdict: reviewerArgs.verdict,
        reason: reviewerArgs.reason,
        reviewer_identity: "user:server-reviewer"
      })
    }
  );
  const inspectorBody = (await inspectorResponse.json()) as ReviewParitySurfaces["inspector"]["body"];

  const cliCommand = createReviewCommand({
    handler: buildHandler(),
    defaultWorkspaceId: "ws1",
    defaultReviewerIdentity: "user:server-reviewer",
    defaultReviewerToken: "review-token"
  });
  const parsedCli = cliCommand.argsSchema.safeParse(["accept", "prop-1", "--reason", "approved locally"]);
  if (!parsedCli.success) {
    throw new Error("CLI args parse failed in test setup");
  }
  const cliStderrChunks: string[] = [];
  const cliCtx = createContext();
  cliCtx.stderr.on("data", (chunk: Buffer) => cliStderrChunks.push(chunk.toString("utf8")));
  const cliResult = await cliCommand.handler(cliCtx, parsedCli.data);

  return {
    mcp: mcpEnvelope,
    inspector: { status: inspectorResponse.status, body: inspectorBody },
    cli: {
      exitCode: cliResult.exitCode,
      stderr: cliStderrChunks.join(""),
      json: cliResult.json
    }
  };
}

export function createErrorReviewHandler(
  scenario:
    | { readonly kind: "proposal_not_found" }
    | { readonly kind: "already_resolved" }
    | { readonly kind: "target_memory_missing" }
    | { readonly kind: "validate_update_rejected"; readonly message: string }
): McpMemoryToolHandler {
  const proposal = createProposal();
  const acceptedProposal: Proposal = {
    ...proposal,
    resolution_state: ProposalResolutionState.ACCEPTED
  };
  const proposalWorkflow = createMcpMemoryProposalWorkflow({
    now: () => "2026-04-30T00:00:00.000Z",
    generateObjectId: () => "prop-1",
    reviewerIdentityBinding: {
      token: "review-token",
      identity: "user:server-reviewer"
    },
    eventLogRepo: {
      append: async () => {
        throw new Error("append must not be called on the error path");
      },
      queryByEntity: async () => []
    },
    proposalRepo: {
      create: async () => proposal,
      createProposalWithEvents: async () => ({ proposal, events: [] }),
      findById: async () => proposal,
      findScopedById: async () => {
        if (scenario.kind === "proposal_not_found") {
          return null;
        }
        const base = {
          workspace_id: "ws1",
          run_id: null as string | null,
          reviewer_assignment: { reviewer_identity: "user:server-reviewer" },
          proposed_changes: { content: "approved locally" }
        };
        if (scenario.kind === "already_resolved") {
          return { ...base, proposal: acceptedProposal };
        }
        return { ...base, proposal };
      },
      findPendingSummaries: async () => [],
      acceptPendingMemoryUpdateWithEvents: async () => {
        throw new Error("acceptPendingMemoryUpdateWithEvents must not be reached on the error path");
      },
      updatePendingResolutionWithEvents: async () => {
        throw new Error("updatePendingResolutionWithEvents must not be reached on the error path");
      }
    },
    runtimeNotifier: { notifyEntry: async () => {} },
    memoryService: {
      findByIdScoped: async () => {
        if (scenario.kind === "target_memory_missing") {
          return null;
        }
        return { object_id: "mem-1" };
      },
      validateUpdate: async () => {
        if (scenario.kind === "validate_update_rejected") {
          const error = new Error(scenario.message) as Error & { code: string };
          error.code = "VALIDATION";
          throw error;
        }
      },
      update: async (objectId: string, fields) =>
        createParityMemoryEntry({ object_id: objectId, ...fields })
    }
  });
  return createMcpMemoryToolHandler({
    ...createBaseDeps(),
    proposalWorkflow
  });
}

export function createReviewHandler(): McpMemoryToolHandler {
  const proposal = createProposal();
  let storedProposal = proposal;
  const proposalWorkflow = createMcpMemoryProposalWorkflow({
    now: () => "2026-04-30T00:00:00.000Z",
    generateObjectId: () => "prop-1",
    reviewerIdentityBinding: {
      token: "review-token",
      identity: "user:server-reviewer"
    },
    eventLogRepo: {
      append: async () => {
        throw new Error("append must not be called");
      },
      queryByEntity: async () => []
    },
    proposalRepo: {
      create: async () => proposal,
      createProposalWithEvents: async () => ({ proposal, events: [] }),
      findById: async () => storedProposal,
      findScopedById: async () => ({
        proposal: storedProposal,
        workspace_id: "ws1",
        run_id: null,
        reviewer_assignment: { reviewer_identity: "user:server-reviewer" },
        proposed_changes: { content: "approved locally" }
      }),
      findPendingSummaries: async () => [],
      acceptPendingMemoryUpdateWithEvents: async (_proposalId, updatedAt, events, memoryUpdate, options) => {
        expect(options?.reviewerIdentity).toBe("user:server-reviewer");
        expect(memoryUpdate.caused_by).toBe(`proposal_accept:${proposal.proposal_id}`);
        expect(events.map((event) => event.caused_by)).toEqual([
          "user:server-reviewer",
          "user:server-reviewer",
          "user:server-reviewer"
        ]);
        storedProposal = {
          ...storedProposal,
          resolution_state: "accepted",
          last_updated_at: updatedAt
        };
        return {
          proposal: storedProposal,
          events: events.map((event, index) => ({
            ...event,
            event_id: `event-${index}`,
            created_at: updatedAt,
            revision: index + 1
          }))
        };
      },
      updatePendingResolutionWithEvents: async () => {
        throw new Error("reject path not exercised in this test");
      }
    },
    runtimeNotifier: { notifyEntry: async () => {} },
    memoryService: {
      findByIdScoped: async (objectId: string) => ({ object_id: objectId }),
      validateUpdate: async () => {},
      update: async (objectId: string, fields) => createParityMemoryEntry({ object_id: objectId, ...fields })
    }
  });

  return createMcpMemoryToolHandler({
    ...createBaseDeps(),
    proposalWorkflow
  });
}

export function createBaseDeps(): Omit<McpMemoryToolHandlerDependencies, "proposalWorkflow"> {
  return {
    now: () => "2026-04-30T00:00:00.000Z",
    generateId: () => "00000000-0000-4000-8000-000000000001",
    recallService: {
      recall: async (_params: {
        readonly taskSurface: unknown;
        readonly workspaceId: string;
        readonly strategy: "chat" | "analyze" | "build" | "govern";
        readonly runId?: string | null;
        readonly policyOverride?: Readonly<RecallPolicy>;
      }): Promise<{
        readonly candidates: readonly Readonly<RecallCandidate>[];
        readonly active_constraints: readonly [];
        readonly active_constraints_count: 0;
        readonly total_scanned: number;
        readonly coarse_filter_count: number;
        readonly fine_assessment_count: number;
      }> => ({
        candidates: [],
        active_constraints: [],
        active_constraints_count: 0,
        total_scanned: 0,
        coarse_filter_count: 0,
        fine_assessment_count: 0
      })
    },
    memoryService: {
      findById: async () => null,
      findByIdScoped: async () => null,
      validateUpdate: async () => {},
      update: async (_objectId, fields) => createParityMemoryEntry(fields)
    },
    signalService: {
      receiveSignal: async (signal: CandidateMemorySignal) => ({ signal })
    },
    graphExploreService: {
      exploreOneHop: async () => []
    },
    sessionOverrideService: {
      apply: async () => ({ runtime_id: "override-1" })
    },
    trustStateRecorder: {
      recordDelivery: async (input: Omit<ContextDeliveryRecord, "audit_event_id">) => ({
        ...input,
        audit_event_id: "event-delivery"
      }),
      recordUsage: async (input: Omit<UsageProofRecord, "audit_event_id">) => ({
        ...input,
        audit_event_id: "event-usage"
      }),
      findDeliveryById: async () => null
    }
  };
}

export function createContext(overrides: Partial<AlayaCliContext> = {}): AlayaCliContext {
  return {
    cwd: "/tmp",
    env: {},
    argv: [],
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    isTTY: false,
    daemon: { startupSteps: [] },
    ...overrides
  };
}

export function createProposal(): Proposal {
  return {
    runtime_id: "prop-1",
    object_kind: ControlPlaneObjectKind.PROPOSAL,
    task_surface_ref: null,
    expires_at: null,
    derived_from: "mem-1",
    retention_policy: RetentionPolicy.SESSION_ONLY,
    proposal_id: "prop-1",
    dossier_ref: null,
    recommended_option_id: null,
    proposal_options: [
      {
        option_id: "option-1",
        option_kind: ProposalOptionKind.REQUEST_CONFIRMATION,
        preserves_protected_constraints: true,
        dropped_candidates: [],
        unresolved_after_apply: [],
        requires_confirmation: true
      }
    ],
    resolution_state: ProposalResolutionState.PENDING,
    last_updated_at: "2026-04-30T00:00:00.000Z"
  };
}

export function createParityMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "mem-1",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-04-30T00:00:00.000Z",
    updated_at: "2026-04-30T00:00:00.000Z",
    created_by: "test",
    dimension: "preference",
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: "project",
    content: "approved locally",
    domain_tags: [],
    evidence_refs: [],
    workspace_id: "ws1",
    // MemoryEntry.run_id is a non-empty string in the schema; this fixture
    // intentionally exercises a run-detached entry, so preserve the null
    // value and bridge the type only.
    run_id: null as unknown as string,
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

export type _UsedTypes = readonly [EventLogEntry, MemoryEntry, McpMemoryToolCallContext];
