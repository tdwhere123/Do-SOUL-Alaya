import { z } from "zod";
import { IsoDatetimeStringSchema } from "../shared/schema-primitives.js";

/** A read-time qualification of delivered text. It does not change source or proof admission. */
export const SourceDisclosureSchema = z.object({
  material_kind: z.enum(["original_body", "retained_excerpt", "retained_gist", "interpretation"]),
  source_binding: z.enum(["checked_record", "unbound"]),
  evaluated_as_of: IsoDatetimeStringSchema,
  validity: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("bounded"), from: IsoDatetimeStringSchema,
      to_exclusive: IsoDatetimeStringSchema }).strict(),
    z.object({ kind: z.literal("open"), from: IsoDatetimeStringSchema }).strict(),
    z.object({ kind: z.literal("unknown"), reason: z.enum(["not_recorded", "unbound", "metadata_unavailable"]) }).strict()
  ]),
  temporal_state: z.enum(["before_start", "within_interval", "at_or_after_end", "unknown"]),
  proof_use: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("source_only"), qualification: z.literal("not_current_proof") }).strict(),
    z.object({ kind: z.literal("conditional_support"), qualification: z.literal("not_world_claim") }).strict()
  ])
}).strict().superRefine((value, context) => {
  if (value.source_binding === "unbound" && (value.validity.kind !== "unknown" || value.validity.reason !== "unbound")) {
    context.addIssue({ code: "custom", path: ["validity"], message: "unbound material cannot claim original validity" });
  }
  if (value.validity.kind === "unknown" && value.temporal_state !== "unknown") {
    context.addIssue({ code: "custom", path: ["temporal_state"], message: "unknown validity has unknown temporal relation" });
  }
}).readonly();

export type SourceDisclosure = z.infer<typeof SourceDisclosureSchema>;

/** Each retained text field is independently identified; content selects excerpt or gist. */
export const EvidenceTextDisclosuresSchema = z.object({
  content: SourceDisclosureSchema,
  gist: SourceDisclosureSchema,
  excerpt: SourceDisclosureSchema.optional()
}).strict().readonly();
export type EvidenceTextDisclosures = z.infer<typeof EvidenceTextDisclosuresSchema>;
