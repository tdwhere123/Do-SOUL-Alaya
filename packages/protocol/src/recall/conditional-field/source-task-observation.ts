import { z } from "zod";
import { IsoDatetimeStringSchema } from "../../shared/schema-primitives.js";
import { SourceEvidenceTargetSchema } from "./product-identity.js";
import { QuestionTimeIntervalSchema, QuestionTimePreferenceSchema } from "./question-time.js";

/** Opt-in source-local hypotheses, not complete Q/H/C or admitted world claims. */
export const SOURCE_TASK_OBSERVATION_PRODUCER_ID = "alaya.query.source-task-observation.v1";

const LiteralSpan = z.object({
  start_byte: z.number().int().nonnegative(), end_byte: z.number().int().positive(),
  text: z.string().min(1).max(1024)
}).strict().refine(value => value.end_byte - value.start_byte === new TextEncoder().encode(value.text).length).readonly();

const SourceTaskObservationSchema = z.object({
  source: SourceEvidenceTargetSchema.refine(value => value.root_kind === "source_record" && value.span === undefined),
  source_observed_at: IsoDatetimeStringSchema.nullable(),
  source_excerpt: LiteralSpan,
  query_excerpt: LiteralSpan,
  utterance: z.object({
    kind: z.enum(["reported_event", "request", "recommendation", "standing", "prospective", "unknown"]),
    description: z.string().min(1).max(512)
  }).strict().readonly(),
  task_correspondence: z.discriminatedUnion("status", [
    z.object({ status: z.literal("possible"), role: z.enum(["requested_event", "task_input"]),
      component: z.string().min(1).max(256) }).strict().readonly(),
    z.object({ status: z.literal("unsupported") }).strict().readonly(),
    z.object({ status: z.literal("unresolved") }).strict().readonly()
  ]),
  event_time: z.discriminatedUnion("status", [
    z.object({ status: z.literal("unavailable") }).strict().readonly(),
    z.object({ status: z.literal("interpreted"), expression: z.string().min(1).max(256),
      anchor: z.enum(["source_observation_clock", "explicit_date"]), interval: QuestionTimeIntervalSchema }).strict().readonly()
  ])
}).strict().superRefine((value, context) => {
  if (value.event_time.status === "interpreted" && (value.source_excerpt.text.indexOf(value.event_time.expression) < 0 ||
    value.source_excerpt.text.indexOf(value.event_time.expression) !== value.source_excerpt.text.lastIndexOf(value.event_time.expression) ||
    value.event_time.anchor === "source_observation_clock" && value.source_observed_at === null)) {
    context.addIssue({ code: "custom", message: "event time needs a unique exact source expression and its declared clock" });
  }
}).readonly();
export type SourceTaskObservation = z.infer<typeof SourceTaskObservationSchema>;

/** Partial does not assert that unmentioned sources lack task evidence. */
export const SourceTaskObservationProposalSchema = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["ready", "partial"]), interpretation_clock: IsoDatetimeStringSchema,
    observations: z.array(SourceTaskObservationSchema).max(16).readonly() }).strict().readonly(),
  z.object({ status: z.enum(["failed", "unavailable"]), reason: z.string().min(1).max(256) }).strict().readonly()
]);
export type SourceTaskObservationProposal = z.infer<typeof SourceTaskObservationProposalSchema>;

/** Immutable input selected by the caller; actual scope/currentness are rechecked in Recall. */
export const SourceTaskObservationFormationInputSchema = z.object({
  query: z.string().min(1).max(4096), interpretation_clock: IsoDatetimeStringSchema,
  question_time: QuestionTimePreferenceSchema,
  sources: z.array(z.object({
    source_ref: z.string().min(1).max(32),
    target: SourceEvidenceTargetSchema.refine(value => value.root_kind === "source_record" && value.span === undefined),
    source_observed_at: IsoDatetimeStringSchema.nullable(),
    body: z.string().refine(value => new TextEncoder().encode(value).length <= 16_384)
  }).strict().readonly()).min(1).max(16).readonly()
}).strict().readonly();
export type SourceTaskObservationFormationInput = z.infer<typeof SourceTaskObservationFormationInputSchema>;

/** Wire-only formation draft. The host, not the producer, supplies source identities and byte coordinates. */
export const SourceTaskObservationDraftSchema = z.object({
  status: z.enum(["ready", "partial", "unavailable"]),
  observations: z.array(z.object({
    source_ref: z.string().min(1).max(32), source_excerpt: z.string().min(1).max(1024),
    query_excerpt: z.string().min(1).max(1024),
    utterance_kind: z.enum(["reported_event", "request", "recommendation", "standing", "prospective", "unknown"]),
    description: z.string().min(1).max(512), task_correspondence: z.enum(["possible", "unsupported", "unresolved"]),
    task_role: z.enum(["requested_event", "task_input"]).nullable(), task_component: z.string().max(256).nullable(),
    time_status: z.enum(["interpreted", "unavailable"]), time_expression: z.string().max(256).nullable(),
    time_anchor: z.enum(["source_observation_clock", "explicit_date"]).nullable(),
    time_start: z.string().nullable(), time_end: z.string().nullable()
  }).strict()).max(16).readonly()
}).strict().readonly();
/** The relation compares hypotheses only; overlap never establishes event identity. */
export const QualifiedTaskObservationSchema = z.object({
  semantic_status: z.literal("unreviewed"), world_claim: z.literal("unknown"),
  observation: SourceTaskObservationSchema,
  question_time: QuestionTimePreferenceSchema,
  temporal_relation: z.enum(["hypothesized_overlap", "hypothesized_disjoint", "unavailable"])
}).strict().readonly();
export type QualifiedTaskObservation = z.infer<typeof QualifiedTaskObservationSchema>;
