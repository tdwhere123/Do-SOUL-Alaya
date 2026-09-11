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
  Sha256DigestSchema,
  type FacetMode
} from "./common.js";
import { RecallTargetKindSchema } from "./product-identity.js";
import { inspectQueryProposalStructure } from "./proposal-structure.js";

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

const GuardShapeFields = {
  schema_version: SchemaVersionSchema,
  kind: GuardKindSchema,
  variable: ConditionalFieldIdSchema.optional(),
  time_scope: GuardTimeScopeSchema.optional(),
  equals_variable: ConditionalFieldIdSchema.optional(),
  entity_id: ConditionalFieldIdSchema.optional(),
  interval: GuardIntervalSchema.optional(),
  predicate_name: BoundedLabelSchema.optional(),
  authorization_scope: BoundedLabelSchema.optional()
};

// Proposal wire has no verdict; a client key must not parse as a Core decision.
export const ProposedGuardSchema = z.object(GuardShapeFields).strict().readonly();

export const GuardSchema = z
  .object({
    ...GuardShapeFields,
    verdict: GuardVerdictSchema.default("unresolved")
  })
  .strict()
  .readonly();

export type ProposedGuard = z.infer<typeof ProposedGuardSchema>;
export type Guard = z.infer<typeof GuardSchema>;

export const EnumerationPolicySchema = z.enum(["canonical", "associative"]);
export const ResultKindViewSchema = z.enum(["mixed", "memory_only", "source_only"]);
export const ClaimRequiredClaimSchema = z.enum(["supported", "unknown", "any"]);

export const AssociationCapContractSchema = z
  .object({
    domain_id: ConditionalFieldIdSchema,
    normalization: ConditionalFieldIdSchema,
    transfer_id: ConditionalFieldIdSchema,
    transfer_version: ConditionalFieldIdSchema
  })
  .strict()
  .readonly();

