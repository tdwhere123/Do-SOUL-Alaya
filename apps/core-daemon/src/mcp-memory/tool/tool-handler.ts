import { randomUUID } from "node:crypto";
import { isHandlerTimeoutError, throwIfAborted } from "@do-soul/alaya-engine-gateway";
import { hasAlayaMemoryToolName } from "./tool-catalog.js";
import { createGardenTaskHandlers } from "../garden-task/garden-task-handlers.js";
import { createMcpMemoryToolDispatcher } from "./tool-handler-dispatch.js";
import {
  createAgentSurfaceRegistrar,
  createMcpMemoryToolOperations
} from "./tool-handler-operations.js";
import { createRecallHandler, createReportContextUsageHandler } from "../recall/recall-usage-handlers.js";
import {
  classifyError,
  fail,
  sanitizeError
} from "./tool-handler-support.js";

import type {
  McpMemoryToolCallContext,
  McpMemoryToolCallResult,
  McpMemoryToolHandler,
  McpMemoryToolHandlerDependencies
} from "./tool-handler-types.js";

export type {
  McpMemoryToolCallContext,
  McpMemoryToolCallResult,
  McpMemoryToolHandler,
  McpMemoryToolHandlerDependencies
} from "./tool-handler-types.js";

export function createMcpMemoryToolHandler(deps: McpMemoryToolHandlerDependencies): McpMemoryToolHandler {
  const now = deps.now ?? (() => new Date().toISOString());
  const generateId = deps.generateId ?? randomUUID;
  const warn = deps.warn ?? ((message: string, meta: Record<string, unknown>) => {
    process.emitWarning(message, {
      code: "ALAYA_MCP_MEMORY_TOOL_WARNING",
      detail: JSON.stringify(meta)
    });
  });
  const gardenTasks = createGardenTaskHandlers({ deps, now, warn, generateId });
  const recall = createRecallHandler({ deps, now, warn, generateId });
  const reportContextUsage = createReportContextUsageHandler({
    deps,
    now,
    warn
  });
  const operations = createMcpMemoryToolOperations({ deps, now, generateId, warn });
  const surfaceRegistrar = createAgentSurfaceRegistrar({ deps, warn });
  const dispatcher = createMcpMemoryToolDispatcher({
    gardenTasks,
    recall,
    reportContextUsage,
    operations
  });

  return {
    async call({ toolName, arguments: rawArguments, context }) {
      if (!hasAlayaMemoryToolName(toolName)) {
        return fail(toolName, "UNKNOWN_TOOL", `Unsupported Alaya memory tool: ${toolName}`);
      }

      try {
        throwIfAborted(context.abortSignal);
        await deps.zeroDayToolAccess?.enforceToolAccess(context.workspaceId, toolName);
        throwIfAborted(context.abortSignal);
        await surfaceRegistrar.ensureAgentSurfaceForCall(context);
        throwIfAborted(context.abortSignal);
        return await dispatcher.dispatchToolCall({ toolName, rawArguments, context });
      } catch (error) {
        // Timeout abort is not a tool-domain failure; keep it as the race winner.
        if (isHandlerTimeoutError(error)) {
          throw error;
        }
        return fail(toolName, classifyError(error), sanitizeError(error));
      }
    }
  };
}
