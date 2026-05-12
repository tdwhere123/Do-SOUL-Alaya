import { z } from "zod";

export const NonEmptyStringSchema = z.string().min(1);
export const IsoDatetimeStringSchema = z.string().datetime();
export const NonNegativeIntSchema = z.number().int().nonnegative();
export const PositiveIntSchema = z.number().int().positive();

/**
 * Bounded string primitives. p5-system-review-r3 MR-I03: attached
 * agents are an external boundary (anything reachable through MCP
 * stdio); zod must reject oversized payloads at parse time so the
 * daemon does not OOM on a 100 MB query or a 1 GB nested record.
 *
 * The numbers below are deliberately pragmatic, not minimal:
 *   - id-shaped fields (object_id, proposal_id, delivery_id, run_id):
 *     up to 256 chars (UUID + optional workspace/run prefix).
 *   - free-text query / search input: 4096 chars (about a long prompt).
 *   - reason / explanation prose: 16384 chars (~4-5 paragraphs).
 *   - generic short labels (slugs, signal kinds): 1024 chars.
 */
export const BoundedString = (max: number) => z.string().min(1).max(max);
export const BoundedIdSchema = BoundedString(256);
export const BoundedQuerySchema = BoundedString(4096);
export const BoundedReasonSchema = BoundedString(16384);
export const BoundedLabelSchema = BoundedString(1024);
/** Memory entry content body. 65536 chars covers long-form notes
 * (a few research paper sections) without giving any single MCP call
 * the ability to pin daemon memory with arbitrarily large strings.
 * Added per D2 MERGED-I6 (red-team-I4). */
export const BoundedContentSchema = BoundedString(65536);

export const BOUNDED_DEFAULT_ARRAY_MAX = 1000;
export const BOUNDED_EVIDENCE_ARRAY_MAX = 100;
export const BOUNDED_JSON_OBJECT_MAX_CHARS = 16384;

export const BoundedJsonObjectSchema = z
  .record(z.unknown())
  .superRefine((value, ctx) => {
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "JSON object must be serializable."
      });
      return;
    }
    if (serialized.length > BOUNDED_JSON_OBJECT_MAX_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: BOUNDED_JSON_OBJECT_MAX_CHARS,
        type: "string",
        inclusive: true,
        message: `JSON object must serialize to at most ${BOUNDED_JSON_OBJECT_MAX_CHARS} characters.`
      });
    }
  })
  .readonly();