export const ClaimDemandSchema = z
  .object({
    variable: ConditionalFieldIdSchema,
    proposition_kind: BoundedLabelSchema,
    argument_variables: z.array(ConditionalFieldIdSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly(),
    required_claim: ClaimRequiredClaimSchema.default("any")
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
    claim_demands: z.array(ClaimDemandSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
    facet_mode: FacetModeSchema.default("same_path"),
    threshold_milligrades: MilligradeSchema.default(0),
    enumeration_policy: EnumerationPolicySchema.default("canonical"),
    result_kind_view: ResultKindViewSchema.default("mixed"),
    cap_contracts: z.array(AssociationCapContractSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
    protocol_version: NonNegativeIntSchema.min(1).optional(),
    supported_result_kinds: z.array(RecallTargetKindSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional()
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

export type QueryProgramNode<G> =
  | z.infer<typeof EpsilonProgramSchema>
  | z.infer<typeof EmptyProgramSchema>
  | {
      readonly schema_version: 1;
      readonly kind: "relation";
      readonly relation_kind: string;
      readonly source_variable: string;
      readonly target_variable: string;
      readonly guard: G;
      readonly facet_mode: FacetMode;
      readonly threshold_milligrades: number;
    }
  | {
      readonly schema_version: 1;
      readonly kind: "sequence";
      readonly steps: readonly QueryProgramNode<G>[];
    }
  | {
      readonly schema_version: 1;
      readonly kind: "alternative";
      readonly options: readonly QueryProgramNode<G>[];
    }
  | {
      readonly schema_version: 1;
      readonly kind: "repeat";
      readonly local_variables?: readonly string[];
      readonly count: number;
      readonly body: QueryProgramNode<G>;
    }
  | {
      readonly schema_version: 1;
      readonly kind: "closure";
      readonly local_variables?: readonly string[];
      readonly product_state_sufficient: true;
      readonly body: QueryProgramNode<G>;
    }
  | {
      readonly schema_version: 1;
      readonly kind: "hyperedge";
      readonly join: "and" | "or";
      readonly premises: readonly QueryProgramNode<G>[];
    };

export type QueryProgram = QueryProgramNode<Guard>;
export type ProposedQueryProgram = QueryProgramNode<ProposedGuard>;

function queryProgramSchemaOf<G>(guardSchema: z.ZodType<G>): z.ZodType<QueryProgramNode<G>> {
  const schema: z.ZodType<QueryProgramNode<G>> = z.lazy(() =>
    z.discriminatedUnion("kind", [
      EpsilonProgramSchema,
      EmptyProgramSchema,
      z
        .object({
          schema_version: SchemaVersionSchema,
          kind: z.literal("relation"),
          relation_kind: BoundedLabelSchema,
          source_variable: ConditionalFieldIdSchema,
          target_variable: ConditionalFieldIdSchema,
          guard: guardSchema,
          facet_mode: FacetModeSchema.default("same_path"),
          threshold_milligrades: MilligradeSchema.default(0)
        })
        .strict()
        .readonly(),
      z
        .object({
          schema_version: SchemaVersionSchema,
          kind: z.literal("sequence"),
          steps: z.array(schema).min(1).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly()
        })
        .strict()
        .readonly(),
      z
        .object({
          schema_version: SchemaVersionSchema,
          kind: z.literal("alternative"),
          options: z.array(schema).min(1).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly()
        })
        .strict()
        .readonly(),
      z
        .object({
          schema_version: SchemaVersionSchema,
          kind: z.literal("repeat"),
          local_variables: z.array(ConditionalFieldIdSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().default([]),
          count: z.number().int().min(1).max(8),
          body: schema
        })
        .strict()
        .readonly(),
      z
        .object({
          schema_version: SchemaVersionSchema,
          kind: z.literal("closure"),
          local_variables: z.array(ConditionalFieldIdSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().default([]),
          product_state_sufficient: z.literal(true),
          body: schema
        })
        .strict()
        .readonly(),
      z
        .object({
          schema_version: SchemaVersionSchema,
          kind: z.literal("hyperedge"),
          join: z.enum(["and", "or"]),
          premises: z.array(schema).min(1).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly()
        })
        .strict()
        .readonly()
    ])
  );
  return schema;
}

export const QueryProgramSchema: z.ZodType<QueryProgram> = queryProgramSchemaOf(GuardSchema);
export const ProposedQueryProgramSchema: z.ZodType<ProposedQueryProgram> = queryProgramSchemaOf(ProposedGuardSchema);

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

export const StoredCosineObligationSchema = z.object({
  obligation_id: ConditionalFieldIdSchema,
  producer_id: z.literal("stored.cosine.pair.v1"),
  provider_kind: ConditionalFieldIdSchema,
  model_id: ConditionalFieldIdSchema,
  schema_version: NonNegativeIntSchema,
  dimensions: z.number().int().min(1).max(16384),
  domain: z.literal("cosine.unit.v1"),
  normalization: z.literal("l2.dot.v1"),
  raw_threshold: z.number().finite().min(-1).max(1),
  transfer_id: z.literal("policy.cosine.linear.milligrade.v1"),
  transfer_version: z.literal("1"),
  policy_defined: z.literal(true)
}).strict().readonly();

export const StoredCosineAdmissionSchema = z.object({
  registry_version: z.literal("stored.cosine.admission.v1"),
  join: z.enum(["any", "all"]),
  obligations: z.array(StoredCosineObligationSchema).min(1).max(16).readonly()
}).strict().superRefine((value, context) => {
  if (new Set(value.obligations.map((row) => row.obligation_id)).size !== value.obligations.length) {
    context.addIssue({ code: "custom", message: "stored cosine obligation identities must be unique" });
  }
}).readonly();

export type StoredCosineObligation = z.infer<typeof StoredCosineObligationSchema>;
export type StoredCosineAdmission = z.infer<typeof StoredCosineAdmissionSchema>;

export const QueryProposalInputLimitsSchema = z
  .object({
    work_units: NonNegativeIntSchema.optional(),
    memory_bytes: NonNegativeIntSchema.optional(),
    max_ast_nodes: NonNegativeIntSchema.optional(),
    max_ast_depth: NonNegativeIntSchema.optional(),
    max_total_guards: NonNegativeIntSchema.optional(),
    max_total_predicates: NonNegativeIntSchema.optional(),
    max_total_hypotheses: NonNegativeIntSchema.optional()
  })
  .strict()
  .readonly();

const QueryInterpretationProposalBodySchema = z
  .object({
    schema_version: SchemaVersionSchema,
    original_query_digest: Sha256DigestSchema,
    producer_id: ConditionalFieldIdSchema,
    producer_version: ConditionalFieldIdSchema.optional(),
    stored_cosine_admission: StoredCosineAdmissionSchema.optional(),
    conditions: z.array(ProposedGuardSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
    input_limits: QueryProposalInputLimitsSchema.optional(),
    program: ProposedQueryProgramSchema.optional(),
    holes: z.array(QueryHoleSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
    hypotheses: z.array(QueryHypothesisSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional()
  })
  .strict()
  .readonly();

export type QueryInterpretationProposal = z.infer<typeof QueryInterpretationProposalBodySchema>;

export const QueryInterpretationProposalSchema: z.ZodType<QueryInterpretationProposal> = z
  .unknown()
  .transform((value, ctx) => {
    const inspection = inspectQueryProposalStructure(value);
    if (inspection.kind !== "ok") {
      ctx.addIssue({ code: "custom", message: inspection.message });
      return z.NEVER;
    }
    const parsed = QueryInterpretationProposalBodySchema.safeParse(value);
    if (!parsed.success) {
      ctx.addIssue({
        code: "custom",
        message: parsed.error.issues[0]?.message ?? "query interpretation proposal is invalid"
      });
      return z.NEVER;
    }
    return parsed.data;
  });

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
export type ClaimRequiredClaim = z.infer<typeof ClaimRequiredClaimSchema>;
export type AssociationCapContract = z.infer<typeof AssociationCapContractSchema>;
export type ClaimDemand = z.infer<typeof ClaimDemandSchema>;
export type QueryProposalInputLimits = z.infer<typeof QueryProposalInputLimitsSchema>;
export type GuardVerdict = z.infer<typeof GuardVerdictSchema>;
export type GuardTimeScope = z.infer<typeof GuardTimeScopeSchema>;
export type GuardKind = z.infer<typeof GuardKindSchema>;
export type GuardInterval = z.infer<typeof GuardIntervalSchema>;
export type QueryView = z.infer<typeof QueryViewSchema>;
export type QueryHole = z.infer<typeof QueryHoleSchema>;
export type QueryBinding = z.infer<typeof QueryBindingSchema>;
export type QueryHypothesis = z.infer<typeof QueryHypothesisSchema>;
export type RequestBudget = z.infer<typeof RequestBudgetSchema>;
export type QueryInterpretationStatus = z.infer<typeof QueryInterpretationStatusSchema>;
export type QueryTimeWindow = z.infer<typeof QueryTimeWindowSchema>;
export type QueryInterpretation = z.infer<typeof QueryInterpretationSchema>;
