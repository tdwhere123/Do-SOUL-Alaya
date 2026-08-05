import {
  QUERY_FACT_FRAME_EXTRACTION_CAPTURE_OPERATOR_ID,
  QUERY_ENTITY_EXTRACTION_CAPTURE_OPERATOR_ID,
  RECALL_FIELD_PREFIX_ORDERING_OPERATOR_ID,
  RECALL_FIELD_SCORE_CALIBRATION_OPERATOR_ID,
  RECALL_FIELD_SELECTOR_EXCHANGE_BOUND_OPERATOR_ID,
  RECALL_FINITE_FIELD_CHANNEL_CAPTURE_OPERATOR_ID,
  RECALL_RELEVANCE_UPPER_BOUND_OPERATOR_ID,
  RECALL_RETRIEVAL_FIELD_CHANNEL_CATALOG_V1,
  RECALL_RETRIEVAL_FIELD_REFINEMENT_OPERATOR_ID
} from "@do-soul/alaya-core";
import { z } from "zod";

const RecallFieldDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

const RecallFiniteFieldObservationSchema = z.object({
  observation_id: z.string().min(1),
  candidate_key: z.string().min(1),
  rank: z.number().int().positive()
}).strict().readonly();

const RecallFiniteFieldChannelSchema = z.object({
  channel_id: z.enum(RECALL_RETRIEVAL_FIELD_CHANNEL_CATALOG_V1),
  status: z.enum(["complete", "truncated", "unavailable", "ineligible"]),
  depth: z.number().int().nonnegative(),
  observations: z.array(RecallFiniteFieldObservationSchema).readonly(),
  unseen_upper_bound: z.number().int().nonnegative().nullable()
}).strict().readonly();

export const RecallFiniteFieldChannelCaptureSchema = z.object({
  schema_version: z.literal(1),
  operator_id: z.literal(RECALL_FINITE_FIELD_CHANNEL_CAPTURE_OPERATOR_ID),
  source_snapshot_digest: RecallFieldDigestSchema,
  channel: RecallFiniteFieldChannelSchema,
  capture_digest: RecallFieldDigestSchema
}).strict().readonly();

const RecallFieldScoreRecalibrationSchema = z.object({
  observation_id: z.string().min(1),
  from: z.number().min(0).max(1),
  to: z.number().min(0).max(1)
}).strict().readonly();

const RecallFieldRefinementLevelReceiptSchema = z.object({
  requested_depth: z.number().int().positive(),
  status: z.enum(["complete", "truncated", "unavailable", "ineligible"]),
  observed_depth: z.number().int().nonnegative(),
  new_observation_ids: z.array(z.string().min(1)).readonly(),
  score_recalibrations: z.array(RecallFieldScoreRecalibrationSchema).readonly(),
  unseen_upper_bound: z.number().min(0).max(1).nullable()
}).strict().readonly();

const RecallFieldLaneRefinementReceiptSchema = z.object({
  lane: z.enum(["exact", "porter", "trigram"]),
  levels: z.array(RecallFieldRefinementLevelReceiptSchema).min(1).readonly()
}).strict().readonly();

export const RecallRetrievalFieldRefinementReceiptSchema = z.object({
  schema_version: z.literal(1),
  operator_id: z.literal(RECALL_RETRIEVAL_FIELD_REFINEMENT_OPERATOR_ID),
  activation_mode: z.literal("shadow"),
  ordering_operator_id: z.literal(RECALL_FIELD_PREFIX_ORDERING_OPERATOR_ID),
  score_calibration_operator_id:
    z.literal(RECALL_FIELD_SCORE_CALIBRATION_OPERATOR_ID),
  request_digest: RecallFieldDigestSchema,
  source_snapshot_digest: RecallFieldDigestSchema,
  requested_depths: z.array(z.number().int().positive()).min(1).readonly(),
  lanes: z.array(RecallFieldLaneRefinementReceiptSchema).length(3).readonly(),
  stop_reason: z.enum([
    "all_channels_closed",
    "observation_budget_exhausted",
    "source_unavailable"
  ]),
  candidate_membership_changed: z.literal(false),
  receipt_digest: RecallFieldDigestSchema
}).strict().readonly();

const RecallCoverageSelectionObjectiveReceiptSchema = z.object({
  schema_version: z.literal(1),
  operator_id: z.string().min(1),
  mathematical_class: z.literal("monotone_submodular").nullable(),
  configuration_digest: RecallFieldDigestSchema.nullable()
}).strict().readonly();

