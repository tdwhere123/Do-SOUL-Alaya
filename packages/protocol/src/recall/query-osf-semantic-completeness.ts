import { z } from "zod";
import {
  OpenSemanticFactorGraphSchema,
  OpenSemanticFactorGraphProposalSchema,
  groundOpenSemanticFactorGraph,
  type OpenSemanticFactorGraph,
  type OpenSemanticFactorGraphProposal
} from "../relations/open-semantic-factor-graph.js";
import {
  classifyQueryObligationStructuralRole,
  isOpenSemanticStructuralRole
} from "../relations/open-semantic-structural-role.js";

export const QUERY_FACT_FRAME_OSF_OBLIGATION_OPERATOR_ID =
  "query_fact_frame_osf_obligation_v2" as const;
export const QUERY_OSF_SEMANTIC_COMPLETENESS_OPERATOR_ID =
  "query_osf_semantic_completeness_v2" as const;
export const QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID =
  "open_semantic_factor_query_compiler_v9" as const;
export const RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID =
  "rule_based_query_fact_frame_extractor_v2" as const;

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const SlotSchema = z.object({
  surface: z.string().min(1),
  source_span: z.tuple([z.number().int().nonnegative(), z.number().int().positive()]),
  position: z.number().int().nonnegative()
}).strict().readonly();

export const QueryFactFrameOsfObligationSchema = z.object({
  schema_version: z.literal(2),
  operator_id: z.literal(QUERY_FACT_FRAME_OSF_OBLIGATION_OPERATOR_ID),
  query_digest: DigestSchema,
  fact_frame_producer_operator_id: z.string().min(1),
  fact_frame_capture_digest: DigestSchema,
  predicate: SlotSchema,
  subject: SlotSchema,
  value: SlotSchema,
  constraints: z.array(SlotSchema).max(1).readonly(),
  arity: z.number().int().min(2).max(3),
  obligation_digest: DigestSchema
}).strict().superRefine(validateObligationLayout).readonly();

export const QueryOsfSemanticCompletenessReceiptSchema = z.object({
  schema_version: z.literal(2),
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
  constraints: z.array(SlotSchema).max(1).readonly(),
  arity: z.number().int().min(2).max(3),
  osf_graph_digest: DigestSchema,
  receipt_digest: DigestSchema
}).strict().superRefine(validateObligationLayout).readonly();

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
  return JSON.stringify({
    schema_version: value.schema_version,
    operator_id: value.operator_id,
    query_digest: value.query_digest,
    fact_frame_producer_operator_id: value.fact_frame_producer_operator_id,
    fact_frame_capture_digest: value.fact_frame_capture_digest,
    predicate: value.predicate,
    subject: value.subject,
    value: value.value,
    constraints: value.constraints,
    arity: value.arity
  });
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
    schema_version: 2 as const,
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
    constraints: obligation.constraints,
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
  const result = proposition.arguments.find(({ position }) =>
    position === obligation.value.position);
  const requiredRole = classifyQueryObligationStructuralRole(obligation.value.surface);
  return proposition.arguments.length === obligation.arity &&
    nodeMatches(predicate, obligation.predicate) &&
    subject?.reference_kind === "factor" &&
    nodeMatches(graph.factors.find(({ factor_id }) =>
      factor_id === subject.reference_id), obligation.subject) &&
    constraintsMatch(graph, proposition.arguments, obligation.constraints) &&
    result?.reference_kind === "variable" &&
    graph.result_variable_ids[0] === result.reference_id &&
    nodeMatches(graph.variables.find(({ variable_id }) =>
      variable_id === result.reference_id), obligation.value) &&
    (requiredRole === null ||
      isOpenSemanticStructuralRole(result.binding_identity, requiredRole));
}

function constraintsMatch(
  graph: OpenSemanticFactorGraph,
  args: OpenSemanticFactorGraph["propositions"][number]["arguments"],
  constraints: QueryFactFrameOsfObligation["constraints"]
): boolean {
  return constraints.every((constraint) => {
    const argument = args.find(({ position }) => position === constraint.position);
    return argument?.reference_kind === "factor" &&
      nodeMatches(graph.factors.find(({ factor_id }) =>
        factor_id === argument.reference_id), constraint);
  });
}

function validateObligationLayout(
  value: { subject: { position: number }; value: { position: number };
    constraints: readonly { position: number }[]; arity: number },
  context: z.RefinementCtx
): void {
  const positions = value.constraints.map(({ position }) => position);
  const expected = positions.every((position, index) => position === index + 1) &&
    value.subject.position === 0 && value.value.position === positions.length + 1 &&
    value.arity === positions.length + 2;
  if (!expected) context.addIssue({
    code: "custom", message: "query OSF obligation positions do not match arity"
  });
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
