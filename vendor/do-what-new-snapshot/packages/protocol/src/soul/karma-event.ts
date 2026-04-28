import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../schema-primitives.js";

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
    event_id: NonEmptyStringSchema,
    kind: KarmaEventKindSchema,
    object_id: NonEmptyStringSchema,
    amount: z.number().finite(),
    created_at: IsoDatetimeStringSchema,
    workspace_id: NonEmptyStringSchema
  })
  .readonly();

export type KarmaEventKind = z.infer<typeof KarmaEventKindSchema>;
export type KarmaEvent = z.infer<typeof KarmaEventSchema>;

export function parseKarmaEvent(value: unknown): KarmaEvent {
  return KarmaEventSchema.parse(value);
}