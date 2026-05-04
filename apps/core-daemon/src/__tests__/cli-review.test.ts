import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ALAYA_SYSEXITS, type AlayaCliContext } from "../cli/bridge.js";
import { createReviewCommand } from "../cli/review.js";
import type { McpMemoryToolCallResult, McpMemoryToolHandler } from "../mcp-memory-tool-handler.js";

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
              proposed_change_summary: "Switch to pnpm"
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
    expect(stdoutChunks.join("")).toContain("prop-1");
    // A1 fix-loop (finding-2): workspace_id no longer in the request
    // payload; it is bound from the McpMemoryToolCallContext that the
    // CLI builds from defaultWorkspaceId / env / overrides.
    expect(handler.call).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "soul.list_pending_proposals",
        arguments: { limit: 10 },
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
    const acceptResult = await acceptCommand.handler(createContext({}), acceptCall.data);
    expect(acceptResult.exitCode).toBe(ALAYA_SYSEXITS.OK);
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
});

type HandlerStub = Record<string, (input: { arguments: unknown }) => McpMemoryToolCallResult>;

function createHandler(stub: HandlerStub): McpMemoryToolHandler & { call: ReturnType<typeof vi.fn> } {
  const call = vi.fn(async ({ toolName, arguments: args }: { toolName: string; arguments: unknown }) => {
    const handler = stub[toolName];
    if (handler === undefined) {
      return {
        ok: false,
        tool_name: toolName,
        error: { code: "UNKNOWN_TOOL", message: `no stub for ${toolName}` }
      } as const;
    }
    return handler({ arguments: args });
  });
  return { call };
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
