import { z } from "zod";
import {
  BOUNDED_EVIDENCE_ARRAY_MAX,
  BoundedIdSchema,
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

// This is the full immutable assertion material carried by the admission
// EventLog payload. Evidence remains the authority for source observation/event
// time; admitted_at records the EventLog-governed transaction, never a
// substitute source time.
const RelationAssertionAdmissionFieldsSchema = z
  .object({
    assertion_id: BoundedIdSchema,
    workspace_id: BoundedIdSchema,
    evidence_ids: z.array(BoundedIdSchema).min(1).max(BOUNDED_EVIDENCE_ARRAY_MAX).readonly(),
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

export const RelationAssertionAdmissionSchema = RelationAssertionAdmissionFieldsSchema.readonly();

export const RelationAssertionSchema = RelationAssertionAdmissionFieldsSchema.extend({
  admission_event_id: BoundedIdSchema
})
  .strict()
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
