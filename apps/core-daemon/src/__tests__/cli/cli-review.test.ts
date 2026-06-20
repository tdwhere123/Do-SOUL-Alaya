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

  it("lists pending proposals via soul.list_pending_proposals", async () => {
    const stdout = new PassThrough();
    const stdoutChunks: string[] = [];
    stdout.on("data", (chunk) => stdoutChunks.push(chunk.toString()));
    const handler = createHandler({
      "soul.list_pending_proposals": ({ arguments: args }) => ({
        ok: true,
        tool_name: "soul.list_pending_proposals",
        output: {
          proposals: [
            {
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
            }
          ],
          total_count: 1,
          requestArgs: args
        }
      })
    });
    const command = createReviewCommand({
      handler,
      defaultWorkspaceId: "ws1",
      defaultAgentTarget: "cli-test"
    });
    const parsed = command.argsSchema.safeParse(["pending", "--limit", "10"]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const result = await command.handler(createContext({ stdout }), parsed.data);
    expect(result.exitCode).toBe(ALAYA_SYSEXITS.OK);
    const output = stdoutChunks.join("");
    expect(output).toContain(
      "proposal_id\ttarget_kind\ttarget_id\tcreated_at\treviewer\tdeadline\tqueue_state\tchange_summary\tproposed_changes"
    );
    expect(output).toContain("prop-1");
    expect(output).toContain("user:local-reviewer\t-\topen");
    // invariant: workspace_id MUST NOT be in the request payload; it
    // is bound from the McpMemoryToolCallContext that the CLI builds
    // from defaultWorkspaceId / env / overrides.
    expect(handler.call).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "soul.list_pending_proposals",
        arguments: { limit: 10 },
        context: expect.objectContaining({ workspaceId: "ws1" })
      })
    );
  });

  it("lists pending edge proposals via soul.list_pending_edge_proposals with filters", async () => {
    const stdout = new PassThrough();
    const stdoutChunks: string[] = [];
    stdout.on("data", (chunk) => stdoutChunks.push(chunk.toString()));
    const handler = createHandler({
      "soul.list_pending_edge_proposals": ({ arguments: args }) => ({
        ok: true,
        tool_name: "soul.list_pending_edge_proposals",
        output: {
          proposals: [
            {
              proposal_id: "edge-prop-1",
              source_memory_id: "mem-a",
              target_memory_id: "mem-b",
              edge_type: "recalls",
              trigger_source: "recall_cross_link",
              confidence: 0.75,
              reason: "co-used in report_context_usage",
              source_signal_id: null,
              run_id: "run-1",
              created_at: "2026-05-24T00:00:00.000Z",
              expires_at: null
            }
          ],
          total_count: 1,
          requestArgs: args
        }
      })
    });
    const command = createReviewCommand({
      handler,
      defaultWorkspaceId: "ws1",
      defaultAgentTarget: "cli-test"
    });
    const parsed = command.argsSchema.safeParse([
      "edges",
      "pending",
      "--type",
      "recalls",
      "--min-conf",
      "0.7",
      "--since",
      "2026-05-24T00:00:00.000Z",
      "--limit",
      "5"
    ]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const result = await command.handler(createContext({ stdout }), parsed.data);

    expect(result.exitCode).toBe(ALAYA_SYSEXITS.OK);
    const output = stdoutChunks.join("");
    expect(output).toContain(
      "proposal_id\tsource_memory_id\ttarget_memory_id\tedge_type\ttrigger_source\tconfidence\tcreated_at\treason"
    );
    expect(output).toContain("edge-prop-1\tmem-a\tmem-b\trecalls\trecall_cross_link\t0.75");
    expect(handler.call).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "soul.list_pending_edge_proposals",
        arguments: {
          edge_type: "recalls",
          min_confidence: 0.7,
          since: "2026-05-24T00:00:00.000Z",
          limit: 5
        },
        context: expect.objectContaining({ workspaceId: "ws1" })
      })
    );
  });

  it("requires --reviewer for accept/reject and threads it into the call", async () => {
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));

    const handler = createHandler({});
    const command = createReviewCommand({ handler, defaultWorkspaceId: "ws1" });

    const noReviewer = command.argsSchema.safeParse(["accept", "prop-1"]);
    expect(noReviewer.success).toBe(true);
    if (!noReviewer.success) return;
    const noReviewerResult = await command.handler(createContext({ stderr }), noReviewer.data);
    expect(noReviewerResult.exitCode).toBe(ALAYA_SYSEXITS.USAGE);
    expect(stderrChunks.join("")).toContain("--reviewer");

    const acceptCall = command.argsSchema.safeParse([
      "accept",
      "prop-1",
      "--reviewer",
      "user:alice",
      "--reason",
      "looks right"
    ]);
    expect(acceptCall.success).toBe(true);
    if (!acceptCall.success) return;
    const handlerWithReview = createHandler({
      "soul.review_memory_proposal": () => ({
        ok: true,
        tool_name: "soul.review_memory_proposal",
        output: { proposal_id: "prop-1", resolution_state: "accepted" }
      })
    });
    const acceptCommand = createReviewCommand({
      handler: handlerWithReview,
      defaultWorkspaceId: "ws1"
    });
    const acceptStdout = new PassThrough();
    const acceptStdoutChunks: string[] = [];
    acceptStdout.on("data", (chunk) => acceptStdoutChunks.push(chunk.toString()));
    const acceptResult = await acceptCommand.handler(createContext({ stdout: acceptStdout }), acceptCall.data);
    expect(acceptResult.exitCode).toBe(ALAYA_SYSEXITS.OK);
    expect(acceptStdoutChunks.join("")).toContain("durable_apply=applied");
    expect(handlerWithReview.call).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "soul.review_memory_proposal",
        arguments: expect.objectContaining({
          proposal_id: "prop-1",
          verdict: "accept",
          reason: "looks right",
          reviewer_identity: "user:alice"
        })
      })
    );
  });

  it("falls back to ALAYA_REVIEWER_IDENTITY when --reviewer is omitted", async () => {
    const handler = createHandler({
      "soul.review_memory_proposal": () => ({
        ok: true,
        tool_name: "soul.review_memory_proposal",
        output: { proposal_id: "prop-1", resolution_state: "rejected" }
      })
    });
    const command = createReviewCommand({ handler, defaultWorkspaceId: "ws1" });
    const parsed = command.argsSchema.safeParse(["reject", "prop-1", "--reason", "bad fit"]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const ctx = createContext({ env: { ALAYA_REVIEWER_IDENTITY: "user:env" } });
    const result = await command.handler(ctx, parsed.data);
    expect(result.exitCode).toBe(ALAYA_SYSEXITS.OK);
    expect(handler.call).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: expect.objectContaining({ reviewer_identity: "user:env" })
      })
    );
  });

  it("uses ALAYA_REVIEWER_TOKEN and ALAYA_REVIEWER_IDENTITY as the server-bound reviewer", async () => {
    const handler = createHandler({
      "soul.review_memory_proposal": () => ({
        ok: true,
        tool_name: "soul.review_memory_proposal",
        output: { proposal_id: "prop-1", resolution_state: "accepted" }
      })
    });
    const command = createReviewCommand({ handler, defaultWorkspaceId: "ws1" });
    const parsed = command.argsSchema.safeParse(["accept", "prop-1", "--reason", "approved"]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const result = await command.handler(
      createContext({
        env: {
          ALAYA_REVIEWER_TOKEN: "review-token",
          ALAYA_REVIEWER_IDENTITY: "user:server-reviewer"
        }
      }),
      parsed.data
    );

    expect(result.exitCode).toBe(ALAYA_SYSEXITS.OK);
    expect(handler.call).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: expect.objectContaining({
          reviewer_identity: "user:server-reviewer",
          reviewer_token: "review-token"
        })
      })
    );
  });

  it("reviews edge proposals through the dedicated human CLI surface", async () => {
    const handler = createHandler({
      "soul.batch_review_edge_proposals": () => ({
        ok: true,
        tool_name: "soul.batch_review_edge_proposals",
        output: {
          accepted_count: 1,
          rejected_count: 0,
          reviewed_proposal_ids: ["edge-prop-1"]
        }
      })
    });
    const command = createReviewCommand({ handler, defaultWorkspaceId: "ws1" });
    const parsed = command.argsSchema.safeParse([
      "edges",
      "accept",
      "edge-prop-1",
      "--type",
      "recalls",
      "--min-conf",
      "0.5",
      "--reason",
      "approved",
      "--reviewer",
      "user:server-reviewer"
    ]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const result = await command.handler(
      createContext({
        env: {
          ALAYA_REVIEWER_TOKEN: "review-token",
          ALAYA_REVIEWER_IDENTITY: "user:server-reviewer"
        }
      }),
      parsed.data
    );

    expect(result.exitCode).toBe(ALAYA_SYSEXITS.OK);
    expect(handler.call).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "soul.batch_review_edge_proposals",
        arguments: {
          verdict: "accept",
          filter: {
            proposal_ids: ["edge-prop-1"],
            edge_type: "recalls",
            min_confidence: 0.5
          },
          reason: "approved",
          reviewer_identity: "user:server-reviewer",
          reviewer_token: "review-token"
        },
        context: expect.objectContaining({
          workspaceId: "ws1",
          runId: null,
          agentTarget: "cli"
        })
      })
    );
  });
});
