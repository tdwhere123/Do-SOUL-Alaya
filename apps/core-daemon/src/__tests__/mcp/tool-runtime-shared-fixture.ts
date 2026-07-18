import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ConversationRuntimeContext, ToolSpec } from "@do-soul/alaya-protocol";
import { builtinConversationToolRequiresConfirmation } from "../../mcp/builtin-conversation-tool-specs.js";
import { executeConversationToolOrThrow } from "../../mcp/tool-runtime.js";
export { createDeferred } from "../support/deferred.js";

const tempDirs = new Set<string>();

export async function cleanupToolRuntimeTempDirs(): Promise<void> {
  await Promise.all(
    Array.from(tempDirs, async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
  tempDirs.clear();
}

export async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dw-tool-runtime-"));
  tempDirs.add(dir);
  return dir;
}

export function trackToolRuntimeTempDir(dir: string): string {
  tempDirs.add(dir);
  return dir;
}

export function createRuntimeContext(): ConversationRuntimeContext {
  return {
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    user_message_id: "msg-user-1",
    assistant_message_id: "msg-assistant-1"
  };
}

export const TOOL_CONFIRMATION_TOKEN = "server-token";

export function withToolConfirmation<T extends Record<string, unknown>>(
  input: T
): T & { _alaya_confirmation: { confirmed: true; token: string } } {
  return {
    ...input,
    _alaya_confirmation: {
      confirmed: true,
      token: TOOL_CONFIRMATION_TOKEN
    }
  };
}

export const confirmedToolExecutionOptions = {
  confirmationToken: TOOL_CONFIRMATION_TOKEN
} as const;

export function createConversationToolSpec(toolId: ToolSpec["tool_id"]): ToolSpec {
  const requiresConfirmation =
    toolId === "tools.exec_shell" || toolId === "tools.write_file";
  return {
    tool_id: toolId,
    category: toolId === "tools.exec_shell" ? "exec" : "write",
    description: `Spec for ${toolId}`,
    scope_guard: toolId === "tools.exec_shell" ? "project" : "workspace",
    read_only: false,
    destructive: toolId === "tools.exec_shell",
    concurrency_safe: false,
    interrupt_behavior: toolId === "tools.exec_shell" ? "abort" : "wait",
    requires_confirmation: requiresConfirmation,
    requires_evidence_reopen: false,
    rollback_support: "none",
    fast_path_eligible: false
  };
}

export function createAutoConfirmingBuiltinToolExecutor(toolIds: readonly string[]) {
  const registeredToolIds = new Set(toolIds);

  return {
    hasTool: (toolId: string) => registeredToolIds.has(toolId),
    executeTool: async ({
      toolId,
      rawInput,
      writableRoots
    }: {
      readonly toolId: string;
      readonly rawInput: unknown;
      readonly writableRoots: readonly string[];
    }) => {
      const effectiveInput =
        builtinConversationToolRequiresConfirmation(toolId) &&
        rawInput !== null &&
        typeof rawInput === "object" &&
        !Array.isArray(rawInput) &&
        !("_alaya_confirmation" in rawInput)
          ? withToolConfirmation(rawInput as Record<string, unknown>)
          : rawInput;
      return await executeConversationToolOrThrow(toolId, effectiveInput, writableRoots, {
        confirmationToken: TOOL_CONFIRMATION_TOKEN
      });
    }
  };
}
