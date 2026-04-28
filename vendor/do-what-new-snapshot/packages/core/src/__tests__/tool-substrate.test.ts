import type { RuntimeSessionConfig } from "@do-what/protocol";
import { describe, expect, it, vi } from "vitest";
import { ToolSubstrate } from "../tool-substrate/index.js";
import type { ToolExecutionContext } from "../tool-substrate/index.js";

describe("ToolSubstrate", () => {
  it("creates a frozen execution context snapshot and returns the callback result", async () => {
    const sourceConfig = createSessionConfig();
    const substrate = new ToolSubstrate({
      generateExecutionId: () => "exec-001",
      now: () => "2026-04-12T09:00:00.000Z"
    });

    const result = await substrate.withContext(
      "  tools.read_file  ",
      sourceConfig as RuntimeSessionConfig,
      async (ctx) => {
        sourceConfig.cwd = "/workspace/changed";
        sourceConfig.writable_roots.push("/workspace/other");
        sourceConfig.allowed_mcp_servers.push("garden");

        expect(ctx.executionId).toBe("exec-001");
        expect(ctx.toolId).toBe("tools.read_file");
        expect(ctx.workspaceId).toBe("ws_123");
        expect(ctx.cwd).toBe("/workspace");
        expect(ctx.startedAt).toBe("2026-04-12T09:00:00.000Z");
        expect(ctx.writableRoots).toEqual(["/workspace"]);
        expect(ctx.writableRoots).not.toBe(sourceConfig.writable_roots);
        expect(ctx.sessionConfig).not.toBe(sourceConfig);
        expect(ctx.sessionConfig).toEqual({
          role: "worker",
          workspace_id: "ws_123",
          run_id: "run_456",
          cwd: "/workspace",
          writable_roots: ["/workspace"],
          tool_profile: "default",
          allowed_mcp_servers: ["filesystem"],
          sandbox_policy: "workspace_write",
          permission_policy: "ask",
          network_policy: "enabled"
        });
        expect(Object.isFrozen(ctx)).toBe(true);
        expect(Object.isFrozen(ctx.writableRoots)).toBe(true);
        expect(Object.isFrozen(ctx.sessionConfig)).toBe(true);
        expect(Object.isFrozen(ctx.sessionConfig.writable_roots)).toBe(true);
        expect(Object.isFrozen(ctx.sessionConfig.allowed_mcp_servers)).toBe(true);
        expect(() => (ctx.writableRoots as unknown as string[]).push("/tmp/blocked")).toThrow(TypeError);

        return "callback-result";
      }
    );

    expect(result).toBe("callback-result");
  });

  it("rethrows callback errors without wrapping them", async () => {
    const error = new Error("boom");
    const substrate = new ToolSubstrate({
      generateExecutionId: () => "exec-error",
      now: () => "2026-04-12T09:05:00.000Z"
    });

    await expect(
      substrate.withContext("tools.fail", createSessionConfig() as RuntimeSessionConfig, async () => {
        throw error;
      })
    ).rejects.toBe(error);
  });

  it("rejects blank tool ids before creating a context", async () => {
    const generateExecutionId = vi.fn(() => "exec-invalid");
    const now = vi.fn(() => "2026-04-12T09:06:00.000Z");
    const substrate = new ToolSubstrate({
      generateExecutionId,
      now
    });
    const fn = vi.fn(async () => "should-not-run");

    await expect(
      substrate.withContext("   ", createSessionConfig() as RuntimeSessionConfig, fn)
    ).rejects.toMatchObject({
      code: "VALIDATION"
    });

    expect(generateExecutionId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it("creates isolated contexts across repeated calls without ambient state leakage", async () => {
    const executionIds = ["exec-101", "exec-102"];
    const timestamps = ["2026-04-12T09:10:00.000Z", "2026-04-12T09:10:01.000Z"];
    const substrate = new ToolSubstrate({
      generateExecutionId: () => executionIds.shift() ?? "missing-execution-id",
      now: () => timestamps.shift() ?? "missing-timestamp"
    });

    const contexts: Array<Readonly<ToolExecutionContext>> = [];

    await substrate.withContext("tools.first", createSessionConfig() as RuntimeSessionConfig, async (ctx) => {
      contexts.push(ctx);
      return undefined;
    });

    await substrate.withContext("tools.second", createSessionConfig() as RuntimeSessionConfig, async (ctx) => {
      contexts.push(ctx);
      return undefined;
    });

    expect(contexts).toHaveLength(2);
    expect(contexts[0]).not.toBe(contexts[1]);
    expect(contexts[0]?.executionId).toBe("exec-101");
    expect(contexts[1]?.executionId).toBe("exec-102");
    expect(contexts[0]?.toolId).toBe("tools.first");
    expect(contexts[1]?.toolId).toBe("tools.second");
    expect(contexts[0]?.startedAt).toBe("2026-04-12T09:10:00.000Z");
    expect(contexts[1]?.startedAt).toBe("2026-04-12T09:10:01.000Z");
  });

  it("supports nested withContext calls with deterministic independent snapshots", async () => {
    const executionIds = ["exec-outer", "exec-inner"];
    const timestamps = ["2026-04-12T09:15:00.000Z", "2026-04-12T09:15:01.000Z"];
    const substrate = new ToolSubstrate({
      generateExecutionId: () => executionIds.shift() ?? "missing-execution-id",
      now: () => timestamps.shift() ?? "missing-timestamp"
    });

    const outerConfig = createSessionConfig({ workspace_id: "ws_outer", cwd: "/workspace/outer" });
    const innerConfig = createSessionConfig({
      workspace_id: "ws_inner",
      cwd: "/workspace/inner",
      writable_roots: ["/workspace/inner"],
      allowed_mcp_servers: ["filesystem", "garden"]
    });

    let capturedOuter: Readonly<{ executionId: string; toolId: string; workspaceId: string; cwd: string }> | null = null;
    let capturedInner:
      | Readonly<{ executionId: string; toolId: string; workspaceId: string; cwd: string; writableRoots: readonly string[] }>
      | null = null;

    const result = await substrate.withContext(
      "tools.outer",
      outerConfig as RuntimeSessionConfig,
      async (outerCtx) => {
        capturedOuter = outerCtx;

        return substrate.withContext("tools.inner", innerConfig as RuntimeSessionConfig, async (innerCtx) => {
          capturedInner = innerCtx;

          expect(outerCtx.executionId).toBe("exec-outer");
          expect(outerCtx.toolId).toBe("tools.outer");
          expect(outerCtx.workspaceId).toBe("ws_outer");
          expect(outerCtx.cwd).toBe("/workspace/outer");
          expect(innerCtx.executionId).toBe("exec-inner");
          expect(innerCtx.toolId).toBe("tools.inner");
          expect(innerCtx.workspaceId).toBe("ws_inner");
          expect(innerCtx.cwd).toBe("/workspace/inner");
          expect(innerCtx.writableRoots).toEqual(["/workspace/inner"]);
          expect(innerCtx.writableRoots).not.toBe(outerCtx.writableRoots);

          return `${outerCtx.executionId}->${innerCtx.executionId}`;
        });
      }
    );

    expect(result).toBe("exec-outer->exec-inner");
    expect(capturedOuter).toMatchObject({
      executionId: "exec-outer",
      toolId: "tools.outer",
      workspaceId: "ws_outer",
      cwd: "/workspace/outer"
    });
    expect(capturedInner).toMatchObject({
      executionId: "exec-inner",
      toolId: "tools.inner",
      workspaceId: "ws_inner",
      cwd: "/workspace/inner",
      writableRoots: ["/workspace/inner"]
    });
  });
});

function createSessionConfig(
  overrides: Partial<{
    workspace_id: string;
    run_id: string;
    cwd: string;
    writable_roots: string[];
    tool_profile: string;
    allowed_mcp_servers: string[];
    sandbox_policy: "default" | "read_only" | "workspace_write";
    permission_policy: "default" | "ask" | "deny";
    network_policy: "restricted" | "disabled" | "enabled";
  }> = {}
) {
  return {
    role: "worker" as const,
    workspace_id: overrides.workspace_id ?? "ws_123",
    run_id: overrides.run_id ?? "run_456",
    cwd: overrides.cwd ?? "/workspace",
    writable_roots: [...(overrides.writable_roots ?? ["/workspace"])],
    tool_profile: overrides.tool_profile ?? "default",
    allowed_mcp_servers: [...(overrides.allowed_mcp_servers ?? ["filesystem"])],
    sandbox_policy: overrides.sandbox_policy ?? "workspace_write",
    permission_policy: overrides.permission_policy ?? "ask",
    network_policy: overrides.network_policy ?? "enabled"
  };
}
