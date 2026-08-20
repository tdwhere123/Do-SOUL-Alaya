import { digestRecallFieldIdentity } from "@do-soul/alaya-core";
import { z } from "zod";
import {
  OpenSemanticFactorActivationStateSchema,
  OpenSemanticFactorFormationCaptureSchema
} from "@do-soul/alaya-protocol";

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const IdSchema = z.string().min(1);
const CountSchema = z.number().int().nonnegative();
const StringArraySchema = z.array(IdSchema).readonly();
const CompositionStatusSchema = z.enum([
  "composed",
  "no_match",
  "ineligible",
  "unavailable",
  "rejected"
]);

const ArgumentMappingSchema = z.object({
  binding_identity: IdSchema,
  evidence_binding_identity: IdSchema,
  binding_alignment_operator_id: z.enum([
    "exact_binding_identity_v1",
    "position_anchored_binding_group_v1"
  ]),
  query_position: CountSchema,
  evidence_position: CountSchema,
  query_reference_kind: z.enum(["factor", "variable"]),
  query_reference_id: IdSchema,
  evidence_factor_id: IdSchema,
  evidence_semantic_identity: IdSchema,
  evidence_surface: IdSchema,
  evidence_source_span: z.tuple([CountSchema, CountSchema]).readonly(),
  operator_id: z.enum(["exact_semantic_identity_v1", "variable_binding_v1"])
}).strict().readonly();

const PropositionMatchSchema = z.object({
  query_proposition_id: IdSchema,
  evidence_proposition_id: IdSchema,
  predicate_alignment: z.object({
    query_factor_id: IdSchema,
    evidence_factor_id: IdSchema,
    operator_id: z.enum([
      "exact_semantic_identity_v1",
      "duration_measure_binding_v1"
    ])
  }).strict().readonly(),
  argument_mappings: z.array(ArgumentMappingSchema).readonly()
}).strict().readonly();

// Pairwise receipts stay v6; join operator is not a pairwise predicate.
// Authority-lane phase schema is not copied here — merge on this operator literal.
const CompatibilityReceiptSchema = z.object({
  schema_version: z.literal(1),
  operator_id: z.literal("open_semantic_factor_compatibility_v6"),
  status: z.enum([
    "compatible",
    "incompatible",
    "ineligible",
    "unavailable",
    "rejected"
  ]),
  evidence_capture_digest: DigestSchema,
  query_capture_digest: DigestSchema,
  evidence_graph_digest: DigestSchema.nullable(),
  query_graph_digest: DigestSchema.nullable(),
  query_proposition_count: CountSchema,
  matched_query_proposition_count: CountSchema,
  proposition_match_candidates: z.array(PropositionMatchSchema).readonly(),
  proposition_matches: z.array(PropositionMatchSchema).readonly(),
  receipt_digest: DigestSchema
}).strict().readonly();

export const OpenSemanticFactorCompatibilityTraceSchema = z.object({
  schema_version: z.literal(2),
  operator_id: z.literal("open_semantic_factor_compatibility_trace_v2"),
  query_capture_digest: DigestSchema,
  observed_evidence_count: CountSchema,
  matchable_evidence_count: CountSchema,
  evaluated_evidence_count: CountSchema,
  unavailable_evidence_ids: StringArraySchema,
  unevaluated_evidence_ids: StringArraySchema,
  incomparable_seal: z.enum(["none", "ineligible", "unavailable", "rejected"]),
  truncated: z.boolean(),
  entries: z.array(z.object({
    evidence_id: IdSchema,
    receipt: CompatibilityReceiptSchema
  }).strict().readonly()).readonly(),
  trace_digest: DigestSchema
}).strict().superRefine((trace, context) => {
  if (!compatibilityTraceContractHolds(trace)) {
    context.addIssue({
      code: "custom",
      message: "open semantic factor compatibility trace contract mismatch"
    });
  }
}).readonly();

const CompositionSolutionSchema = z.object({
  result_bindings: z.array(z.object({
    variable_id: IdSchema,
    semantic_identity: IdSchema,
    surfaces: StringArraySchema,
    evidence_ids: StringArraySchema
  }).strict().readonly()).readonly(),
  evidence_ids: StringArraySchema,
  proposition_matches: z.array(z.object({
    query_proposition_id: IdSchema,
    evidence_id: IdSchema,
    evidence_proposition_id: IdSchema
  }).strict().readonly()).readonly()
}).strict().readonly();

