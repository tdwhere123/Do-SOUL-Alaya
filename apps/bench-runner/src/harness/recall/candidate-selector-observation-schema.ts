import { PathAnchorRefSchema } from "@do-soul/alaya-protocol";
import { z } from "zod";

const RecallSelectorPathReceiptSchema = z
  .object({
    receipt_status: z.enum(["complete", "partial"]),
    path_id: z.string().min(1).nullable(),
    relation_kind: z.string().min(1).nullable(),
    source_object_id: z.string().min(1).nullable(),
    target_object_id: z.string().min(1).nullable(),
    source_anchor: PathAnchorRefSchema.nullable(),
    target_anchor: PathAnchorRefSchema.nullable(),
    source_version: z.string().min(1).nullable(),
    edge_conductance: z.number().finite().nullable()
  })
  .strict()
  .readonly();

export const RecallCandidateSelectorObservationSchema = z
  .object({
    schema_version: z.literal(1),
    evidence: z.object({
      directness: z.enum(["direct_document", "referenced", "none", "unresolved"]),
      authority: z.enum([
        "verified_user_assertion",
        "verified_user_projection",
        "unverified",
        "none"
      ]),
      validity: z.enum([
        "behavior_eligible",
        "recall_qualified",
        "observed_reference",
        "unresolved",
        "none"
      ]),
      document_identity: z.string().min(1).nullable(),
      evidence_refs: z.array(z.string().min(1)).readonly(),
      event_status: z.enum([
        "asserted",
        "prospective",
        "negated",
        "reversed",
        "unknown",
        "not_observed"
      ]),
      preference_polarity: z.enum(["positive", "negative", "neutral"]).nullable()
    }).strict().readonly(),
    temporal: z.object({
      compatibility: z.enum([
        "not_requested",
        "compatible",
        "conflicted",
        "unknown",
        "not_observed"
      ]),
      event_time_start: z.string().nullable(),
      event_time_end: z.string().nullable(),
      valid_from: z.string().nullable(),
      valid_to: z.string().nullable(),
      time_precision: z.enum(["day", "month", "year", "range", "relative", "unknown"])
        .nullable(),
      time_source: z.enum(["explicit", "session_timestamp", "relative_resolved"])
        .nullable()
    }).strict().readonly(),
    coverage: z.object({
      marginal_gain: z.number().min(0).max(1).nullable()
    }).strict().readonly(),
    path: z.object({
      status: z.enum(["not_observed", "unavailable", "none", "partial", "complete"]),
      receipts: z.array(RecallSelectorPathReceiptSchema).readonly()
    }).strict().readonly()
  })
  .strict()
  .readonly();
