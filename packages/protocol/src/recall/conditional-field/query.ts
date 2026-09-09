import { z } from "zod";
import {
  BOUNDED_DEFAULT_ARRAY_MAX,
  BoundedLabelSchema,
  IsoDatetimeStringSchema,
  NonNegativeIntSchema
} from "../../shared/schema-primitives.js";
import {
  ConditionalFieldIdSchema,
  FacetModeSchema,
  MilligradeSchema,
  SchemaVersionSchema,
  Sha256DigestSchema
} from "./common.js";

export const GuardVerdictSchema = z.enum(["true", "false", "unresolved"]);
export const GuardTimeScopeSchema = z.enum(["anchor", "associated", "none"]);
export const GuardKindSchema = z.enum([
  "equality",
  "source_bound_entity",
  "interval_relation",
  "authorization",
  "query_predicate"
]);

export const GuardIntervalSchema = z
  .object({
    start: IsoDatetimeStringSchema,
    end: IsoDatetimeStringSchema,
    time_domain: BoundedLabelSchema
  })
  .strict()
  .readonly();

export const GuardSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    kind: GuardKindSchema,
    verdict: GuardVerdictSchema.default("unresolved"),
    variable: ConditionalFieldIdSchema.optional(),
    time_scope: GuardTimeScopeSchema.optional(),
    equals_variable: ConditionalFieldIdSchema.optional(),
    entity_id: ConditionalFieldIdSchema.optional(),
    interval: GuardIntervalSchema.optional(),
    predicate_name: BoundedLabelSchema.optional(),
    authorization_scope: BoundedLabelSchema.optional()
  })
  .strict()
  .readonly();

export const EnumerationPolicySchema = z.enum(["canonical", "associative"]);
export const ResultKindViewSchema = z.enum(["mixed", "memory_only", "source_only"]);

export const AssociationCapContractSchema = z
  .object({
    domain_id: ConditionalFieldIdSchema,
    transfer_id: ConditionalFieldIdSchema,
    transfer_version: ConditionalFieldIdSchema
  })
  .strict()
  .readonly();

export const QueryViewSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    requested_roles: z
      .array(z.enum(["requested", "associated", "routing_only"]))
      .max(BOUNDED_DEFAULT_ARRAY_MAX)
      .readonly(),
    include_routing_only: z.boolean().default(false),
    claim_demands: z.array(z.object({
      variable: ConditionalFieldIdSchema,
      proposition_kind: BoundedLabelSchema,
      argument_variables: z.array(ConditionalFieldIdSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly()
    }).strict().readonly()).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
    facet_mode: FacetModeSchema.default("same_path"),
    threshold_milligrades: MilligradeSchema.default(0),
    enumeration_policy: EnumerationPolicySchema.default("canonical"),
    result_kind_view: ResultKindViewSchema.default("mixed"),
    cap_contracts: z.array(AssociationCapContractSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional()
  })
  .strict()
  .readonly();

export const QueryHoleSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    hole_id: ConditionalFieldIdSchema,
    variable: ConditionalFieldIdSchema,
    status: z.enum(["open", "bound", "unresolved"])
  })
  .strict()
  .readonly();

export const QueryBindingSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    variable: ConditionalFieldIdSchema,
    value: ConditionalFieldIdSchema
  })
  .strict()
  .readonly();

export const QueryHypothesisSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    hypothesis_id: ConditionalFieldIdSchema,
    bindings: z.array(QueryBindingSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly()
  })
  .strict()
  .readonly();

export const RequestBudgetSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    work_units: NonNegativeIntSchema,
    memory_bytes: NonNegativeIntSchema,
    page_budget: NonNegativeIntSchema,
    finalization_reserve: NonNegativeIntSchema,
    min_envelope: NonNegativeIntSchema
  })
  .strict()
  .readonly();

const EpsilonProgramSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    kind: z.literal("epsilon")
  })
  .strict()
  .readonly();

const EmptyProgramSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    kind: z.literal("empty")
  })
  .strict()
  .readonly();

const RelationProgramSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    kind: z.literal("relation"),
    relation_kind: BoundedLabelSchema,
    source_variable: ConditionalFieldIdSchema,
    target_variable: ConditionalFieldIdSchema,
    guard: GuardSchema,
    facet_mode: FacetModeSchema.default("same_path"),
    threshold_milligrades: MilligradeSchema.default(0)
  })
  .strict()
  .readonly();

