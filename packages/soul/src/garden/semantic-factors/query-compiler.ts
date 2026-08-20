import { createHash } from "node:crypto";
import type {
  OpenSemanticFactorGraphProposal,
  CertifiedQueryOsfGraph,
  QueryFactFrameOsfObligation
} from "@do-soul/alaya-protocol";
import {
  QueryFactFrameOsfObligationSchema,
  QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
  QUERY_FACT_FRAME_OSF_OBLIGATION_OPERATOR_ID,
  RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID,
  queryFactFrameOsfObligationPreimage,
  OpenSemanticFactorGraphProposalSchema,
  certifyQueryOsfSemanticCompleteness,
  groundOpenSemanticFactorGraph
} from "@do-soul/alaya-protocol";
import type { SignalExtractor } from "../pi-mono-extractor.js";
import { withWallClockTimeout } from "../wall-clock-timeout.js";
import { OPEN_SEMANTIC_FACTOR_COMMON_PROMPT_PARTS } from
  "../official-api/system-prompt.js";

export const OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID =
  QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID;
export const OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE =
  openSemanticFactorQueryRequestTemplatePreimage();

const OPEN_SEMANTIC_FACTOR_QUERY_RESPONSE_CONTRACT = [
  'Return strict JSON only with exactly {"semantic_factor_graph":{"schema_version":2,"source_kind":"query","factors":[...],"variables":[...],"result_variable_ids":[...],"propositions":[...]}} and no markdown.',
  'Each variable is {"variable_id":LOCAL_ID,"surface":EXACT_SUBSTRING}; add "source_occurrence":N only when selecting a repeated surface after its first occurrence.',
  "A variable surface is the exact query phrase that stands for an unknown, never a predicted answer.",
  "Every variable referenced by a proposition must appear in variables, and every result_variable_ids entry must reference one of those variables.",
  "Preserve each predicate's semantic argument order; relation-local binding names need not match source evidence graphs.",
  "Place every WH phrase or other requested unknown as the structural variable in the exact predicate argument position it asks for; never append it as an extra argument or substitute it for a different participant.",
  "The full requested or WH phrase belongs exclusively to one variable; never emit a factor for that variable or any substring inside its surface.",
  "Keep every explicit non-WH participant or constraint in its required position-preserving factor argument.",
  "Follow required_graph_layout mechanically: predicate and factor entries must be factors, variable entries must be variables, and only an entry with result:true may appear in result_variable_ids.",
  'Structure example only: {"semantic_factor_graph":{"schema_version":2,"source_kind":"query","factors":[{"factor_id":"predicate","surface":"give","semantic_identity":"give"},{"factor_id":"participant","surface":"A","semantic_identity":"a"}],"variables":[{"variable_id":"answer","surface":"Who"}],"result_variable_ids":["answer"],"propositions":[{"proposition_id":"query","predicate_factor_id":"predicate","arguments":[{"position":0,"binding_identity":"giver","reference_kind":"factor","reference_id":"participant"},{"position":1,"binding_identity":"recipient","reference_kind":"variable","reference_id":"answer"}]}]}}.'
].join(" ");

export const OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT = [
  "Compile one query into the same open semantic factor graph language used for source evidence.",
  OPEN_SEMANTIC_FACTOR_QUERY_RESPONSE_CONTRACT,
  "Use exact contiguous source surfaces and omit character offsets; the runtime grounds surfaces.",
  "Represent every requested unknown as a structural variable and list its id in result_variable_ids.",
  "Keep dependent propositions together and preserve all explicit query constraints.",
  "The supplied semantic completeness obligation and required_graph_layout are authoritative; satisfy the exact ordered layout or return no usable graph.",
  "Do not emit world ontology categories, fixed roles, answer-family labels, aliases, or gold-derived vocabulary.",
  ...OPEN_SEMANTIC_FACTOR_COMMON_PROMPT_PARTS
].join(" ");

