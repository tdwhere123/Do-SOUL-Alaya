import { randomUUID } from "node:crypto";
import {
  CandidateMemorySignalInputSchema,
  CandidateMemorySignalSchema,
  SoulApplyOverrideRequestSchema,
  SoulApplyOverrideResponseSchema,
  SoulExploreGraphRequestSchema,
  SoulExploreGraphResponseSchema,
  EmitCandidateSignalResponseSchema,
  SignalSource,
  type ConversationRuntimeContext,
  type CandidateMemorySignal,
  type SignalSource as SignalSourceValue,
  type ToolUseBlock
} from "@do-soul/alaya-protocol";

export interface ToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: boolean;
}

export interface SoulSignalHandlerDependencies {
  readonly receiveSignal: (signal: CandidateMemorySignal) => Promise<unknown>;
  readonly applyOverride?: (params: {
    readonly runId: string;
    readonly workspaceId: string;
    readonly surfaceId: string | null;
    readonly targetObject: string;
    readonly correction: string;
    readonly priority?: number;
    readonly derivedFrom: string;
  }) => Promise<{
    readonly runtime_id: string;
  }>;
  readonly graphExplorePort?: {
    exploreOneHop(
      memoryId: string,
      workspaceId: string,
      options?: {
        edgeTypes?: readonly string[];
        direction?: "inbound" | "outbound" | "both";
        runId?: string | null;
      }
    ): Promise<
      ReadonlyArray<{
        memory_id: string;
        edge_type: string;
        direction: "inbound" | "outbound";
        edge_id: string;
      }>
    >;
  };
  readonly generateSignalId?: () => string;
  readonly now?: () => string;
}

export class SoulSignalHandler {
  private readonly generateSignalId: () => string;
  private readonly now: () => string;

