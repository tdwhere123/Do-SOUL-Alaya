import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  ControlPlaneObjectKind,
  ProposalOptionKind,
  ProposalResolutionState,
  RetentionPolicy,
  type EventLogEntry,
  type Proposal
} from "@do-soul/alaya-protocol";

import { ALAYA_SYSEXITS, type AlayaCliContext } from "../../cli/bridge.js";

import { createReviewCommand } from "../../cli/review.js";

import { createMcpMemoryProposalWorkflow } from "../../mcp-memory/proposal-workflow.js";

import type {
  McpMemoryToolCallContext,
  McpMemoryToolCallResult,
  McpMemoryToolHandler
} from "../../mcp-memory/tool-handler.js";

type HandlerStub = Record<
  string,
  (input: {
    readonly arguments: unknown;
    readonly context: McpMemoryToolCallContext;
  }) => McpMemoryToolCallResult | Promise<McpMemoryToolCallResult>
>;

function createHandler(stub: HandlerStub): McpMemoryToolHandler & { call: ReturnType<typeof vi.fn> } {
  const call = vi.fn(async (
    { toolName, arguments: args, context }: {
      readonly toolName: string;
      readonly arguments: unknown;
      readonly context: McpMemoryToolCallContext;
    }
  ) => {
    const handler = stub[toolName];
    if (handler === undefined) {
      return {
        ok: false,
        tool_name: toolName,
        error: { code: "UNKNOWN_TOOL", message: `no stub for ${toolName}` }
      } as const;
    }
    return await handler({ arguments: args, context });
  });
  return { call };
}

function createProposal(): Proposal {
  return {
    runtime_id: "00000000-0000-4000-8000-000000000001",
    object_kind: ControlPlaneObjectKind.PROPOSAL,
    task_surface_ref: null,
    expires_at: null,
    derived_from: "mem1",
    retention_policy: RetentionPolicy.SESSION_ONLY,
    proposal_id: "00000000-0000-4000-8000-000000000001",
    dossier_ref: null,
    recommended_option_id: null,
    proposal_options: [
      {
        option_id: "memory_update_00000000-0000-4000-8000-000000000001",
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

function createRunLookup(workspaceByRun: Record<string, string>) {
  return {
    getById: vi.fn(async (runId: string) => ({
      workspace_id: workspaceByRun[runId] ?? "workspace-missing"
    }))
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

describe("alaya review (A1)", () => {

  it("rejects a foreign --run override before review reaches the handler", async () => {
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));
    const handler = createHandler({
      "soul.review_memory_proposal": () => ({
        ok: true,
        tool_name: "soul.review_memory_proposal",
        output: { proposal_id: "prop-1", resolution_state: "accepted" }
      })
    });
    const command = createReviewCommand({
      handler,
      defaultWorkspaceId: "workspace-1",
      runService: createRunLookup({ "run-foreign": "workspace-2" })
    });
    const parsed = command.argsSchema.safeParse([
      "accept",
      "prop-1",
      "--reviewer",
      "user:alice",
      "--run",
      "run-foreign"
    ]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const result = await command.handler(createContext({ stderr }), parsed.data);

    expect(result.exitCode).toBe(ALAYA_SYSEXITS.DATAERR);
    expect(stderrChunks.join("")).toContain(
      "--run run-foreign belongs to workspace workspace-2, not workspace-1."
    );
    expect(handler.call).not.toHaveBeenCalled();
  });

  it("keeps CLI human-reviewer context when ALAYA_AGENT_TARGET points at an attached agent", async () => {
    const proposal = createProposal();
    let storedProposal = proposal;
    let updateCalls = 0;
    const updateMemory = vi.fn(async () => ({ object_id: "mem1" }));
    const workflow = createMcpMemoryProposalWorkflow({
      now: () => "2026-04-30T00:00:00.000Z",
      generateObjectId: () => proposal.proposal_id,
      eventLogRepo: {
        append: async () => {
          throw new Error("append must not be called");
        },
        queryByEntity: async () => []
      },
      proposalRepo: {
        create: async () => proposal,
        createProposalWithEvents: async () => {
          throw new Error("createProposalWithEvents must not be called");
        },
        findById: async () => storedProposal,
        findScopedById: async () => ({
          proposal: storedProposal,
          workspace_id: "ws1",
          run_id: "run-from-agent",
          target_object_id: "mem1",
          proposed_changes: { content: "approved update" }
        }),
        findPendingSummaries: async () => [],
        updatePendingResolutionWithEvents: async () => {
          throw new Error("reject path not exercised in this test");
        },
        acceptPendingMemoryUpdateWithEvents: async (_proposalId, updatedAt, events, memoryUpdate, options) => {
          updateCalls += 1;
          expect(options?.reviewerIdentity).toBe("user:alice");
          expect(memoryUpdate.caused_by).toBe(`proposal_accept:${proposal.proposal_id}`);
          storedProposal = {
            ...storedProposal,
            resolution_state: ProposalResolutionState.ACCEPTED,
            last_updated_at: updatedAt
          };
          return {
            proposal: storedProposal,
            events: events.map((event, index): EventLogEntry => ({
              ...event,
              event_id: `event-${index}`,
              created_at: updatedAt,
              revision: index + 1
            }))
          };
        }
      },
      memoryService: {
        findByIdScoped: async () => ({ object_id: "mem1" }),
        validateUpdate: async () => {},
        update: updateMemory
      },
      runtimeNotifier: { notifyEntry: async () => {} }
    });
    const handler: McpMemoryToolHandler & { call: ReturnType<typeof vi.fn> } = {
      call: vi.fn(async ({ toolName, arguments: args, context }) => {
        if (toolName !== "soul.review_memory_proposal") {
          return {
            ok: false,
            tool_name: toolName,
            error: { code: "UNKNOWN_TOOL", message: `no stub for ${toolName}` }
          } as const;
        }
        try {
          return {
            ok: true,
            tool_name: "soul.review_memory_proposal",
            output: await workflow.reviewMemoryProposal(args as never, context)
          } as const;
        } catch (error) {
          return {
            ok: false,
            tool_name: toolName,
            error: {
              code: error instanceof Error && "code" in error ? error.code as "NOT_FOUND" : "INTERNAL",
              message: error instanceof Error ? error.message : String(error)
            }
          } as const;
        }
      })
    };
    const command = createReviewCommand({ handler, defaultWorkspaceId: "ws1" });
    const parsed = command.argsSchema.safeParse([
      "accept",
      proposal.proposal_id,
      "--reviewer",
      "user:alice",
      "--reason",
      "approved"
    ]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const result = await command.handler(
      createContext({ env: { ALAYA_AGENT_TARGET: "codex" } }),
      parsed.data
    );

    expect(result.exitCode).toBe(ALAYA_SYSEXITS.OK);
    expect(updateCalls).toBe(1);
    expect(updateMemory).not.toHaveBeenCalled();
    expect(handler.call).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          workspaceId: "ws1",
          runId: null,
          agentTarget: "cli",
          sessionId: expect.stringMatching(/^review-cli-/)
        })
      })
    );
  });
});
