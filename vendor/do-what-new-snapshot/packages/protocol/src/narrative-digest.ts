import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "./schema-primitives.js";

const NarrativeDigestBoundToNodeSchema = z
  .object({
    node_id: NonEmptyStringSchema
  })
  .strict()
  .readonly();

const NarrativeDigestBoundToRunSchema = z
  .object({
    run_id: NonEmptyStringSchema
  })
  .strict()
  .readonly();

export const NarrativeDigestSchema = z
  .object({
    digest_id: NonEmptyStringSchema,
    derived_from_workers: z.array(NonEmptyStringSchema).readonly(),
    source_trust_tags: z.array(NonEmptyStringSchema).readonly(),
    bound_to: z.union([NarrativeDigestBoundToNodeSchema, NarrativeDigestBoundToRunSchema]),
    created_at: IsoDatetimeStringSchema,
    expires_at: IsoDatetimeStringSchema,
    retention_after_expiry: z.literal("audit_only")
  })
  .strict()
  .readonly();

export type NarrativeDigest = Readonly<z.infer<typeof NarrativeDigestSchema>>;
