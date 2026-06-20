import { mkdir } from "node:fs/promises";

import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CoreError } from "@do-soul/alaya-core";

import { createExternalConversationToolExecutor } from "../../mcp/mcp-catalog.js";

import {
  executeConversationToolOrThrow,
  handleConversationToolUse
} from "../../mcp/tool-runtime.js";

import {
  cleanupToolRuntimeTempDirs,
  createBuiltinToolExecutor,
  createDeferred,
  createRuntimeContext,
  createWorkspace
} from "./tool-runtime-shared-fixture.js";

afterEach(cleanupToolRuntimeTempDirs);

describe("tool-runtime relative path handling", () => {

  it("awaits one external tool refresh before executing newly registered tools", async () => {
    const workspaceDir = await createWorkspace();
    let enrolled = false;
    const refreshGate = createDeferred<void>();
    const refreshTools = vi.fn(async () => {
      await refreshGate.promise;
      enrolled = true;
    });
    const executeTool = vi.fn(async ({ toolId, rawInput, writableRoots }: {
      readonly toolId: string;
      readonly rawInput: unknown;
      readonly writableRoots: readonly string[];
    }) => ({
      ok: true,
      tool: toolId,
      input: rawInput,
      writableRoots
    }));

    const externalToolExecutor = createExternalConversationToolExecutor({
      catalog: {
        refresh: async () => undefined,
        servers: [],
        listAllowedServerNames: () => [],
        listEnrolledToolIds: () => [],
        listServerTools: async () => [],
        hasTool: () => enrolled,
        executeTool
      } as Parameters<typeof createExternalConversationToolExecutor>[0]["catalog"],
      now: () => 0,
      refreshTools,
      refreshTtlMs: 1_000
    });

    const runtimeContext = createRuntimeContext();
    const firstResultPromise = handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-ext-refresh",
        name: "mcp__filesystem__search_files",
        input: {
          pattern: "TODO"
        }
      },
      runtimeContext,
      {
        getById: async () => ({
          root_path: workspaceDir
        })
      },
      {
        execute: async (request) => ({
          result: await request.handler({ writableRoots: [request.workspaceRoot] }, request.rawInput),
          executionRecord: {
            execution_id: "exec-ext-refresh",
            tool_id: request.toolId,
            requested_by: "principal",
            requesting_run_id: request.runtimeContext.run_id,
            governance_decision_ref: "governance://allow",
            permission_result: "allow",
            executed: true,
            started_at: "2026-04-20T00:00:00.000Z",
            ended_at: "2026-04-20T00:00:01.000Z",
            result_summary: "ok",
            rollback_status: "none"
          },
          permissionResult: "allow"
        })
      },
      {
        externalToolExecutor
      }
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(refreshTools).toHaveBeenCalledTimes(1);
    expect(executeTool).not.toHaveBeenCalled();

    refreshGate.resolve();
    const firstResult = await firstResultPromise;

    expect(firstResult).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-ext-refresh",
      content: JSON.stringify({
        ok: true,
        tool: "mcp__filesystem__search_files",
        input: { pattern: "TODO" },
        writableRoots: [workspaceDir]
      })
    });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith({
      toolId: "mcp__filesystem__search_files",
      rawInput: { pattern: "TODO" },
      runtimeContext,
      writableRoots: [workspaceDir]
    });

    const secondResult = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-ext-refresh",
        name: "mcp__filesystem__search_files",
        input: {
          pattern: "TODO"
        }
      },
      runtimeContext,
      {
        getById: async () => ({
          root_path: workspaceDir
        })
      },
      {
        execute: async (request) => ({
          result: await request.handler({ writableRoots: [request.workspaceRoot] }, request.rawInput),
          executionRecord: {
            execution_id: "exec-ext-refresh",
            tool_id: request.toolId,
            requested_by: "principal",
            requesting_run_id: request.runtimeContext.run_id,
            governance_decision_ref: "governance://allow",
            permission_result: "allow",
            executed: true,
            started_at: "2026-04-20T00:00:00.000Z",
            ended_at: "2026-04-20T00:00:01.000Z",
            result_summary: "ok",
            rollback_status: "none"
          },
          permissionResult: "allow"
        })
      },
      {
        externalToolExecutor
      }
    );

    expect(secondResult).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-ext-refresh",
      content: JSON.stringify({
        ok: true,
        tool: "mcp__filesystem__search_files",
        input: { pattern: "TODO" },
        writableRoots: [workspaceDir]
      })
    });
    expect(refreshTools).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledTimes(2);
  });

  it("awaits refresh completion and coalesces refreshes within the ttl window", async () => {
    let nowMs = 0;
    const refreshGate = createDeferred<void>();
    const refreshTools = vi.fn(async () => {
      await refreshGate.promise;
    });

    const externalToolExecutor = createExternalConversationToolExecutor({
      catalog: {
        refresh: async () => undefined,
        servers: [],
        listAllowedServerNames: () => [],
        listEnrolledToolIds: () => [],
        listServerTools: async () => [],
        hasTool: () => false,
        executeTool: async () => ({ ok: true })
      } as Parameters<typeof createExternalConversationToolExecutor>[0]["catalog"],
      now: () => nowMs,
      refreshTools,
      refreshTtlMs: 1_000
    });

    let firstRefreshSettled = false;
    const firstRefreshPromise = externalToolExecutor.refreshTools?.().then(() => {
      firstRefreshSettled = true;
    });
    await Promise.resolve();

    expect(firstRefreshSettled).toBe(false);
    expect(refreshTools).toHaveBeenCalledTimes(1);

    nowMs = 500;
    const secondRefreshPromise = externalToolExecutor.refreshTools?.();
    const thirdRefreshPromise = externalToolExecutor.refreshTools?.();
    await Promise.resolve();

    expect(refreshTools).toHaveBeenCalledTimes(1);

    refreshGate.resolve();
    await firstRefreshPromise;
    await secondRefreshPromise;
    await thirdRefreshPromise;
    expect(firstRefreshSettled).toBe(true);

    nowMs = 1_500;
    await externalToolExecutor.refreshTools?.();

    expect(refreshTools).toHaveBeenCalledTimes(2);
  });

  it("retries refreshes immediately after a failed refresh instead of waiting for the ttl window", async () => {
    let nowMs = 0;
    const refreshError = new Error("refresh failed");
    const refreshTools = vi.fn()
      .mockRejectedValueOnce(refreshError)
      .mockResolvedValueOnce(undefined);
    const warn = vi.fn();

    const externalToolExecutor = createExternalConversationToolExecutor({
      catalog: {
        refresh: async () => undefined,
        servers: [],
        listAllowedServerNames: () => [],
        listEnrolledToolIds: () => [],
        listServerTools: async () => [],
        hasTool: () => false,
        executeTool: async () => ({ ok: true })
      } as Parameters<typeof createExternalConversationToolExecutor>[0]["catalog"],
      now: () => nowMs,
      refreshTools,
      refreshTtlMs: 1_000,
      warn
    });

    await expect(externalToolExecutor.refreshTools?.()).rejects.toBe(refreshError);
    expect(refreshTools).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "failed to refresh daemon MCP tool discovery",
      expect.objectContaining({ error: refreshError })
    );

    nowMs = 500;
    await externalToolExecutor.refreshTools?.();

    expect(refreshTools).toHaveBeenCalledTimes(2);
  });
});
