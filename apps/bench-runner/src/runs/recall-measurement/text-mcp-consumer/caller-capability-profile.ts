import { canonicalJson } from "@do-soul/alaya-protocol";
import type {
  TextMcpCallerCapabilityProfile, TextMcpLiveSurface, TextMcpRecallDispatchDefaults
} from "./contract.js";

const COORDINATE_FIELDS = ["query_coordinates", "interpretation_proposal"] as const;

export type TextMcpPromptOptions = Readonly<{
  caller_capability_profile?: TextMcpCallerCapabilityProfile;
  question_date?: string;
  recall_dispatch_defaults?: TextMcpRecallDispatchDefaults;
}>;

export type TextMcpRecallDispatchResolution =
  | { readonly kind: "refuse"; readonly tool: string; readonly reason: string }
  | {
    readonly kind: "dispatch";
    readonly tool: string;
    readonly arguments: Record<string, unknown>;
    readonly raw_arguments: Record<string, unknown>;
  };

/** Drop undefined prompt fields so omitted options stay byte-identical to legacy transcripts. */
export function textMcpPromptOptions(value: TextMcpPromptOptions): TextMcpPromptOptions {
  return {
    ...(value.caller_capability_profile === undefined
      ? {} : { caller_capability_profile: value.caller_capability_profile }),
    ...(value.question_date === undefined ? {} : { question_date: value.question_date }),
    ...(value.recall_dispatch_defaults === undefined
      ? {} : { recall_dispatch_defaults: value.recall_dispatch_defaults })
  };
}

export function projectLiveSurfaceForCaller(
  surface: TextMcpLiveSurface, profile: TextMcpCallerCapabilityProfile | undefined
): TextMcpLiveSurface {
  if (profile !== "plain_query") return surface;
  const projected = structuredClone(surface) as TextMcpLiveSurface & { tools: unknown[] };
  if (typeof projected.instructions === "string") {
    projected.instructions = stripCallerCoordinateGuidance(projected.instructions);
  }
  projected.tools = projected.tools.map(projectRecallTool);
  return projected;
}

export function stripCallerCoordinateGuidance(text: string): string {
  return text
    .replace(/On soul\.recall, optionally pass query_coordinates[^.]*\.\s*/gu, "")
    .replace(/For single-call coordinates,[^\n]*?\.(?:\s+|$)/gu, "")
    .replace(/The daemon binds digest and clock automatically[^\n]*?\.(?:\s+|$)/gu, "")
    .replace(/`question_time` is a soft preference on source event_time under the existing root\/attempt limits; /gu, "")
    .replace(/Pre-sealed `interpretation_proposal` packets[^.]*\.\s*/gu, "")
    .replace(/`?query_coordinates`?,?\s*/gu, "")
    .replace(/`?interpretation_proposal`?,?\s*/gu, "")
    .replace(/\(\s+/gu, "(")
    .replace(/,\s*\)/gu, ")")
    .replace(/,\s*,/gu, ",")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

export function resolveTextMcpRecallDispatch(input: Readonly<{
  profile: TextMcpCallerCapabilityProfile | undefined;
  tool: string;
  rawArguments: Record<string, unknown>;
  defaults: TextMcpRecallDispatchDefaults | undefined;
}>): TextMcpRecallDispatchResolution {
  const raw = structuredClone(input.rawArguments);
  if (input.profile === "plain_query" && input.tool === "soul.recall" && carriesCallerCoordinates(raw)) {
    return {
      kind: "refuse", tool: input.tool,
      reason: "plain_query forbids query_coordinates and interpretation_proposal"
    };
  }
  return {
    kind: "dispatch", tool: input.tool, raw_arguments: raw,
    arguments: applyRecallDispatchDefaults(input.tool, raw, input.defaults)
  };
}

export function applyRecallDispatchDefaults(
  tool: string, rawArgs: Record<string, unknown>, defaults: TextMcpRecallDispatchDefaults | undefined
): Record<string, unknown> {
  if (tool !== "soul.recall" || defaults === undefined) return structuredClone(rawArgs);
  const effective = structuredClone(rawArgs);
  if (defaults.result_kind_view !== undefined && effective.result_kind_view === undefined) {
    effective.result_kind_view = defaults.result_kind_view;
  }
  if (defaults.source_observed_at !== undefined) {
    effective.source_observed_at = effective.source_observed_at ?? defaults.source_observed_at;
  }
  return effective;
}

export function recallDispatchEventFields(resolution: Extract<TextMcpRecallDispatchResolution, { kind: "dispatch" }>) {
  if (canonicalJson(resolution.raw_arguments) === canonicalJson(resolution.arguments)) return {};
  return { raw_arguments: resolution.raw_arguments, effective_arguments: resolution.arguments };
}

function projectRecallTool(tool: unknown): unknown {
  if (!isPlainObject(tool) || tool.name !== "soul.recall") return tool;
  const next = structuredClone(tool);
  if (typeof next.description === "string") {
    next.description = stripCallerCoordinateGuidance(next.description);
  }
  const schema = isPlainObject(next.inputSchema) ? next.inputSchema
    : isPlainObject(next.input_schema) ? next.input_schema : null;
  if (schema !== null) stripCoordinateProperties(schema);
  return next;
}

function stripCoordinateProperties(schema: Record<string, unknown>): void {
  if (isPlainObject(schema.properties)) {
    for (const field of COORDINATE_FIELDS) delete schema.properties[field];
  }
  if (Array.isArray(schema.required)) {
    schema.required = schema.required.filter(key =>
      key !== "query_coordinates" && key !== "interpretation_proposal");
  }
}

function carriesCallerCoordinates(args: Record<string, unknown>): boolean {
  return COORDINATE_FIELDS.some(field => Object.hasOwn(args, field) && args[field] !== undefined);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
