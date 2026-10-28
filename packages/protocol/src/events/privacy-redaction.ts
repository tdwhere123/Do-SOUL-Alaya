import { z } from "zod";
import { BoundedIdSchema } from "../shared/schema-primitives.js";

/** The event envelope remains historical; only the indicated source-derived payload is unavailable. */
export const SourceEraseRedactionSchema = z.object({
  kind: z.literal("source_erase"),
  barrier_id: BoundedIdSchema
}).strict().readonly();

export type SourceEraseRedaction = z.infer<typeof SourceEraseRedactionSchema>;