export type QueryProgram =
  | z.infer<typeof EpsilonProgramSchema>
  | z.infer<typeof EmptyProgramSchema>
  | z.infer<typeof RelationProgramSchema>
  | {
      readonly schema_version: 1;
      readonly kind: "sequence";
      readonly steps: readonly QueryProgram[];
    }
  | {
      readonly schema_version: 1;
      readonly kind: "alternative";
      readonly options: readonly QueryProgram[];
    }
  | {
      readonly schema_version: 1;
      readonly kind: "repeat";
      readonly local_variables?: readonly string[];
      readonly count: number;
      readonly body: QueryProgram;
    }
  | {
      readonly schema_version: 1;
      readonly kind: "closure";
      readonly local_variables?: readonly string[];
      readonly product_state_sufficient: true;
      readonly body: QueryProgram;
    }
  | {
      readonly schema_version: 1;
      readonly kind: "hyperedge";
      readonly join: "and" | "or";
      readonly premises: readonly QueryProgram[];
    };

export const QueryProgramSchema: z.ZodType<QueryProgram> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    EpsilonProgramSchema,
    EmptyProgramSchema,
    RelationProgramSchema,
    z
      .object({
        schema_version: SchemaVersionSchema,
        kind: z.literal("sequence"),
        steps: z.array(QueryProgramSchema).min(1).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly()
      })
      .strict()
      .readonly(),
    z
      .object({
        schema_version: SchemaVersionSchema,
        kind: z.literal("alternative"),
        options: z.array(QueryProgramSchema).min(1).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly()
      })
      .strict()
      .readonly(),
    z
      .object({
        schema_version: SchemaVersionSchema,
        kind: z.literal("repeat"),
        local_variables: z.array(ConditionalFieldIdSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().default([]),
        count: z.number().int().min(1).max(8),
        body: QueryProgramSchema
      })
      .strict()
      .readonly(),
    z
      .object({
        schema_version: SchemaVersionSchema,
        kind: z.literal("closure"),
        local_variables: z.array(ConditionalFieldIdSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().default([]),
        product_state_sufficient: z.literal(true),
        body: QueryProgramSchema
      })
      .strict()
      .readonly(),
    z
      .object({
        schema_version: SchemaVersionSchema,
        kind: z.literal("hyperedge"),
        join: z.enum(["and", "or"]),
        premises: z.array(QueryProgramSchema).min(1).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly()
      })
      .strict()
      .readonly()
  ])
);

export const QueryInterpretationStatusSchema = z.enum([
  "resolved",
  "hypotheses",
  "partial",
  "unsupported",
  "malformed",
  "resource_rejected"
]);

export const QueryTimeWindowSchema = z
  .object({
    start: IsoDatetimeStringSchema,
    end: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const QueryInterpretationProposalSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    original_query_digest: Sha256DigestSchema,
    producer_id: ConditionalFieldIdSchema,
    conditions: z.array(GuardSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
    input_limits: z
      .object({
        work_units: NonNegativeIntSchema.optional(),
        memory_bytes: NonNegativeIntSchema.optional()
      })
      .strict()
      .readonly()
      .optional(),
    program: QueryProgramSchema.optional(),
    holes: z.array(QueryHoleSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
    hypotheses: z.array(QueryHypothesisSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional()
  })
  .strict()
  .readonly();

export const QueryInterpretationSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    query_id: ConditionalFieldIdSchema,
    status: QueryInterpretationStatusSchema,
    snapshot_id: Sha256DigestSchema,
    program: QueryProgramSchema,
    source_guard: GuardSchema.optional(),
    view: QueryViewSchema,
    holes: z.array(QueryHoleSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly(),
    hypotheses: z.array(QueryHypothesisSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly(),
    interpretation_clock: IsoDatetimeStringSchema.optional(),
    time_window: QueryTimeWindowSchema.optional(),
    interpretation_proposal: QueryInterpretationProposalSchema.optional()
  })
  .strict()
  .readonly();

export type EnumerationPolicy = z.infer<typeof EnumerationPolicySchema>;
export type ResultKindView = z.infer<typeof ResultKindViewSchema>;
export type AssociationCapContract = z.infer<typeof AssociationCapContractSchema>;
export type QueryInterpretationProposal = z.infer<typeof QueryInterpretationProposalSchema>;
export type GuardVerdict = z.infer<typeof GuardVerdictSchema>;
export type GuardTimeScope = z.infer<typeof GuardTimeScopeSchema>;
export type GuardKind = z.infer<typeof GuardKindSchema>;
export type GuardInterval = z.infer<typeof GuardIntervalSchema>;
export type Guard = z.infer<typeof GuardSchema>;
export type QueryView = z.infer<typeof QueryViewSchema>;
export type QueryHole = z.infer<typeof QueryHoleSchema>;
export type QueryBinding = z.infer<typeof QueryBindingSchema>;
export type QueryHypothesis = z.infer<typeof QueryHypothesisSchema>;
export type RequestBudget = z.infer<typeof RequestBudgetSchema>;
export type QueryInterpretationStatus = z.infer<typeof QueryInterpretationStatusSchema>;
export type QueryTimeWindow = z.infer<typeof QueryTimeWindowSchema>;
export type QueryInterpretation = z.infer<typeof QueryInterpretationSchema>;
