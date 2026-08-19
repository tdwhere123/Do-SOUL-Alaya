import { z } from "zod";
import {
  OpenSemanticFactorGraphSchema,
  OpenSemanticFactorGraphProposalSchema,
  groundOpenSemanticFactorGraph,
  type OpenSemanticFactorGraph,
  type OpenSemanticFactorGraphProposal
} from "./open-semantic-factor-graph.js";

export const QUERY_FACT_FRAME_OSF_OBLIGATION_OPERATOR_ID =
  "query_fact_frame_osf_obligation_v1" as const;
export const QUERY_OSF_SEMANTIC_COMPLETENESS_OPERATOR_ID =
  "query_osf_semantic_completeness_v1" as const;
export const QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID =
  "open_semantic_factor_query_compiler_v7" as const;

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const SlotSchema = z.object({
  surface: z.string().min(1),
  source_span: z.tuple([z.number().int().nonnegative(), z.number().int().positive()]),
  position: z.number().int().nonnegative()
}).strict().readonly();

export const QueryFactFrameOsfObligationSchema = z.object({
  schema_version: z.literal(1),
  operator_id: z.literal(QUERY_FACT_FRAME_OSF_OBLIGATION_OPERATOR_ID),
  query_digest: DigestSchema,
  fact_frame_producer_operator_id: z.string().min(1),
  fact_frame_capture_digest: DigestSchema,
  predicate: SlotSchema,
  subject: SlotSchema,
  value: SlotSchema,
  arity: z.literal(2),
  obligation_digest: DigestSchema
}).strict().readonly();

export const QueryOsfSemanticCompletenessReceiptSchema = z.object({
  schema_version: z.literal(1),
  operator_id: z.literal(QUERY_OSF_SEMANTIC_COMPLETENESS_OPERATOR_ID),
  query_digest: DigestSchema,
  fact_frame_producer_operator_id: z.string().min(1),
  fact_frame_capture_digest: DigestSchema,
  obligation_operator_id: z.literal(QUERY_FACT_FRAME_OSF_OBLIGATION_OPERATOR_ID),
  obligation_digest: DigestSchema,
  query_producer_operator_id: z.literal(QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID),
  predicate: SlotSchema,
  subject: SlotSchema,
  value: SlotSchema,
  arity: z.literal(2),
  osf_graph_digest: DigestSchema,
  receipt_digest: DigestSchema
}).strict().readonly();

export type QueryFactFrameOsfObligation =
  z.infer<typeof QueryFactFrameOsfObligationSchema>;
export type QueryOsfSemanticCompletenessReceipt =
  z.infer<typeof QueryOsfSemanticCompletenessReceiptSchema>;
export const CertifiedQueryOsfGraphSchema = z.object({
  schema_version: z.literal(1),
  producer_operator_id: z.literal(QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID),
  graph: OpenSemanticFactorGraphProposalSchema,
  semantic_completeness_receipt: QueryOsfSemanticCompletenessReceiptSchema
}).strict().readonly();
export type CertifiedQueryOsfGraph = z.infer<typeof CertifiedQueryOsfGraphSchema>;
export type SemanticCompletenessSha256 = (preimage: string) => string;

export function queryFactFrameOsfObligationPreimage(value: Omit<
  QueryFactFrameOsfObligation, "obligation_digest"
>): string {
  return JSON.stringify(value);
}

export function queryOsfSemanticCompletenessReceiptPreimage(value: Omit<
  QueryOsfSemanticCompletenessReceipt, "receipt_digest"
>): string {
  return JSON.stringify(value);
}

