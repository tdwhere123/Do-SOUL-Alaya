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
import { createApp } from "../app.js";
import { ALAYA_SYSEXITS, type AlayaCliContext } from "../cli/bridge.js";
import { createReviewCommand } from "../cli/review.js";
import { callAlayaMcpMemoryTool } from "../mcp-server.js";
import { createMcpMemoryProposalWorkflow } from "../mcp-memory-proposal-workflow.js";
import {
  createMcpMemoryToolHandler,
  type McpMemoryToolCallContext,
  type McpMemoryToolHandler,
  type McpMemoryToolHandlerDependencies
} from "../mcp-memory-tool-handler.js";
import { createInspectorApp } from "../../../inspector/src/app.js";

const reviewerArgs = {
  proposal_id: "prop-1",
  verdict: "accept",
  reason: "approved locally",
  reviewer_identity: "user:server-reviewer",
  reviewer_token: "review-token"
} as const;

describe("proposal review inspector cli parity", () => {
  it("returns the same review response shape through MCP, Inspector HTTP, and CLI", async () => {
    const mcpResult = await callAlayaMcpMemoryTool(
      {
        memoryToolHandler: createReviewHandler(),
        contextProvider: () => ({ workspaceId: "ws1", runId: null, agentTarget: "codex" })
      },
      "soul.review_memory_proposal",
      reviewerArgs
    );
    const mcpOutput = (mcpResult.structuredContent as { readonly output: unknown }).output;

    const daemonApp = createApp({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "daemon-request-token"
      },
      routes: {
        proposals: {
          workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws1" })) } as any,
          proposalService: {
            findByWorkspaceId: vi.fn(async () => []),
            findPending: vi.fn(async () => [])
          } as any,
          mcpMemoryToolHandler: createReviewHandler()
        }
      }
    });

    const forwardedInspectorRequests: Array<{
      readonly url: string;
      readonly requestToken: string | null;
      readonly desktop: string | null;
      readonly body: string | null;
    }> = [];
    const inspectorApp = createInspectorApp({
      token: "inspector-token",
      daemonUrl: "http://daemon.local",
      env: {
        ALAYA_REQUEST_TOKEN: "daemon-request-token",
        ALAYA_REVIEWER_TOKEN: "review-token",
        ALAYA_REVIEWER_IDENTITY: "user:server-reviewer"
      },
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        forwardedInspectorRequests.push({
          url: String(input),
          requestToken: headers.get("x-request-token"),
          desktop: headers.get("x-alaya-desktop"),
          body: init?.body === undefined ? null : String(init.body)
        });

        return await daemonApp.request(`${url.pathname}${url.search}`, {
          method: init?.method,
          headers,
          body: init?.body
        });
      }
    });
    const inspectorResponse = await inspectorApp.request("/api/proposals/ws1/prop-1/review?token=inspector-token", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        verdict: reviewerArgs.verdict,
        reason: reviewerArgs.reason,
        reviewer_identity: "user:payload-override"
      })
    });
    expect(inspectorResponse.status).toBe(200);
    const inspectorPayload = (await inspectorResponse.json()) as { readonly data: unknown };

    const cliCommand = createReviewCommand({
      handler: createReviewHandler(),
      defaultWorkspaceId: "ws1",
      defaultReviewerIdentity: "user:server-reviewer",
      defaultReviewerToken: "review-token"
    });
    const parsedCli = cliCommand.argsSchema.safeParse(["accept", "prop-1", "--reason", "approved locally"]);
    expect(parsedCli.success).toBe(true);
    if (!parsedCli.success) return;
    const cliResult = await cliCommand.handler(createContext(), parsedCli.data);

    expect(cliResult.exitCode).toBe(ALAYA_SYSEXITS.OK);
    expect(mcpOutput).toEqual({
      proposal_id: "prop-1",
      resolution_state: ProposalResolutionState.ACCEPTED
    });
    expect(inspectorPayload.data).toEqual(mcpOutput);
    expect(cliResult.json).toEqual(mcpOutput);
    expect(forwardedInspectorRequests).toEqual([
      {
        url: "http://daemon.local/workspaces/ws1/proposals/prop-1/review",
        requestToken: "daemon-request-token",
        desktop: "1",
        body: JSON.stringify({
          verdict: reviewerArgs.verdict,
          reason: reviewerArgs.reason,
          reviewer_identity: reviewerArgs.reviewer_identity,
          reviewer_token: reviewerArgs.reviewer_token
        })
      }
    ]);
  });
});

function createReviewHandler(): McpMemoryToolHandler {
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
        reviewer_assignment: { reviewer_identity: "user:server-reviewer" }
      }),
      findPendingSummaries: async () => [],
      updatePendingResolutionWithEvents: async (_proposalId, state, updatedAt, events, options) => {
        expect(options?.reviewerIdentity).toBe("user:server-reviewer");
        expect(events.map((event) => event.caused_by)).toEqual([
          "user:server-reviewer",
          "user:server-reviewer",
          "user:server-reviewer"
        ]);
        storedProposal = {
          ...storedProposal,
          resolution_state: state,
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
      }
    },
    runtimeNotifier: { notifyEntry: async () => {} }
  });

  return createMcpMemoryToolHandler({
    ...createBaseDeps(),
    proposalWorkflow
  });
}

function createBaseDeps(): Omit<McpMemoryToolHandlerDependencies, "proposalWorkflow"> {
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
        readonly total_scanned: number;
        readonly coarse_filter_count: number;
        readonly fine_assessment_count: number;
      }> => ({
        candidates: [],
        total_scanned: 0,
        coarse_filter_count: 0,
        fine_assessment_count: 0
      })
    },
    memoryService: {
      findById: async () => null,
      findByIdScoped: async () => null
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
      })
    }
  };
}

function createContext(overrides: Partial<AlayaCliContext> = {}): AlayaCliContext {
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

function createProposal(): Proposal {
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

type _UsedTypes = readonly [EventLogEntry, MemoryEntry, McpMemoryToolCallContext];
