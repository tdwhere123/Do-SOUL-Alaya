import { randomUUID } from "node:crypto";
import { hasAlayaMemoryToolName } from "./tool-catalog.js";
import { createGardenTaskHandlers } from "./garden-task-handlers.js";
import {
  createAgentSurfaceRegistrar,
  createMcpMemoryToolDispatcher,
  createMcpMemoryToolOperations
} from "./tool-handler-operations.js";
import { createRecallHandler, createReportContextUsageHandler } from "./recall-usage-handlers.js";
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
  const warn = deps.warn ?? ((message: string, meta: Record<string, unknown>) => console.warn(message, meta));
  const gardenTasks = createGardenTaskHandlers({ deps, now, warn, generateId });
  const recall = createRecallHandler({ deps, now, warn, generateId });
  const reportContextUsage = createReportContextUsageHandler({ deps, now, warn });
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
        await deps.zeroDayToolAccess?.enforceToolAccess(context.workspaceId, toolName);
        await surfaceRegistrar.ensureAgentSurfaceForCall(context);
        return await dispatcher.dispatchToolCall({ toolName, rawArguments, context });
      } catch (error) {
        return fail(toolName, classifyError(error), sanitizeError(error));
      }
    }
  };
}
