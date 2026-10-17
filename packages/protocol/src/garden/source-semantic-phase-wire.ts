import { z } from "zod";
import { NonNegativeIntSchema as N } from "../shared/schema-primitives.js";
import { Sha256DigestSchema } from "../recall/conditional-field/common.js";
import { SourceIndexProfileSchema, SourceIndexTargetSchema } from "../recall/source-index.js";
import { SourceSemanticQueryWindowSchema, SourceSemanticVectorBindingSchema } from "./source-semantic-phase-semantics.js";

// Codes are stable across phase envelope versions; v2 binds original-first routes.
export const PHASE_CODES = {
  preparation: ["ready", "unavailable", "failed", "not_requested"],
  method: ["not_run", "local_inference", "external_api"],
  work: ["not_run", "unknown"],
  acquisition: ["executed", "not_run", "failed"],
  accounting: ["complete", "partial", "not_run"],
  completion: ["complete", "partial", "unavailable", "not_run"],
  lane: ["unicode61", "trigram"],
  stage: ["input", "lexical", "vector", "admission", "nomination"],
  cjk: ["uninitialized", "loading", "ready", "unavailable"],
  vector: ["ready", "partial", "valid_empty", "unknown", "unbound", "unavailable"],
  validation: ["not_run", "validated", "invalid", "not_applicable"],
  limitation: ["nominations_are_not_source_absence", "sqlite_internal_work_unknown",
    "native_deadline_and_interruption_require_daemon_integration", "caller_owned_read_snapshot_required",
    "lexical_corpus_coverage_untracked", "database_wide_bm25_statistics",
    "short_or_unadmitted_tokens_are_not_absence", "short_cjk_unicode61_exact_tokens_only"]
} as const;
const C2 = z.literal([0, 1]), C3 = z.literal([0, 1, 2]), C4 = z.literal([0, 1, 2, 3]);
const Ref = N, NullableRef = Ref.nullable(), Strings = z.array(z.string()).readonly();
const Selected = z.tuple([N, Ref, Ref, SourceIndexProfileSchema]).readonly().nullable();
// Short form elides only exactly canonical not-run work; its four visible values remain explicit.
const PreparationBody = z.union([
  z.tuple([z.literal(0), C4, NullableRef, NullableRef, z.number().nonnegative().nullable()]).readonly(),
  z.tuple([z.literal(1), C4, NullableRef, NullableRef, Selected, C3, N, N.nullable(), N.nullable(),
    C2, C2, z.number().nonnegative().nullable()]).readonly()
]);
const Counters = z.union([z.literal(0), z.tuple([N, N, N, N, N, N, N, N, N]).readonly()]);
const Resources = z.tuple([N, N, N]).readonly();
// Known codes are scalars; every unknown string is an escaped local reference, even "0" or "1".
const Limitation = z.union([z.literal([0, 1, 2, 3, 4, 5, 6, 7]), z.tuple([Ref]).readonly()]);
const Limitations = z.array(Limitation).readonly();
const Tokenization = z.tuple([Ref, C4, z.array(Ref).readonly(), z.array(Ref).readonly(), z.array(Ref).readonly()]).readonly().nullable();
const VectorState = z.union([
  z.tuple([C3, SourceSemanticVectorBindingSchema]).readonly(),
  z.tuple([z.literal([3, 4, 5]), Ref]).readonly()
]).nullable();
const VectorInput = z.union([
  z.tuple([z.literal(0), Ref, Ref]).readonly(), z.tuple([z.literal(1), Ref]).readonly()
]);
const Nomination = z.tuple([SourceIndexTargetSchema,
  z.array(z.tuple([N, C2, N, z.number().finite()]).readonly()).readonly(),
  z.tuple([N, z.number().finite(), SourceSemanticQueryWindowSchema]).readonly().nullable()
]).readonly();
const ResultShape = z.tuple([
  NullableRef, C4, z.array(Nomination).max(16).readonly(), Counters, Resources,
  z.array(z.tuple([z.literal([0, 1, 2, 3, 4]), Ref]).readonly()).readonly(),
  z.tuple([C4, NullableRef, Limitations, Tokenization]).readonly(),
  z.tuple([C4, VectorState, NullableRef, N, N, C4, VectorInput]).readonly(), Limitations
]).readonly();
export type CompactAcquisitionResult = z.output<typeof ResultShape>;
export type CompactAcquisitionResultInput = z.input<typeof ResultShape>;
// Keep concrete Zod implementation depth behind checked schema boundaries in downstream declarations.
const Result: z.ZodType<CompactAcquisitionResult, CompactAcquisitionResultInput> = ResultShape;
const AcquisitionBody = z.tuple([C3, NullableRef, z.tuple([N, N, N]).readonly(),
  z.tuple([N, N]).readonly(), Result.nullable(), C3]).readonly();

