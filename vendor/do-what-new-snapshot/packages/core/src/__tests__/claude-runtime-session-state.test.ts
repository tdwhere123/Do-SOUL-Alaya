import { describe, expect, it } from "vitest";
import type { RuntimeSessionConfig } from "@do-what/protocol";
import { ClaudeRuntimeSessionState } from "../runtime-adapters/claude-runtime-session-state.js";

describe("ClaudeRuntimeSessionState", () => {
  it("requires an active turn before creating a pending cancel request", () => {
    const state = createSessionState();

    expect(() => state.ensurePendingCancel()).toThrow(
      "Cannot create a pending cancel request without an active turn."
    );
  });

  it("reuses the same pending cancel request within one active turn", () => {
    const state = createSessionState();
    state.beginTurn();

    const first = state.ensurePendingCancel();
    const second = state.ensurePendingCancel();

    expect(second).toBe(first);
    expect(state.getPendingCancel()).toBe(first);
  });

  it("settles the pending cancel request through the exposed resolver", async () => {
    const state = createSessionState();
    state.beginTurn();

    const pendingCancel = state.ensurePendingCancel();
    pendingCancel.resolve({
      session_id: "session-state-1",
      status: "cancelled"
    });

    await expect(pendingCancel.promise).resolves.toEqual({
      session_id: "session-state-1",
      status: "cancelled"
    });
  });
});

function createSessionState(): ClaudeRuntimeSessionState {
  return new ClaudeRuntimeSessionState(createSessionConfig(), "session-state-1");
}

function createSessionConfig(): RuntimeSessionConfig {
  return {
    role: "worker",
    workspace_id: "workspace-1",
    run_id: "run-1",
    cwd: "/workspace",
    writable_roots: ["/workspace"],
    tool_profile: "default",
    allowed_mcp_servers: ["filesystem"],
    sandbox_policy: "workspace_write",
    permission_policy: "ask",
    network_policy: "restricted"
  };
}
