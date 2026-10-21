import { CoreError } from "@do-soul/alaya-core";
import type { SourceSemanticAccessProfile, SourceSemanticComparisonResponse } from "@do-soul/alaya-protocol";
import { sourceComparisonForHandler } from "../../mcp-memory/tool/source-comparison-handler.js";
import type { McpMemoryToolCallContext, McpMemoryToolHandler } from "../../mcp-memory/tool/tool-handler-types.js";
import type { SourceSemanticsExecutionPort } from "./recall-read-worker-client.js";

/** Keep constructor/registry module identity together under source/dist test aliases. */
export async function createSourceComparisonRuntime(options: import("@do-soul/alaya").AlayaDaemonRuntimeOptions) {
  const { createAlayaDaemonRuntime } = await import("../../index.js");
  const runtime = await createAlayaDaemonRuntime(options);
  return { runtime, comparison: (context: () => McpMemoryToolCallContext) => sourceComparisonForRuntime(runtime, context) };
}

const runtimes = new WeakMap<object, Readonly<{ handler: McpMemoryToolHandler; port: SourceSemanticsExecutionPort }>>();
export type SourceComparisonCapture = Readonly<{ entry: "private_source_comparison";
  context: Readonly<{ workspace_id: string; run_id: string | null; session_id: string; agent_target: string }>;
  request: unknown; response: SourceSemanticComparisonResponse }>;
export type SourceComparisonCall = (input: Readonly<{
  request: unknown; profile?: SourceSemanticAccessProfile; signal?: AbortSignal; timeoutMs?: number;
  capture?: (frame: SourceComparisonCapture) => void;
}>) => Promise<SourceSemanticComparisonResponse>;

/** Startup-owned registry. The private consumer receives neither a port nor prepared state. */
export function bindSourceComparisonExecution(runtime: object, handler: McpMemoryToolHandler, port: SourceSemanticsExecutionPort): void {
  if (runtimes.has(runtime)) throw new CoreError("CONFLICT", "source comparison runtime already bound");
  runtimes.set(runtime, { handler, port });
}

/** Temporary bounded comparison consumer; remove on promotion or termination.
 * The enclosing harness supplies its actual context provider, not a serialized principal.
 */
export function sourceComparisonForRuntime(runtime: object, contextProvider: () => McpMemoryToolCallContext): SourceComparisonCall {
  const binding = runtimes.get(runtime);
  if (binding === undefined) throw new CoreError("CONFLICT", "private comparison runtime is not bound");
  const execute = sourceComparisonForHandler(binding.handler);
  return input => {
    const context = { ...contextProvider(), ...(input.signal === undefined ? {} : { abortSignal: input.signal }) };
    const captured = { request: structuredClone(input.request),
      ...(Object.hasOwn(input, "profile") ? { profile: structuredClone(input.profile) } : {}) };
    const capture = input.capture;
    return binding.port.withExecutionScope({ signal: context.abortSignal, timeoutMs: input.timeoutMs ?? 30_000 },
      () => execute(captured, context)).then(response => {
        capture?.(structuredClone({ entry: "private_source_comparison", context: {
          workspace_id: context.workspaceId, run_id: context.runId, session_id: context.sessionId, agent_target: context.agentTarget
        }, request: captured.request, response }));
        return response;
      });
  };
}
