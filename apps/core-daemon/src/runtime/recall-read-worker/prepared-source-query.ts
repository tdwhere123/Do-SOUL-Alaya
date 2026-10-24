import { z } from "zod";
import { SourceSemanticQueryPreparationSchema, SourceIndexProfileSchema } from "@do-soul/alaya-protocol";

/** Parent-owned preparation crosses IPC; public requests cannot supply this material. */
const PreparedRouteSchema = z.object({
  receipt: SourceSemanticQueryPreparationSchema.refine(value => value.supplemental === undefined,
    "private route preparation cannot nest supplemental routes"),
  vector: z.union([
    z.object({ status: z.literal("unavailable"), reason: z.string().min(1).max(256) }).strict(),
    z.object({ status: z.literal("available"), profile: SourceIndexProfileSchema, profile_id: z.string(),
      input_digest: z.string(), embedding: z.custom<Float32Array>(value => value instanceof Float32Array) }).strict()
  ])
}).strict();
export const PreparedQuerySchema = PreparedRouteSchema.extend({ supplemental: PreparedRouteSchema.optional() }).strict();