const RecallRelevanceUpperBoundReceiptSchema = z.object({
  schema_version: z.literal(1),
  operator_id: z.literal(RECALL_RELEVANCE_UPPER_BOUND_OPERATOR_ID),
  score_operator_id: z.string().min(1),
  lower_bound: z.literal(0),
  upper_bound: z.literal(1),
  receipt_digest: RecallFieldDigestSchema
}).strict().readonly();

const RecallFieldExchangeBoundSchema = z.object({
  removed_candidate_key: z.string().min(1).nullable(),
  incumbent_loss: z.number().nonnegative(),
  unseen_gain_upper_bound: z.number().nonnegative(),
  improvement_upper_bound: z.number()
}).strict().readonly();

export const RecallFieldRefinementStopCertificateSchema = z.object({
  schema_version: z.literal(1),
  operator_id: z.literal(RECALL_FIELD_SELECTOR_EXCHANGE_BOUND_OPERATOR_ID),
  activation_mode: z.literal("shadow"),
  field_seal_digest: RecallFieldDigestSchema,
  refinement_receipt_digests: z.array(RecallFieldDigestSchema).readonly(),
  objective: RecallCoverageSelectionObjectiveReceiptSchema,
  relevance_upper_bound: RecallRelevanceUpperBoundReceiptSchema.nullable(),
  selected_candidate_keys: z.array(z.string().min(1)).max(5).readonly(),
  exchange_bounds: z.array(RecallFieldExchangeBoundSchema).max(5).readonly(),
  maximum_exchange_improvement_upper_bound: z.number().nullable(),
  status: z.enum(["certified", "uncertified"]),
  reason: z.enum([
    "all_channels_closed",
    "source_unavailable",
    "relevance_bound_unavailable",
    "objective_bound_unavailable",
    "exchange_dominated",
    "exchange_not_dominated"
  ]),
  candidate_membership_changed: z.literal(false),
  receipt_digest: RecallFieldDigestSchema
}).strict().readonly();

const RecallEntityCandidateSchema = z.object({
  surface: z.string().min(1),
  normalized: z.string().min(1),
  kind: z.enum([
    "quoted",
    "proper_noun",
    "code_ref",
    "path",
    "package",
    "task_ref",
    "cjk_phrase",
    "unknown"
  ]),
  confidence: z.number().min(0).max(1),
  source_offset: z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative()
  ]).readonly().optional()
}).strict().readonly();

export const RecallQueryEntityExtractionCaptureSchema = z.object({
  schema_version: z.literal(1),
  operator_id: z.literal(QUERY_ENTITY_EXTRACTION_CAPTURE_OPERATOR_ID),
  status: z.enum(["returned", "ineligible", "unavailable"]),
  query_text_digest: RecallFieldDigestSchema,
  producer_operator_id: z.string().min(1).nullable(),
  candidates: z.array(RecallEntityCandidateSchema).readonly(),
  capture_digest: RecallFieldDigestSchema
}).strict().superRefine((capture, context) => {
  if ((capture.status === "returned") !== (capture.producer_operator_id !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "producer identity must match status" });
  }
}).readonly();

const RecallQueryFactFrameSlotCaptureSchema = z.object({
  role: z.enum(["subject", "relation", "value", "qualifier", "time"]),
  text: z.string().min(1).max(512),
  source_offset: z.tuple([
    z.number().int().nonnegative(),
    z.number().int().positive()
  ]).readonly()
}).strict().readonly();

const RecallQueryFactFrameCaptureFrameSchema = z.object({
  schema_version: z.literal(1),
  slots: z.array(RecallQueryFactFrameSlotCaptureSchema).min(3).max(6).readonly()
}).strict().readonly();

export const RecallQueryFactFrameExtractionCaptureSchema = z.object({
  schema_version: z.literal(1),
  operator_id: z.literal(QUERY_FACT_FRAME_EXTRACTION_CAPTURE_OPERATOR_ID),
  status: z.enum(["returned", "ineligible", "unavailable"]),
  query_text_digest: RecallFieldDigestSchema,
  producer_operator_id: z.string().min(1).nullable(),
  frames: z.array(RecallQueryFactFrameCaptureFrameSchema).max(8).readonly(),
  capture_digest: RecallFieldDigestSchema
}).strict().superRefine((capture, context) => {
  if ((capture.status === "returned") !== (capture.producer_operator_id !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "producer identity must match status" });
  }
}).readonly();
