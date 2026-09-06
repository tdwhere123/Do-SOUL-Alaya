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
  SchemaVersionSchema
} from "./common.js";

export const GuardVerdictSchema = z.enum(["true", "false", "unresolved"]);
export const GuardTimeScopeSchema = z.enum(["anchor", "associated", "none"]);

export const GuardSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    verdict: GuardVerdictSchema,
    variable: ConditionalFieldIdSchema.optional(),
    time_scope: GuardTimeScopeSchema.optional()
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
    facet_mode: FacetModeSchema.default("same_path"),
    threshold_milligrades: MilligradeSchema.default(0)
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
      readonly count: number;
      readonly body: QueryProgram;
    }
  | {
      readonly schema_version: 1;
      readonly kind: "closure";
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
        count: z.number().int().min(1).max(8),
        body: QueryProgramSchema
      })
      .strict()
      .readonly(),
    z
      .object({
        schema_version: SchemaVersionSchema,
        kind: z.literal("closure"),
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

export const QueryInterpretationSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    query_id: ConditionalFieldIdSchema,
    program: QueryProgramSchema,
    view: QueryViewSchema,
    holes: z.array(QueryHoleSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly(),
    hypotheses: z.array(QueryHypothesisSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly(),
    interpretation_clock: IsoDatetimeStringSchema.optional()
  })
  .strict()
  .readonly();

export type GuardVerdict = z.infer<typeof GuardVerdictSchema>;
export type GuardTimeScope = z.infer<typeof GuardTimeScopeSchema>;
export type Guard = z.infer<typeof GuardSchema>;
export type QueryView = z.infer<typeof QueryViewSchema>;
export type QueryHole = z.infer<typeof QueryHoleSchema>;
export type QueryBinding = z.infer<typeof QueryBindingSchema>;
export type QueryHypothesis = z.infer<typeof QueryHypothesisSchema>;
export type RequestBudget = z.infer<typeof RequestBudgetSchema>;
export type QueryInterpretation = z.infer<typeof QueryInterpretationSchema>;