type References = Readonly<{ table: readonly string[]; ctx: z.RefinementCtx }>;
function reference(owner: References, index: number | null, digest = false): void {
  if (index === null) return;
  if (index >= owner.table.length || digest && !Sha256DigestSchema.safeParse(owner.table[index]).success) {
    owner.ctx.addIssue({ code: "custom", message: digest ? "invalid local digest reference" : "local reference out of bounds" });
  }
}
function limitations(owner: References, values: readonly z.infer<typeof Limitation>[]): void {
  for (const value of values) if (Array.isArray(value)) reference(owner, value[0]!);
}

/** Admission checks compact slots directly. It must not construct an expanded semantic phase. */
const SinglePreparation = z.tuple([z.literal(1), Strings, PreparationBody]).readonly();
const CompactPreparationShape = z.tuple([z.literal(1), Strings, PreparationBody,
  z.tuple([SinglePreparation]).readonly().optional()]).readonly()
  .superRefine(([version, table, body, supplemental], ctx) => {
    checkPreparationReferences([version, table, body], ctx);
    for (const route of supplemental ?? []) checkPreparationReferences(route, ctx);
  });
function checkPreparationReferences([, table, body]: z.infer<typeof SinglePreparation>, ctx: z.RefinementCtx): void {
    const owner = { table, ctx };
    reference(owner, body[2]); reference(owner, body[3], true);
    if (body[0] === 1 && body[4] !== null) {
      reference(owner, body[4][1], true); reference(owner, body[4][2], true);
    }
}
export type SourceSemanticCompactPreparation = z.output<typeof CompactPreparationShape>;
export type SourceSemanticCompactPreparationInput = z.input<typeof CompactPreparationShape>;
export const SourceSemanticCompactPreparationSchema:
  z.ZodType<SourceSemanticCompactPreparation, SourceSemanticCompactPreparationInput> = CompactPreparationShape;
const SingleAcquisition = z.tuple([z.literal(1), Strings, AcquisitionBody]).readonly();
const CompactAcquisitionShape = z.tuple([z.literal(1), Strings, AcquisitionBody,
  z.tuple([SingleAcquisition]).readonly().optional()]).readonly()
  .superRefine(([version, table, body, supplemental], ctx) => {
    checkAcquisitionReferences([version, table, body], ctx);
    for (const route of supplemental ?? []) checkAcquisitionReferences(route, ctx);
  });
function checkAcquisitionReferences([, table, body]: z.infer<typeof SingleAcquisition>, ctx: z.RefinementCtx): void {
    const owner = { table, ctx };
    reference(owner, body[1]);
    const result = body[4];
    if (result === null) return;
    reference(owner, result[0], true);
    for (const refusal of result[5]) reference(owner, refusal[1]);
    const lexical = result[6], vector = result[7], tokenization = lexical[3];
    reference(owner, lexical[1]); limitations(owner, lexical[2]);
    if (tokenization !== null) {
      reference(owner, tokenization[0], true);
      for (const terms of [tokenization[2], tokenization[3], tokenization[4]]) for (const term of terms) reference(owner, term);
    }
    const state = vector[1];
    if (state !== null && state[0] >= 3) reference(owner, state[1] as number);
    reference(owner, vector[2]);
    if (vector[6][0] === 0) {
      reference(owner, vector[6][1], true); reference(owner, vector[6][2], true);
    } else reference(owner, vector[6][1]);
    limitations(owner, result[8]);
}
export type SourceSemanticCompactAcquisition = z.output<typeof CompactAcquisitionShape>;
export type SourceSemanticCompactAcquisitionInput = z.input<typeof CompactAcquisitionShape>;
export const SourceSemanticCompactAcquisitionSchema:
  z.ZodType<SourceSemanticCompactAcquisition, SourceSemanticCompactAcquisitionInput> = CompactAcquisitionShape;
const AccessPhasesShape = z.tuple([z.literal(2), SourceSemanticCompactPreparationSchema,
  SourceSemanticCompactAcquisitionSchema, Resources.nullable()]).readonly();
export type SourceSemanticAccessPhases = z.output<typeof AccessPhasesShape>;
export type SourceSemanticAccessPhasesInput = z.input<typeof AccessPhasesShape>;
export const SourceSemanticAccessPhasesSchema:
  z.ZodType<SourceSemanticAccessPhases, SourceSemanticAccessPhasesInput> = AccessPhasesShape;
const ExecutionShape = z.union([z.literal("native_reasoning_only"),
  z.tuple([z.literal(2), SourceSemanticCompactPreparationSchema, SourceSemanticCompactAcquisitionSchema]).readonly()]);
export type SourceSemanticExecution = z.output<typeof ExecutionShape>;
export type SourceSemanticExecutionInput = z.input<typeof ExecutionShape>;
export const SourceSemanticExecutionSchema: z.ZodType<SourceSemanticExecution, SourceSemanticExecutionInput> = ExecutionShape;
export type CompactLimitation = z.infer<typeof Limitation>;
