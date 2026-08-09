import type { OpenSemanticFactorGraphProposal } from "@do-soul/alaya-protocol";
import {
  OpenSemanticFactorGraphProposalSchema,
  groundOpenSemanticFactorGraph
} from "@do-soul/alaya-protocol";
import type { SignalExtractor } from "../pi-mono-extractor.js";
import { withWallClockTimeout } from "../wall-clock-timeout.js";
import { OPEN_SEMANTIC_FACTOR_COMMON_PROMPT_PARTS } from
  "../official-api/system-prompt.js";
import { pruneUnboundOpenSemanticFactorProposal } from "./proposal-normalizer.js";

export const OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID =
  "open_semantic_factor_query_compiler_v2";

export const OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT = [
  "Compile one query into the same open semantic factor graph language used for source evidence.",
  'Return strict JSON only with shape {"semantic_factor_graph":{...}} and no markdown.',
  'The graph must use "source_kind":"query".',
  "Use exact contiguous source surfaces and omit character offsets; the runtime grounds surfaces.",
  "Represent every requested unknown as a structural variable and list its id in result_variable_ids.",
  "Keep dependent propositions together and preserve all explicit query constraints.",
  "Do not emit world ontology categories, fixed roles, answer-family labels, aliases, or gold-derived vocabulary.",
  ...OPEN_SEMANTIC_FACTOR_COMMON_PROMPT_PARTS
].join(" ");

export interface OpenSemanticFactorQueryCompiler {
  readonly operator_id: typeof OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID;
  compile(sourceText: string): Promise<Readonly<OpenSemanticFactorGraphProposal> | null>;
}

export function createOpenSemanticFactorQueryCompiler(input: Readonly<{
  readonly extractor: SignalExtractor;
  readonly timeoutMs?: number;
  readonly wallClockBudgetMs?: number;
}>): OpenSemanticFactorQueryCompiler {
  const timeoutMs = input.timeoutMs ?? 10_000;
  const wallClockBudgetMs = input.wallClockBudgetMs ?? timeoutMs + 30_000;
  return {
    operator_id: OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
    compile: async (sourceText) => {
      const normalized = sourceText.trim();
      if (normalized.length === 0) return null;
      const response = await withWallClockTimeout(
        (abortSignal) => input.extractor.extract({
          systemPrompt: OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT,
          userPrompt: JSON.stringify({
            schema_version: 1,
            source_kind: "query",
            source_text: normalized
          }),
          timeoutMs,
          abortSignal
        }),
        { budgetMs: wallClockBudgetMs }
      );
      const parsed = parseOpenSemanticFactorQueryResponse(response.rawJson);
      if (parsed === null || groundOpenSemanticFactorGraph(parsed, normalized) === null) {
        return null;
      }
      return parsed;
    }
  };
}

export function parseOpenSemanticFactorQueryResponse(
  rawJson: string
): Readonly<OpenSemanticFactorGraphProposal> | null {
  let value: unknown;
  try {
    value = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const graph = (value as { readonly semantic_factor_graph?: unknown })
    .semantic_factor_graph;
  const parsed = OpenSemanticFactorGraphProposalSchema.safeParse(
    pruneUnboundOpenSemanticFactorProposal(graph)
  );
  return parsed.success && parsed.data.source_kind === "query"
    ? parsed.data
    : null;
}
