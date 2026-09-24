import { z } from "zod";
import { BoundedIdSchema } from "../shared/schema-primitives.js";

export const UTTERANCE_ATTRIBUTION_CONTRACT = "utterance-attribution-v1" as const;

export const ApprovedSemanticContextSchema = z.object({
  context_id: BoundedIdSchema, notes: z.string().min(1).max(1024).optional()
}).strict().readonly();
export type ApprovedSemanticContext = z.infer<typeof ApprovedSemanticContextSchema>;

const OccurrenceSchema = z.object({
  occurrence_id: BoundedIdSchema,
  utf8_span: z.tuple([z.number().int().nonnegative(), z.number().int().positive()]).readonly(),
  conversation_ref: BoundedIdSchema.nullable(),
  author_ref: BoundedIdSchema.nullable()
}).strict().readonly();

export const UtteranceAttributionSchema = z.discriminatedUnion("status", [
  z.object({ contract: z.literal(UTTERANCE_ATTRIBUTION_CONTRACT), status: z.literal("unknown") }).strict().readonly(),
  z.object({
    contract: z.literal(UTTERANCE_ATTRIBUTION_CONTRACT), status: z.literal("captured"),
    issuer_scope: BoundedIdSchema,
    utterances: z.array(OccurrenceSchema).min(1).max(256).readonly()
  }).strict().superRefine((value, context) => {
    const seen = new Set<string>();
    let end = 0;
    for (const [index, row] of value.utterances.entries()) {
      if (seen.has(row.occurrence_id)) context.addIssue({ code: "custom", path: ["utterances", index], message: "duplicate occurrence identity" });
      seen.add(row.occurrence_id);
      if (row.utf8_span[1] <= row.utf8_span[0] || row.utf8_span[0] < end) {
        context.addIssue({ code: "custom", path: ["utterances", index], message: "utterance spans must be nonempty, sorted and nonoverlapping" });
      }
      end = row.utf8_span[1];
    }
  }).readonly()
]).superRefine((value, context) => {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 2048) {
    context.addIssue({ code: "custom", message: "utterance attribution exceeds its metadata byte bound" });
  }
});
export type UtteranceAttribution = z.infer<typeof UtteranceAttributionSchema>;

export const UNKNOWN_UTTERANCE_ATTRIBUTION: UtteranceAttribution = Object.freeze({
  contract: UTTERANCE_ATTRIBUTION_CONTRACT, status: "unknown"
});

/** Validates byte ranges against the exact admitted/requested UTF-8 string. */
export function bindUtteranceAttribution(value: unknown, text: string): UtteranceAttribution {
  const attribution = UtteranceAttributionSchema.parse(value);
  if (attribution.status === "unknown") return attribution;
  const bytes = new TextEncoder().encode(text);
  for (const row of attribution.utterances) {
    const [start, end] = row.utf8_span;
    if (end > bytes.length || !isBoundary(bytes, start) || !isBoundary(bytes, end)) {
      throw new Error("utterance attribution range differs from its UTF-8 input");
    }
  }
  return attribution;
}

function isBoundary(bytes: Uint8Array, offset: number): boolean {
  return offset === 0 || offset === bytes.length || offset < bytes.length && (bytes[offset]! & 0xc0) !== 0x80;
}