  public constructor(private readonly dependencies: SoulSignalHandlerDependencies) {
    this.generateSignalId = dependencies.generateSignalId ?? (() => `signal_${randomUUID()}`);
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async handleToolUse(
    toolUse: ToolUseBlock,
    runtimeContext?: Readonly<ConversationRuntimeContext>
  ): Promise<ToolResultBlock> {
    try {
      switch (toolUse.name) {
        case "soul.emit_candidate_signal": {
          const context = requireRuntimeContext(runtimeContext);
          const signal = materializeCandidateSignal({
            input: toolUse.input,
            source: SignalSource.MODEL_TOOL,
            generateSignalId: this.generateSignalId,
            now: this.now,
            // Override LLM-supplied scope with trusted server-side runtime context
            scopeOverride: {
              workspace_id: context.workspace_id,
              run_id: context.run_id,
              surface_id: context.surface_id
            }
          });
          await this.dependencies.receiveSignal(signal);

          return {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(
              EmitCandidateSignalResponseSchema.parse({
                signal_id: signal.signal_id,
                status: "emitted"
              })
            )
          };
        }
        case "soul.apply_override": {
          if (this.dependencies.applyOverride === undefined) {
            return createErrorToolResult(toolUse.id, "Unsupported soul tool: soul.apply_override");
          }

          const context = requireRuntimeContext(runtimeContext);
          const input = SoulApplyOverrideRequestSchema.parse(toolUse.input);
          const override = await this.dependencies.applyOverride({
            runId: context.run_id,
            workspaceId: context.workspace_id,
            surfaceId: context.surface_id,
            targetObject: input.target_object,
            correction: input.correction,
            priority: input.priority,
            derivedFrom: context.user_message_id
          });

          return {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(
              SoulApplyOverrideResponseSchema.parse({
                override_id: override.runtime_id,
                status: "applied"
              })
            )
          };
        }
        case "soul.explore_graph": {
          if (this.dependencies.graphExplorePort === undefined) {
            return createErrorToolResult(toolUse.id, "Graph explore not available");
          }

          // SECURITY: workspace is bound from trusted runtime context per
          // invariant §29, never from tool payload.
          const context = requireRuntimeContext(runtimeContext);
          const input = SoulExploreGraphRequestSchema.parse(toolUse.input);
          const direction = input.direction ?? "both";

          const neighbors = await this.dependencies.graphExplorePort.exploreOneHop(input.memory_id, context.workspace_id, {
            edgeTypes: input.edge_types,
            direction,
            runId: context.run_id
          });

          return {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(
              SoulExploreGraphResponseSchema.parse({
                source_memory_id: input.memory_id,
                neighbors,
                count: neighbors.length
              })
            )
          };
        }
        default:
          return createErrorToolResult(toolUse.id, `Unsupported soul tool: ${toolUse.name}`);
      }
    } catch (error) {
      return createErrorToolResult(toolUse.id, readErrorMessage(error));
    }
  }
}

export function materializeCandidateSignal(args: {
  readonly input: unknown;
  readonly source: SignalSourceValue;
  readonly generateSignalId?: () => string;
  readonly now?: () => string;
  readonly scopeOverride?: {
    readonly workspace_id: string;
    readonly run_id: string;
    readonly surface_id: string | null;
  };
}): CandidateMemorySignal {
  // Normalize LLM-supplied input before Zod validation.
  // LLMs routinely send "" for nullable fields instead of null, and may include
  // empty strings in arrays. The JSON Schema tool definition cannot fully express
  // the NonEmptyStringSchema constraint enforced by the Zod schema, so we coerce here.
  const parsedInput = CandidateMemorySignalInputSchema.parse(normalizeSignalInput(args.input));

  return CandidateMemorySignalSchema.parse({
    ...parsedInput,
    // scopeOverride replaces any LLM-supplied run/workspace/surface ids with
    // trusted server-side values when called from the model-tool path.
    ...(args.scopeOverride !== undefined && {
      workspace_id: args.scopeOverride.workspace_id,
      run_id: args.scopeOverride.run_id,
      surface_id: args.scopeOverride.surface_id
    }),
    signal_id: args.generateSignalId ? args.generateSignalId() : `signal_${randomUUID()}`,
    source: args.source,
    created_at: args.now ? args.now() : new Date().toISOString()
  });
}

/**
 * Coerce LLM-supplied signal input to pass Zod NonEmptyStringSchema validation.
 * - Only known schema fields are copied (strips unknown extra properties from LLM output)
 * - Nullable string fields that are "" or undefined become null
 * - Array fields have empty strings filtered out
 */
function normalizeSignalInput(raw: unknown): unknown {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }

  const input = raw as Record<string, unknown>;

  // Allowlist: only copy fields CandidateMemorySignalInputSchema expects.
  // Extra LLM fields (e.g. "reasoning", "_meta") would cause .strict() to reject — strip them.
  const KNOWN_FIELDS = [
    "workspace_id",
    "run_id",
    "surface_id",
    "signal_kind",
    "object_kind",
    "scope_hint",
    "domain_tags",
    "confidence",
    "evidence_refs",
    "raw_payload"
  ] as const;

  const result: Record<string, unknown> = {};
  for (const field of KNOWN_FIELDS) {
    if (field in input) {
      result[field] = input[field];
    }
  }

  // Nullable string fields: "" or undefined → null
  for (const field of ["surface_id", "scope_hint"] as const) {
    if (result[field] === "" || result[field] === undefined) {
      result[field] = null;
    }
  }

  // String array fields: filter out empty strings
  for (const field of ["domain_tags", "evidence_refs"] as const) {
    const value = result[field];
    if (Array.isArray(value)) {
      result[field] = (value as unknown[]).filter(
        (item) => typeof item === "string" && item.length > 0
      );
    }
  }

  return result;
}

function createErrorToolResult(toolUseId: string, message: string): ToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: JSON.stringify({ error: message }),
    is_error: true
  };
}

function requireRuntimeContext(
  runtimeContext: Readonly<ConversationRuntimeContext> | undefined
): Readonly<ConversationRuntimeContext> {
  if (runtimeContext === undefined) {
    throw new Error("Missing runtime context.");
  }

  return runtimeContext;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Invalid candidate signal payload.";
}
