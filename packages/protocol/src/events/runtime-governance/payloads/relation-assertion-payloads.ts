import { z } from "zod";
import {
  BoundedIdSchema,
  BoundedReasonSchema,
  IsoDatetimeStringSchema
} from "../../../shared/schema-primitives.js";
import {
  RelationAssertionAdmissionSchema,
  RelationAssertionResolutionKindSchema
} from "../../../soul/relation-assertion.js";

export const RelationAssertionAdmittedPayloadSchema = RelationAssertionAdmissionSchema;

export const RelationAssertionResolvedPayloadSchema = z
  .object({
    resolution_id: BoundedIdSchema,
    assertion_id: BoundedIdSchema,
    workspace_id: BoundedIdSchema,
    resolution_kind: RelationAssertionResolutionKindSchema,
    resolved_at: IsoDatetimeStringSchema,
    reason: BoundedReasonSchema
  })
  .strict()
  .readonly();
