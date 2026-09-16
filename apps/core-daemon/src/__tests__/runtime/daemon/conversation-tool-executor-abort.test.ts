import { describe, expect, it, vi } from "vitest";
import { createConversationToolExecutor } from "../../../runtime/daemon/support/conversation-tool-executor.js";

const HANDLER_TIMEOUT = {
  error_code: "handler_timeout",
  message: "MCP tool execution timed out.",
  error_type: "TimeoutError"
} as const;

function createExecutor(insert = vi.fn()) {
  return {
    insert,
    executor: createConversationToolExecutor({
      eventLogRepo: {} as never,
      runtimeNotifier: { notifyEntry: vi.fn() } as never,
      toolExecutionRecordRepo: { insert } as never,
      toolGovernanceClient: {} as never,
      targetRevalidateService: {},
      strongRefService: {} as never,
      canonicalAliasService: {} as never
    })
  };
}

describe("conversation tool executor abort", () => {
  it("does not run the tool handler when the abort signal is already set", async () => {
    const { insert, executor } = createExecutor();
    const handler = vi.fn(async () => ({ ok: true }));
    const abort = new AbortController();
    abort.abort(HANDLER_TIMEOUT);

    await expect(
      executor.execute({
        toolId: "tools.read_file",
        rawInput: { path: "README.md" },
        runtimeContext: { run_id: "run-1", workspace_id: "workspace-1" },
        workspaceRoot: "/tmp",
        abortSignal: abort.signal,
        handler
      })
    ).rejects.toEqual(HANDLER_TIMEOUT);
    expect(handler).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("does not write the tool-execution audit row when abort fires during the handler", async () => {
    const { insert, executor } = createExecutor();
    const abort = new AbortController();
    const handler = vi.fn(async () => {
      abort.abort(HANDLER_TIMEOUT);
      return { ok: true };
    });

    await expect(
      executor.execute({
        toolId: "tools.read_file",
        rawInput: { path: "README.md" },
        runtimeContext: { run_id: "run-1", workspace_id: "workspace-1" },
        workspaceRoot: "/tmp",
        abortSignal: abort.signal,
        handler
      })
    ).rejects.toEqual(HANDLER_TIMEOUT);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
  });
});
