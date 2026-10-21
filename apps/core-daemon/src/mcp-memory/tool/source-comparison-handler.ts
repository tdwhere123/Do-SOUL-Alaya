import { SourceSemanticComparisonRequestSchema, SourceSemanticComparisonWorkerRequestSchema, SourceSemanticAccessProfileSchema,
  SourceSemanticComparisonResponseSchema, type SourceSemanticComparisonResponse,
  type SourceSemanticAccessProfile } from "@do-soul/alaya-protocol";
import { CoreError, encodeSourceSemanticLibraryResponse } from "@do-soul/alaya-core";
import type { McpMemoryToolCallContext, McpMemoryToolHandler } from "./tool-handler-types.js";
import { buildSourceSemanticWorkerPayload, type SourceSemanticHostPort } from "./interpretation-handler.js";

type Comparison = (input: Readonly<{ request: unknown; profile?: SourceSemanticAccessProfile }>,
  context: McpMemoryToolCallContext) => Promise<SourceSemanticComparisonResponse>;
const handlers = new WeakMap<McpMemoryToolHandler, Comparison>();

/** The normal handler owns admission and registration for this temporary Node-only consumer. */
export function bindSourceComparisonHandler(handler: McpMemoryToolHandler, input: Readonly<{
  now: () => string; interpretationClock?: string; sourceSemanticsPort?: SourceSemanticHostPort;
  admit: (context: McpMemoryToolCallContext) => Promise<void>;
}>): void {
  handlers.set(handler, async (call, context) => {
    // Whole-input capture is synchronous, including explicit null/undefined distinctions.
    const request = SourceSemanticComparisonRequestSchema.parse(structuredClone(call.request));
    const profile = Object.hasOwn(call, "profile") ? SourceSemanticAccessProfileSchema.parse(structuredClone(call.profile)) : undefined;
    if (request.operation !== "prepare_query" && request.operation !== "recall" ||
        request.access_policy !== undefined || request.operation === "prepare_query" &&
        (request.source_handle !== undefined || request.source_preview_extents !== undefined)) {
      throw new CoreError("VALIDATION", "private comparison requires unscoped source query preparation or recall without public policy");
    }
    const execute = input.sourceSemanticsPort?.executeComparison;
    if (execute === undefined) throw new CoreError("CONFLICT", "private source comparison is not wired");
    await input.admit(context);
    const { operation, authorized_scopes, ...rest } = request;
    const result = await execute({ ...buildSourceSemanticWorkerPayload(input, context,
      SourceSemanticComparisonWorkerRequestSchema.parse({ kind: operation, ...rest }), authorized_scopes ?? { mode: "unrestricted" }),
      comparison: profile === undefined ? {} : { profile } });
    if (result.kind === "recall") return encodeSourceSemanticLibraryResponse(result);
    const { kind, ...body } = result;
    return SourceSemanticComparisonResponseSchema.parse({ operation: kind, ...body });
  });
}

export function sourceComparisonForHandler(handler: McpMemoryToolHandler): Comparison {
  const execute = handlers.get(handler);
  if (execute === undefined) throw new CoreError("CONFLICT", "source comparison handler is not bound");
  return execute;
}
