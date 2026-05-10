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
        contextProvider: () => ({ workspaceId: "ws1", runId: null, agentTarget: "codex", sessionId: "review-parity-mcp-session" })
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
          memoryService: { findByIdScoped: vi.fn(async () => null) } as any,
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
      workspaceId: "ws1",
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

// gate-6-delta I2: the original parity test only proves the success
// path. Error-shape parity across MCP / Inspector HTTP / CLI was
// claimed but not verified. These cases drive each surface through
// the same workflow with an injected failure and assert error.code +
// error.message identity. Per-surface transport severity (HTTP
// status, CLI exit code) intentionally differs by design and is
// asserted as deterministic-per-surface, not equal across surfaces.

interface ReviewParitySurfaces {
  readonly mcp: { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };
  readonly inspector: { readonly status: number; readonly body: { readonly error?: { readonly code?: string; readonly message?: string } } };
  readonly cli: { readonly exitCode: number; readonly stderr: string; readonly json: unknown };
}

async function runReviewParityScenario(
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
      }
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
    "/api/proposals/ws1/prop-1/review?token=inspector-token",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
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

function createErrorReviewHandler(
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

describe("proposal review error parity (gate-6-delta I2)", () => {
  it("returns identical NOT_FOUND envelope across MCP, Inspector HTTP, and CLI when proposal_id is unknown", async () => {
    const { mcp, inspector, cli } = await runReviewParityScenario(() =>
      createErrorReviewHandler({ kind: "proposal_not_found" })
    );

    expect(mcp.ok).toBe(false);
    expect(mcp.error.code).toBe("NOT_FOUND");
    const expectedMessage = "Proposal not found: prop-1";
    expect(mcp.error.message).toBe(expectedMessage);

    expect(inspector.body.error?.code).toBe(mcp.error.code);
    expect(inspector.body.error?.message).toBe(mcp.error.message);
    expect([404, 400]).toContain(inspector.status);

    expect(cli.exitCode).not.toBe(ALAYA_SYSEXITS.OK);
    expect(cli.stderr).toContain("NOT_FOUND");
    expect(cli.stderr).toContain(expectedMessage);
  });

  it("returns identical VALIDATION envelope when the proposal is already accepted", async () => {
    const { mcp, inspector, cli } = await runReviewParityScenario(() =>
      createErrorReviewHandler({ kind: "already_resolved" })
    );

    expect(mcp.ok).toBe(false);
    expect(mcp.error.code).toBe("VALIDATION");
    expect(mcp.error.message).toContain("already accepted");

    expect(inspector.body.error?.code).toBe(mcp.error.code);
    expect(inspector.body.error?.message).toBe(mcp.error.message);

    expect(cli.exitCode).not.toBe(ALAYA_SYSEXITS.OK);
    expect(cli.stderr).toContain("VALIDATION");
    expect(cli.stderr).toContain("already accepted");
  });

  it("returns identical NOT_FOUND envelope when the target memory is missing in the workspace", async () => {
    const { mcp, inspector, cli } = await runReviewParityScenario(() =>
      createErrorReviewHandler({ kind: "target_memory_missing" })
    );

    expect(mcp.ok).toBe(false);
    expect(mcp.error.code).toBe("NOT_FOUND");
    expect(mcp.error.message).toContain("Target memory object not found");

    expect(inspector.body.error?.code).toBe(mcp.error.code);
    expect(inspector.body.error?.message).toBe(mcp.error.message);

    expect(cli.exitCode).not.toBe(ALAYA_SYSEXITS.OK);
    expect(cli.stderr).toContain("NOT_FOUND");
  });

  it("returns identical VALIDATION envelope when validateUpdate rejects (e.g. archived memory)", async () => {
    const message = "Cannot update archived memory entry mem-1.";
    const { mcp, inspector, cli } = await runReviewParityScenario(() =>
      createErrorReviewHandler({ kind: "validate_update_rejected", message })
    );

    expect(mcp.ok).toBe(false);
    expect(mcp.error.code).toBe("VALIDATION");
    expect(mcp.error.message).toBe(message);

    expect(inspector.body.error?.code).toBe(mcp.error.code);
    expect(inspector.body.error?.message).toBe(mcp.error.message);

    expect(cli.exitCode).not.toBe(ALAYA_SYSEXITS.OK);
    expect(cli.stderr).toContain("VALIDATION");
    expect(cli.stderr).toContain(message);
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

function createParityMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
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
    run_id: null,
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

type _UsedTypes = readonly [EventLogEntry, MemoryEntry, McpMemoryToolCallContext];
