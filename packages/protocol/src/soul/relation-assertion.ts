import { z } from "zod";
import {
  BOUNDED_EVIDENCE_ARRAY_MAX,
  BoundedIdSchema,
  BoundedJsonObjectSchema,
  BoundedLabelSchema,
  BoundedReasonSchema,
  IsoDatetimeStringSchema
} from "../shared/schema-primitives.js";
import { PathAnchorRefSchema } from "./path-relation.js";

const relationAssertionResolutionValues = [
  "contradicted",
  "retracted",
  "expired",
  "superseded",
  "governance_retired"
] as const;

const BoundedRelationValiditySchema = z
  .object({
    kind: z.literal("bounded"),
    valid_from: IsoDatetimeStringSchema,
    valid_to: IsoDatetimeStringSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.valid_from) >= Date.parse(value.valid_to)) {
      context.addIssue({
        code: "custom",
        path: ["valid_to"],
        message: "bounded relation validity requires valid_from before valid_to"
      });
    }
  });

const OpenRelationValiditySchema = z
  .object({
    kind: z.literal("open"),
    valid_from: IsoDatetimeStringSchema
  })
  .strict();

const TimelessRelationValiditySchema = z
  .object({
    kind: z.literal("timeless"),
    governance_policy_id: BoundedIdSchema
  })
  .strict();

export const RelationValiditySchema = z
  .discriminatedUnion("kind", [
    BoundedRelationValiditySchema,
    OpenRelationValiditySchema,
    TimelessRelationValiditySchema
  ])
  .readonly();

export const RelationAssertionResolutionKind = {
  CONTRADICTED: "contradicted",
  RETRACTED: "retracted",
  EXPIRED: "expired",
  SUPERSEDED: "superseded",
  GOVERNANCE_RETIRED: "governance_retired"
} as const;

export const RelationAssertionResolutionKindSchema = z.enum(relationAssertionResolutionValues);

export const RelationAssertionSourceEventAnchorSchema = z
  .object({
    event_type: BoundedLabelSchema,
    event_id: BoundedIdSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const RelationAssertionEvidenceReceiptSchema = z
  .object({
    evidence_id: BoundedIdSchema,
    source_event_anchor: RelationAssertionSourceEventAnchorSchema
  })
  .strict()
  .readonly();

const Sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

// On-disk temporal bootstrap identity is SHA-256 of empty bytes, not a structured empty hash.
export const EMPTY_RELATION_HISTORY_DIGEST =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const RelationFormationSourceKind = {
  EVENT_LOG_ENTRY: "event_log_entry",
  MEMORY_HQ_OBSERVATION: "memory_hq_observation"
} as const;

export const RelationFormationSourceKindSchema = z.enum([
  RelationFormationSourceKind.EVENT_LOG_ENTRY,
  RelationFormationSourceKind.MEMORY_HQ_OBSERVATION
]);

export const RelationFormationSourceObservationSchema = z
  .object({
    source_kind: RelationFormationSourceKindSchema,
    source_id: BoundedIdSchema,
    source_sha256: Sha256DigestSchema
  })
  .strict()
  .readonly();

export const RelationFormationReceiptSchema = z
  .object({
    operator_id: BoundedIdSchema,
    operator_sha256: Sha256DigestSchema,
    parameters: BoundedJsonObjectSchema,
    parameter_sha256: Sha256DigestSchema,
    source_observations: z
      .array(RelationFormationSourceObservationSchema)
      .min(1)
      .max(BOUNDED_EVIDENCE_ARRAY_MAX)
      .readonly(),
    decision: BoundedJsonObjectSchema,
    decision_sha256: Sha256DigestSchema
  })
  .strict()
  .superRefine((value, context) => {
    const identities = value.source_observations.map(
      (source) => `${source.source_kind}\u0000${source.source_id}`
    );
    if (new Set(identities).size !== identities.length) {
      context.addIssue({
        code: "custom",
        path: ["source_observations"],
        message: "relation formation source observations must be unique"
      });
    }
  })
  .readonly();

// This is the full immutable assertion material carried by the admission
// EventLog payload. Evidence remains the authority for source observation/event
// time; admitted_at records the EventLog-governed transaction, never a
// substitute source time.
const RelationAssertionAdmissionFieldsSchema = z
  .object({
    assertion_id: BoundedIdSchema,
    workspace_id: BoundedIdSchema,
    evidence_receipts: z
      .array(RelationAssertionEvidenceReceiptSchema)
      .min(1)
      .max(BOUNDED_EVIDENCE_ARRAY_MAX)
      .readonly(),
    formation_receipt: RelationFormationReceiptSchema,
    anchors: z
      .object({
        source_anchor: PathAnchorRefSchema,
        target_anchor: PathAnchorRefSchema
      })
      .strict()
      .readonly(),
    relation_kind: BoundedLabelSchema,
    validity: RelationValiditySchema,
    admitted_at: IsoDatetimeStringSchema
  })
  .strict();

function requireUniqueEvidenceReceipts(
  value: { readonly evidence_receipts: readonly { readonly evidence_id: string }[] },
  context: z.RefinementCtx
): void {
  const evidenceIds = value.evidence_receipts.map((receipt) => receipt.evidence_id);
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    context.addIssue({
      code: "custom",
      path: ["evidence_receipts"],
      message: "relation assertion evidence receipts must have unique evidence ids"
    });
  }
}

export const RelationAssertionAdmissionSchema = RelationAssertionAdmissionFieldsSchema
  .superRefine(requireUniqueEvidenceReceipts)
  .readonly();

export const RelationAssertionSchema = RelationAssertionAdmissionFieldsSchema
  .extend({ admission_event_id: BoundedIdSchema })
  .strict()
  .superRefine(requireUniqueEvidenceReceipts)
  .readonly();

export const RelationAssertionResolutionSchema = z
  .object({
    resolution_id: BoundedIdSchema,
    assertion_id: BoundedIdSchema,
    workspace_id: BoundedIdSchema,
    event_id: BoundedIdSchema,
    resolution_kind: RelationAssertionResolutionKindSchema,
    resolved_at: IsoDatetimeStringSchema,
    reason: BoundedReasonSchema
  })
  .strict()
  .readonly();

export type RelationValidity = z.infer<typeof RelationValiditySchema>;
export type RelationAssertion = z.infer<typeof RelationAssertionSchema>;
export type RelationAssertionResolution = z.infer<typeof RelationAssertionResolutionSchema>;
export type RelationAssertionEvidenceReceipt = z.infer<typeof RelationAssertionEvidenceReceiptSchema>;
export type RelationAssertionSourceEventAnchor = z.infer<typeof RelationAssertionSourceEventAnchorSchema>;
export type RelationFormationReceipt = z.infer<typeof RelationFormationReceiptSchema>;
export type RelationFormationSourceKind = z.infer<typeof RelationFormationSourceKindSchema>;
export type RelationFormationSourceObservation = z.infer<typeof RelationFormationSourceObservationSchema>;
export type RelationAssertionResolutionKind = z.infer<typeof RelationAssertionResolutionKindSchema>;

export function isRelationValidityActiveAt(
  validity: RelationValidity,
  asOf: string,
  permittedTimelessPolicyIds: ReadonlySet<string>
): boolean {
  const instant = Date.parse(IsoDatetimeStringSchema.parse(asOf));
  switch (validity.kind) {
    case "bounded":
      return instant >= Date.parse(validity.valid_from) && instant < Date.parse(validity.valid_to);
    case "open":
      return instant >= Date.parse(validity.valid_from);
    case "timeless":
      return permittedTimelessPolicyIds.has(validity.governance_policy_id);
  }
}
