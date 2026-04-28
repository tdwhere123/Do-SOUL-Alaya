import { asSchema, type Tool } from "ai";
import {
  SignalKind,
  SoulApplyOverrideRequestSchema,
  SoulEmitCandidateSignalRequestSchema,
  SoulExploreGraphRequestSchema
} from "@do-what/protocol";
import type { AiSdkToolDef } from "./ai-sdk-tools.js";

export interface OpenAILegacyToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface AnthropicLegacyToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

const emitCandidateSignalDescription =
  "Emit a candidate memory signal when you detect a durable preference, decision, constraint, handoff, conflict, synthesis, or evidence anchor worth tracking. (This tool is language-agnostic. For Chinese inputs: 当你检测到需要记忆的偏好、决定、约束、冲突或证据时，请触发此工具)";

export const soulToolDefs: readonly AiSdkToolDef[] = [
  {
    name: "soul.emit_candidate_signal",
    description: emitCandidateSignalDescription,
    parametersSchema: SoulEmitCandidateSignalRequestSchema
  },
  {
    name: "soul.apply_override",
    description:
      "Apply an immediate session-only correction when the user explicitly says the current assumption/tool/behavior is wrong and should be replaced for this run.",
    parametersSchema: SoulApplyOverrideRequestSchema
  },
  {
    name: "soul.explore_graph",
    description:
      "Inspect one-hop memory graph neighbors for an existing memory entry. Read-only; does not create or mutate edges.",
    parametersSchema: SoulExploreGraphRequestSchema
  }
];

export async function getOpenAILegacyToolDefinitions(): Promise<readonly OpenAILegacyToolDefinition[]> {
  return await Promise.all(
    soulToolDefs.map(async (toolDef) => ({
      type: "function" as const,
      function: {
        name: toolDef.name,
        description: toolDef.description,
        parameters: await readJsonSchema(toolDef)
      }
    }))
  );
}

export async function getAnthropicLegacyToolDefinitions(): Promise<
  readonly AnthropicLegacyToolDefinition[]
> {
  return await Promise.all(
    soulToolDefs.map(async (toolDef) => ({
      name: toolDef.name,
      description: toolDef.description,
      input_schema: await readJsonSchema(toolDef)
    }))
  );
}

async function readJsonSchema(toolDef: AiSdkToolDef): Promise<Record<string, unknown>> {
  const jsonSchema = await asSchema(
    toolDef.parametersSchema as NonNullable<Tool["inputSchema"]>
  ).jsonSchema;

  if (typeof jsonSchema !== "object" || jsonSchema === null || Array.isArray(jsonSchema)) {
    throw new Error(`Expected object JSON schema for legacy provider tool ${toolDef.name}.`);
  }

  validateLegacyToolSchema(toolDef.name, jsonSchema);
  return jsonSchema as Record<string, unknown>;
}

function validateLegacyToolSchema(toolName: string, jsonSchema: object): void {
  const record = jsonSchema as Record<string, unknown>;

  if (record["type"] !== "object") {
    throw new Error(`Expected object JSON schema for legacy provider tool ${toolName}.`);
  }

  if (!("properties" in record) || typeof record["properties"] !== "object" || record["properties"] === null) {
    throw new Error(`Expected properties JSON schema for legacy provider tool ${toolName}.`);
  }

  if (toolName === "soul.emit_candidate_signal") {
    const signalKind = (record["properties"] as Record<string, unknown>)["signal_kind"];
    const signalKindRecord =
      typeof signalKind === "object" && signalKind !== null ? (signalKind as Record<string, unknown>) : null;
    const enumValues = signalKindRecord?.["enum"];

    if (!Array.isArray(enumValues) || enumValues.length !== Object.values(SignalKind).length) {
      throw new Error(`Expected signal_kind enum JSON schema for legacy provider tool ${toolName}.`);
    }
  }
}