export interface OpenSemanticFactorQueryCompiler {
  readonly operator_id: typeof OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID;
  compile(
    sourceText: string,
    obligation: Readonly<QueryFactFrameOsfObligation>
  ): Promise<Readonly<CertifiedQueryOsfGraph> | null>;
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
    compile: async (sourceText, obligationInput) => {
      const normalized = sourceText.trim();
      if (normalized.length === 0) return null;
      const obligation = QueryFactFrameOsfObligationSchema.safeParse(obligationInput);
      if (!obligation.success) return null;
      const response = await withWallClockTimeout(
        (abortSignal) => input.extractor.extract({
          systemPrompt: OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT,
          userPrompt: buildOpenSemanticFactorQueryUserPrompt(normalized, obligation.data),
          timeoutMs,
          abortSignal,
          responseSchemaRetryInstruction: [
            "Correct the previous response to match this complete contract.",
            OPEN_SEMANTIC_FACTOR_QUERY_RESPONSE_CONTRACT
          ].join(" "),
          validateRawJson: (rawJson) =>
            assertOpenSemanticFactorQueryResponse(rawJson, normalized, obligation.data)
        }),
        { budgetMs: wallClockBudgetMs }
      );
      const parsed = parseOpenSemanticFactorQueryResponse(response.rawJson);
      if (parsed === null || groundOpenSemanticFactorGraph(parsed, normalized) === null) return null;
      const receipt = certifyQueryOsfSemanticCompleteness({
        query_text: normalized, graph: parsed, obligation: obligation.data,
        producer_operator_id: OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID, sha256
      });
      return receipt === null ? null : Object.freeze({
        schema_version: 1 as const,
        producer_operator_id: OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
        graph: parsed,
        semantic_completeness_receipt: receipt
      });
    }
  };
}

export function buildOpenSemanticFactorQueryUserPrompt(
  sourceText: string,
  obligation: Readonly<QueryFactFrameOsfObligation>
): string {
  return JSON.stringify({
    schema_version: 5,
    source_kind: "query",
    source_text: sourceText,
    semantic_completeness_obligation: obligation,
    required_graph_layout: requiredGraphLayout(obligation)
  });
}

function requiredGraphLayout(obligation: Readonly<QueryFactFrameOsfObligation>) {
  return {
    schema_version: 1 as const,
    predicate: { node_kind: "factor" as const, surface: obligation.predicate.surface },
    arguments: [
      {
        position: obligation.subject.position,
        node_kind: "factor" as const,
        surface: obligation.subject.surface,
        result: false as const
      },
      ...obligation.constraints.map((constraint) => ({
        position: constraint.position,
        node_kind: "factor" as const,
        surface: constraint.surface,
        result: false as const
      })),
      {
        position: obligation.value.position,
        node_kind: "variable" as const,
        surface: obligation.value.surface,
        result: true as const
      }
    ],
    arity: obligation.arity,
    result_variable_count: 1 as const
  };
}

export function openSemanticFactorQueryRequestTemplatePreimage(): string {
  const sourceText = "What did A give?";
  const body = {
    schema_version: 2 as const,
    operator_id: QUERY_FACT_FRAME_OSF_OBLIGATION_OPERATOR_ID,
    query_digest: prefixedSha256(sourceText),
    fact_frame_producer_operator_id: RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID,
    fact_frame_capture_digest: prefixedSha256(`capture:${sourceText}`),
    predicate: { surface: "give", source_span: [11, 15] as [number, number], position: 0 },
    subject: { surface: "A", source_span: [9, 10] as [number, number], position: 0 },
    value: { surface: "What", source_span: [0, 4] as [number, number], position: 1 },
    constraints: [],
    arity: 2 as const
  };
  const obligation = QueryFactFrameOsfObligationSchema.parse({
    ...body,
    obligation_digest: prefixedSha256(queryFactFrameOsfObligationPreimage(body))
  });
  return buildOpenSemanticFactorQueryUserPrompt(sourceText, obligation);
}

function assertOpenSemanticFactorQueryResponse(
  rawJson: string,
  sourceText: string,
  obligation: Readonly<QueryFactFrameOsfObligation>
): void {
  const parsed = parseOpenSemanticFactorQueryResponse(rawJson);
  if (parsed === null || groundOpenSemanticFactorGraph(parsed, sourceText) === null ||
      certifyQueryOsfSemanticCompleteness({
        query_text: sourceText, graph: parsed, obligation,
        producer_operator_id: OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID, sha256
      }) === null) {
    throw new Error("query semantic factor graph missing or invalid");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function prefixedSha256(value: string): `sha256:${string}` {
  return `sha256:${sha256(value)}`;
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
  const parsed = OpenSemanticFactorGraphProposalSchema.safeParse(graph);
  return parsed.success && parsed.data.source_kind === "query"
    ? parsed.data
    : null;
}
