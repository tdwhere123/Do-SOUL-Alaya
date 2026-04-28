import { z } from "zod";
import { RuntimeSessionConfigSchema } from "./runtime-port.js";
import {
  DelegatedWorkerReturnKindSchema,
  DelegatedWorkerRunSchema,
  EngineClassSchema
} from "./runtime-run.js";
import { NonNegativeIntSchema } from "./schema-primitives.js";
import { ToolCategorySchema } from "./tool-spec.js";

const TrimmedNonEmptyStringSchema = z.string().trim().min(1);

const NullableTrimmedNonEmptyStringInputSchema = z.preprocess(
  (value) => (value === undefined ? null : value),
  TrimmedNonEmptyStringSchema.nullable()
);

const TrimmedNonEmptyStringArraySchema = z.array(TrimmedNonEmptyStringSchema).readonly();

export const WorkerDispatchLocalBudgetSchema = z
  .object({
    max_worker_delegations: NonNegativeIntSchema,
    max_tool_calls: NonNegativeIntSchema,
    max_output_tokens: NonNegativeIntSchema,
    max_wall_time_ms: NonNegativeIntSchema
  })
  .strict()
  .readonly();

export const WorkerDispatchReturnFormatSchema = z
  .object({
    allowed_return_kinds: z.array(DelegatedWorkerReturnKindSchema).min(1).readonly(),
    requires_structured_summary: z.boolean()
  })
  .strict()
  .readonly();

export const WorkerDispatchPrincipalSecuritySnapshotSchema = z
  .object({
    governance_lease_ref: TrimmedNonEmptyStringSchema,
    hard_constraint_refs: TrimmedNonEmptyStringArraySchema,
    denied_tool_categories: z.array(ToolCategorySchema).readonly()
  })
  .strict()
  .readonly();

export const WorkerDispatchRequestSchema = z
  .object({
    engineClass: EngineClassSchema,
    subtaskDescription: TrimmedNonEmptyStringSchema,
    localSurfaceRef: TrimmedNonEmptyStringSchema,
    localEvidencePointer: NullableTrimmedNonEmptyStringInputSchema,
    restrictedToolSet: TrimmedNonEmptyStringArraySchema,
    localBudget: WorkerDispatchLocalBudgetSchema,
    agreedReturnFormat: WorkerDispatchReturnFormatSchema,
    principalSecuritySnapshot: WorkerDispatchPrincipalSecuritySnapshotSchema,
    sessionConfig: RuntimeSessionConfigSchema,
    prompt: TrimmedNonEmptyStringSchema
  })
  .strict()
  .readonly();

// Worker dispatch returns the durable delegated worker run shape; keep this
// alias aligned with DelegatedWorkerRunSchema instead of introducing a new wire shape.
export const WorkerDispatchResponseSchema = DelegatedWorkerRunSchema;

export type WorkerDispatchRequest = Readonly<z.infer<typeof WorkerDispatchRequestSchema>>;
export type WorkerDispatchResponse = Readonly<z.infer<typeof WorkerDispatchResponseSchema>>;