export const OpenSemanticFactorCompositionReceiptSchema = z.object({
  schema_version: z.literal(2),
  operator_id: z.literal("open_semantic_factor_composition_v2"),
  status: CompositionStatusSchema,
  compatibility_trace_digest: DigestSchema,
  query_capture_digest: DigestSchema,
  result_variable_ids: StringArraySchema,
  search_step_count: CountSchema,
  solution_count: CountSchema,
  observed_binding_count: CountSchema,
  binding_observation_count: CountSchema,
  truncated: z.boolean(),
  bindings: z.array(z.object({
    variable_id: IdSchema,
    binding_identity: IdSchema,
    evidence_id: IdSchema,
    evidence_factor_id: IdSchema,
    semantic_identity: IdSchema,
    surface: IdSchema,
    source_span: z.tuple([CountSchema, CountSchema]).readonly(),
    query_proposition_id: IdSchema,
    evidence_proposition_id: IdSchema
  }).strict().readonly()).readonly(),
  solutions: z.array(CompositionSolutionSchema).readonly(),
  variable_collections: z.array(z.object({
    variable_id: IdSchema,
    observation_count: CountSchema,
    distinct_value_count: CountSchema,
    values: z.array(z.object({
      semantic_identity: IdSchema,
      surfaces: StringArraySchema,
      evidence_ids: StringArraySchema
    }).strict().readonly()).readonly()
  }).strict().readonly()).readonly(),
  receipt_digest: DigestSchema
}).strict().superRefine((receipt, context) => {
  if (!receiptDigestHolds(receipt)) {
    context.addIssue({ code: "custom", message: "composition receipt digest mismatch" });
  }
}).readonly();

export const OpenSemanticFactorActivationReceiptSchema = z.object({
  schema_version: z.literal(2),
  operator_id: z.literal("open_semantic_solution_membership_activation_v2"),
  status: CompositionStatusSchema,
  composition_receipt_digest: DigestSchema,
  entry_count: CountSchema,
  truncated: z.boolean(),
  entries: z.array(z.object({
    evidence_id: IdSchema,
    state: OpenSemanticFactorActivationStateSchema,
    activation: z.number().gt(0).max(1),
    solution_count: CountSchema,
    proposition_match_count: CountSchema
  }).strict().readonly()).readonly(),
  missing_evidence_policy: z.literal("no_op"),
  ranking_effect: z.literal("candidate_attribution"),
  receipt_digest: DigestSchema
}).strict().superRefine((receipt, context) => {
  if (!receiptDigestHolds(receipt)) {
    context.addIssue({ code: "custom", message: "activation receipt digest mismatch" });
  }
}).readonly();

export { OpenSemanticFactorFormationCaptureSchema };

function compatibilityTraceContractHolds(trace: {
  readonly observed_evidence_count: number;
  readonly matchable_evidence_count: number;
  readonly evaluated_evidence_count: number;
  readonly unavailable_evidence_ids: readonly string[];
  readonly unevaluated_evidence_ids: readonly string[];
  readonly incomparable_seal: "none" | "ineligible" | "unavailable" | "rejected";
  readonly truncated: boolean;
  readonly entries: readonly {
    readonly evidence_id: string;
    readonly receipt: { readonly [key: string]: unknown };
  }[];
  readonly trace_digest: string;
}): boolean {
  const remainderBudget = trace.observed_evidence_count - trace.matchable_evidence_count;
  const evaluatedIds = new Set(trace.entries.map((entry) => entry.evidence_id));
  const unevaluated = new Set(trace.unevaluated_evidence_ids);
  return trace.evaluated_evidence_count === trace.entries.length &&
    evaluatedIds.size === trace.entries.length &&
    trace.entries.every((entry) => receiptDigestHolds(entry.receipt)) &&
    trace.matchable_evidence_count >= trace.evaluated_evidence_count &&
    trace.observed_evidence_count >= trace.matchable_evidence_count &&
    uniqueSortedDisjoint(trace.unavailable_evidence_ids, evaluatedIds) &&
    uniqueSortedDisjoint(trace.unevaluated_evidence_ids, evaluatedIds) &&
    trace.unevaluated_evidence_ids.length === remainderBudget &&
    trace.unavailable_evidence_ids.every((evidenceId) => unevaluated.has(evidenceId)) &&
    (trace.incomparable_seal === "none") ===
      (trace.observed_evidence_count === trace.matchable_evidence_count &&
        trace.unevaluated_evidence_ids.length === 0) &&
    trace.truncated === (trace.matchable_evidence_count > trace.evaluated_evidence_count) &&
    receiptDigestHolds(trace);
}

function receiptDigestHolds(receipt: { readonly [key: string]: unknown }): boolean {
  const digest = receipt.trace_digest ?? receipt.receipt_digest;
  const { trace_digest: _trace, receipt_digest: _receipt, ...body } = receipt;
  return digest === digestRecallFieldIdentity(body);
}

function uniqueSortedDisjoint(
  ids: readonly string[],
  excluded: ReadonlySet<string>
): boolean {
  return ids.every((evidenceId, index) =>
    evidenceId.trim().length > 0 &&
    (index === 0 || ids[index - 1]! < evidenceId) &&
    !excluded.has(evidenceId));
}
