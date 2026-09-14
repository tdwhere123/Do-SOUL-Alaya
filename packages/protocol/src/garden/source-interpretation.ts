import { z } from "zod";
import { BoundedIdSchema, BoundedLabelSchema, BoundedString,
  NonNegativeIntSchema, PREFERENCE_FACT_MAX_CHARS } from "../shared/schema-primitives.js";
import { SourceAssertionIdSchema, SourceOccurrenceSchema,
  SourceTextSpanSchema } from "../evidence/source-selection.js";
import { SourceEvidenceTargetSchema } from "../recall/conditional-field/product-identity.js";
import { Sha256HexSchema } from "../recall/conditional-field/common.js";

export const SOURCE_INTERPRETATION_CONTRACT = "source-interpretation-v1" as const;
const PhraseTextSchema = BoundedString(PREFERENCE_FACT_MAX_CHARS);
export const SourceInterpretationPhraseSchema = z.object({
  text: PhraseTextSchema,
  occurrence: SourceOccurrenceSchema.optional()
}).strict().readonly();
const RolePhraseSchema = z.object({
  role: BoundedLabelSchema,
  phrase: SourceInterpretationPhraseSchema
}).strict().readonly();
export const SourceInterpretationRelationSchema = z.object({
  predicate: SourceInterpretationPhraseSchema,
  arguments: z.array(RolePhraseSchema).max(8).readonly(),
  qualifiers: z.array(RolePhraseSchema).max(8).readonly()
}).strict().readonly();

function interpretationResponseSchema<T extends z.ZodType>(relationSchema: T) {
  return z.object({
    interpretations: z.array(z.object({
      assertion_id: SourceAssertionIdSchema,
      relations: z.array(relationSchema).max(32).readonly()
    }).strict().readonly()).max(64).readonly()
  }).strict().readonly();
}

export const SourceInterpretationResponseSchema = interpretationResponseSchema(SourceInterpretationRelationSchema);
// Parse the bounded envelope first, then validate each relation independently
// with the same wire schema so one malformed proposal cannot erase its siblings.
export const SourceInterpretationResponseEnvelopeSchema = interpretationResponseSchema(z.unknown());

const BoundPhraseSchema = z.object({
  text: PhraseTextSchema,
  source_span: SourceTextSpanSchema,
  lookup_key: PhraseTextSchema
}).strict().readonly();
const BoundRoleSchema = z.object({
  role: BoundedLabelSchema,
  phrase: BoundPhraseSchema
}).strict().readonly();
export const BoundSourceInterpretationCandidateSchema = z.object({
  candidate_id: BoundedIdSchema,
  context_id: BoundedIdSchema,
  predicate: BoundPhraseSchema,
  arguments: z.array(BoundRoleSchema).max(8).readonly(),
  qualifiers: z.array(BoundRoleSchema).max(8).readonly(),
  scope_status: z.enum(["preserved", "unsupported"])
}).strict().readonly();

// Bound means source-selected, not semantically certified. Core validates the
// target and exact source text before any durable observation or lookup publish.
const LocatedSourceInterpretationSchema = z.object({
  contract: z.literal(SOURCE_INTERPRETATION_CONTRACT),
  artifact_key: BoundedIdSchema,
  source_corpus_digest: Sha256HexSchema,
  assertion_binding: z.object({
    assertion_id: SourceAssertionIdSchema,
    source_span: SourceTextSpanSchema,
    text: PhraseTextSchema,
    context_id: BoundedIdSchema
  }).strict().readonly(),
  outcome: z.enum(["candidates", "empty", "failed"]),
  candidates: z.array(BoundSourceInterpretationCandidateSchema).max(32).readonly(),
  diagnostics: z.array(z.object({
    candidate_index: NonNegativeIntSchema.nullable(),
    reason: z.enum(["absent", "ambiguous", "out_of_range", "scope_rejected",
      "invalid_candidate", "malformed_response", "transport_unknown", "missing_response"])
  }).strict().readonly()).max(64).readonly()
}).strict().superRefine((value, ctx) => {
  if ((value.outcome === "candidates") !== (value.candidates.length > 0)) {
    ctx.addIssue({ code: "custom", message: "candidate outcome must agree with candidate presence" });
  }
  if (value.outcome === "failed" && value.diagnostics.length === 0) {
    ctx.addIssue({ code: "custom", message: "failed interpretation requires diagnostics" });
  }
  const ids = new Set<string>();
  for (const candidate of value.candidates) {
    if (ids.has(candidate.candidate_id) || candidate.context_id !== value.assertion_binding.context_id) {
      ctx.addIssue({ code: "custom", message: "candidates require unique IDs in the bound assertion context" });
    }
    ids.add(candidate.candidate_id);
  }
});

// Compilation can locate text before a persistent source root exists.
export const SourceLocatedInterpretationSchema = LocatedSourceInterpretationSchema.readonly();
// Only Core source admission attaches a persistent, verified target.
export const BoundSourceInterpretationSchema = LocatedSourceInterpretationSchema.safeExtend({
  source_target: SourceEvidenceTargetSchema
}).readonly();

export type SourceInterpretationResponse = z.infer<typeof SourceInterpretationResponseSchema>;
export type SourceLocatedInterpretation = z.infer<typeof SourceLocatedInterpretationSchema>;
export type BoundSourceInterpretation = z.infer<typeof BoundSourceInterpretationSchema>;