export function certifyQueryOsfSemanticCompleteness(input: Readonly<{
  query_text: string;
  graph: Readonly<OpenSemanticFactorGraphProposal | OpenSemanticFactorGraph>;
  obligation: Readonly<QueryFactFrameOsfObligation>;
  producer_operator_id: string;
  sha256: SemanticCompletenessSha256;
}>): QueryOsfSemanticCompletenessReceipt | null {
  const obligation = verifyObligation(input.obligation, input.sha256);
  if (input.producer_operator_id !== QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID) return null;
  if (obligation.query_digest !== digest(input.query_text, input.sha256)) return null;
  const grounded = resolveGroundedGraph(input.graph, input.query_text);
  if (grounded === null || !graphSatisfiesObligation(grounded, obligation)) return null;
  const body = {
    schema_version: 1 as const,
    operator_id: QUERY_OSF_SEMANTIC_COMPLETENESS_OPERATOR_ID,
    query_digest: obligation.query_digest,
    fact_frame_producer_operator_id: obligation.fact_frame_producer_operator_id,
    fact_frame_capture_digest: obligation.fact_frame_capture_digest,
    obligation_operator_id: obligation.operator_id,
    obligation_digest: obligation.obligation_digest,
    query_producer_operator_id: input.producer_operator_id,
    predicate: obligation.predicate,
    subject: obligation.subject,
    value: obligation.value,
    arity: obligation.arity,
    osf_graph_digest: digest(JSON.stringify(grounded), input.sha256)
  };
  return QueryOsfSemanticCompletenessReceiptSchema.parse({
    ...body,
    receipt_digest: digest(queryOsfSemanticCompletenessReceiptPreimage(body), input.sha256)
  });
}

function resolveGroundedGraph(
  graph: Readonly<OpenSemanticFactorGraphProposal | OpenSemanticFactorGraph>,
  queryText: string
): OpenSemanticFactorGraph | null {
  const grounded = OpenSemanticFactorGraphSchema.safeParse(graph);
  return grounded.success
    ? grounded.data
    : groundOpenSemanticFactorGraph(graph, queryText);
}

function verifyObligation(
  value: Readonly<QueryFactFrameOsfObligation>,
  sha256: SemanticCompletenessSha256
): QueryFactFrameOsfObligation {
  const obligation = QueryFactFrameOsfObligationSchema.parse(value);
  const { obligation_digest: _digest, ...body } = obligation;
  if (obligation.obligation_digest !==
      digest(queryFactFrameOsfObligationPreimage(body), sha256)) {
    throw new Error("query fact-frame OSF obligation digest mismatch");
  }
  return obligation;
}

function graphSatisfiesObligation(
  graph: NonNullable<ReturnType<typeof groundOpenSemanticFactorGraph>>,
  obligation: QueryFactFrameOsfObligation
): boolean {
  if (graph.propositions.length !== 1 || graph.result_variable_ids.length !== 1) return false;
  const proposition = graph.propositions[0]!;
  const predicate = graph.factors.find(({ factor_id }) =>
    factor_id === proposition.predicate_factor_id);
  const subject = proposition.arguments.find(({ position }) => position === 0);
  const value = proposition.arguments.find(({ position }) => position === 1);
  return proposition.arguments.length === obligation.arity &&
    nodeMatches(predicate, obligation.predicate) &&
    subject?.reference_kind === "factor" &&
    nodeMatches(graph.factors.find(({ factor_id }) =>
      factor_id === subject.reference_id), obligation.subject) &&
    value?.reference_kind === "variable" &&
    graph.result_variable_ids[0] === value.reference_id &&
    nodeMatches(graph.variables.find(({ variable_id }) =>
      variable_id === value.reference_id), obligation.value);
}

function nodeMatches(
  node: Readonly<{ surface: string; source_span: readonly [number, number] }> | undefined,
  slot: Readonly<{ surface: string; source_span: readonly [number, number] }>
): boolean {
  return node?.surface === slot.surface &&
    node.source_span[0] === slot.source_span[0] && node.source_span[1] === slot.source_span[1];
}

function digest(preimage: string, sha256: SemanticCompletenessSha256): string {
  return `sha256:${sha256(preimage)}`;
}
