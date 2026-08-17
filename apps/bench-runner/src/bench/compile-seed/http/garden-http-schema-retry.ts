import type { BenchSignalExtractor } from "../compile-seed-types.js";
import {
  OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT,
  OFFICIAL_API_SYSTEM_PROMPT
} from "@do-soul/alaya-soul";
import { isOutputTokenTruncation } from "./output-token-retry.js";

type GardenHttpExtractInput = Parameters<BenchSignalExtractor["extract"]>[0];

export function withGardenResponseSchemaRepair(
  input: GardenHttpExtractInput,
  instruction: string | null
): GardenHttpExtractInput {
  if (instruction === null) return input;
  const correction = `Schema correction for this retry: ${instruction}`;
  const systemPrompt = usesSingleAssertionRepair(input)
    ? OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT
    : input.systemPrompt;
  return Object.freeze({
    ...input,
    systemPrompt: `${systemPrompt}\n\n${correction}`,
    userPrompt: `${input.userPrompt}\n\n${JSON.stringify({
      schema_repair: { instruction: correction }
    })}`
  });
}

function usesSingleAssertionRepair(input: GardenHttpExtractInput): boolean {
  if (input.systemPrompt !== OFFICIAL_API_SYSTEM_PROMPT) return false;
  try {
    const request = JSON.parse(input.userPrompt) as unknown;
    if (typeof request !== "object" || request === null || Array.isArray(request)) return false;
    const assertions = (request as { readonly source_assertions?: unknown }).source_assertions;
    return Array.isArray(assertions) && assertions.length === 1;
  } catch {
    return false;
  }
}

export function resolveGardenSchemaRetryInstruction(
  input: GardenHttpExtractInput,
  error: unknown
): string {
  const callerOwned = input.responseSchemaRetryInstruction?.trim();
  return callerOwned && callerOwned.length > 0
    ? callerOwned
    : schemaRetryInstruction(error);
}

function schemaRetryInstruction(error: unknown): string {
  if (isOutputTokenTruncation(error)) {
    return "The previous response exhausted the output-token budget. " +
      "Return the same source-supported meaning compactly: merge overlapping or entailed " +
      "catalog assertions, emit one signal per independent durable fact, use the shortest " +
      "complete matched_text, and use a minimal closed semantic_factor_graph. Never repeat " +
      "a signal, factor, proposition, explanation, or source text.";
  }
  const message = error instanceof Error ? error.message : "";
  if (/semantic_factor_graph_invalid_arguments_too_few/iu.test(message)) {
    return "Every semantic_factor_graph proposition must have at least one argument. " +
      "Each argument needs contiguous position, binding_identity, reference_kind, and reference_id.";
  }
  if (/semantic_factor_graph_(?:missing|required)/iu.test(message)) {
    return "Discard the invalid response. Only two response forms are valid: " +
      'exactly {"signals":[]}, or {"signals":[...]} where every signal includes ' +
      "a valid semantic_factor_graph with at least two factors and one proposition. " +
      "Never emit a graphless placeholder signal or legacy fact_frame.";
  }
  if (/semantic_factor_graph_invalid_identity/iu.test(message)) {
    return "Use NFKC lowercase semantic_identity and binding_identity text.";
  }
  if (/semantic_factor_graph_invalid_reference/iu.test(message)) {
    return "Every predicate and argument reference_id must resolve to a declared factor or variable.";
  }
  return "Return only JSON that satisfies every required signal and semantic_factor_graph field.";
}
