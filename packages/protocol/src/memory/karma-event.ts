import { z } from "zod";
import { BoundedIdSchema, IsoDatetimeStringSchema } from "../shared/schema-primitives.js";

const karmaEventKindValues = [
  "accept_gain",
  "reject_penalty",
  "reuse_gain",
  "evidence_gain",
  "supersede_penalty"
] as const;

export const KarmaEventKind = {
  ACCEPT_GAIN: "accept_gain",
  REJECT_PENALTY: "reject_penalty",
  REUSE_GAIN: "reuse_gain",
  EVIDENCE_GAIN: "evidence_gain",
  SUPERSEDE_PENALTY: "supersede_penalty"
} as const;

export const KarmaEventKindSchema = z.enum(karmaEventKindValues);

export const KarmaEventSchema = z
  .object({
    event_id: BoundedIdSchema,
    kind: KarmaEventKindSchema,
    object_id: BoundedIdSchema,
    amount: z.number().finite(),
    created_at: IsoDatetimeStringSchema,
    workspace_id: BoundedIdSchema,
    // Nullable run attribution: many karma events fire with no run
    // context (health-scan decay, evidence promotion). A run id is
    // recorded only when the emitting producer holds one.
    run_id: BoundedIdSchema.nullable().optional()
  })
  .strict()
  .readonly();

export type KarmaEventKind = z.infer<typeof KarmaEventKindSchema>;
export type KarmaEvent = z.infer<typeof KarmaEventSchema>;

export function parseKarmaEvent(value: unknown): KarmaEvent {
  return KarmaEventSchema.parse(value);
}
