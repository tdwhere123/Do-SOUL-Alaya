import { z } from "zod";
import { IsoDatetimeStringSchema } from "../shared/schema-primitives.js";
import { SourceRepresentationSchema } from "./field-contract/source-span.js";
import { AlayaError } from "../shared/alaya-error.js";

const PROOF_USE = {
  source_only: Object.freeze({ kind: "source_only", qualification: "not_current_proof" }),
  conditional_support: Object.freeze({ kind: "conditional_support", qualification: "not_world_claim" })
} as const;

/** A read-time qualification of delivered text. It does not change source or proof admission. */
const SourceDisclosureObjectSchema = z.object({
  material_kind: z.enum(["original_body", "retained_excerpt", "retained_gist", "interpretation", "canonical_projection", "unknown"]),
  source_binding: z.enum(["checked_record", "unbound"]),
  source_representation: SourceRepresentationSchema.optional(),
  evaluated_as_of: IsoDatetimeStringSchema,
  /** Stored source observation/event time. Absence means undisclosed, not missing source metadata or event occurrence. */
  source_time: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("known"), at: IsoDatetimeStringSchema }).strict(),
    z.object({ kind: z.literal("unknown"), reason: z.enum(["not_recorded", "unbound", "metadata_unavailable"]) }).strict()
  ]).optional(),
  validity: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("bounded"), from: IsoDatetimeStringSchema,
      to_exclusive: IsoDatetimeStringSchema }).strict(),
    z.object({ kind: z.literal("open"), from: IsoDatetimeStringSchema }).strict(),
    z.object({ kind: z.literal("unknown"), reason: z.enum(["not_recorded", "unbound", "metadata_unavailable"]) }).strict()
  ]),
  temporal_state: z.enum(["before_start", "within_interval", "at_or_after_end", "unknown"]),
  proof_use: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal(PROOF_USE.source_only.kind), qualification: z.literal(PROOF_USE.source_only.qualification) }).strict(),
    z.object({ kind: z.literal(PROOF_USE.conditional_support.kind), qualification: z.literal(PROOF_USE.conditional_support.qualification) }).strict()
  ])
}).strict();

function refineSourceDisclosure(value: z.infer<typeof SourceDisclosureObjectSchema>, context: z.RefinementCtx): void {
  if (value.material_kind === "canonical_projection" && (value.source_binding !== "checked_record" ||
      value.source_representation?.kind !== "canonical_projection")) {
    context.addIssue({ code: "custom", path: ["source_representation"], message: "canonical projection requires checked source lineage" });
  }
  if (value.source_time?.kind === "known" && value.source_binding !== "checked_record") {
    context.addIssue({ code: "custom", path: ["source_time"], message: "source time requires a checked record" });
  }
  if (value.source_time?.kind === "unknown" && value.source_binding === "unbound"
    && value.source_time.reason !== "unbound") {
    context.addIssue({ code: "custom", path: ["source_time"], message: "unbound source time must remain unbound" });
  }
  if (value.source_time?.kind === "unknown" && value.source_binding === "checked_record"
    && value.source_time.reason === "unbound") {
    context.addIssue({ code: "custom", path: ["source_time"], message: "checked source time cannot be unbound" });
  }
  if (value.source_binding === "unbound" && (value.validity.kind !== "unknown" || value.validity.reason !== "unbound")) {
    context.addIssue({ code: "custom", path: ["validity"], message: "unbound material cannot claim original validity" });
  }
  if (value.validity.kind === "unknown" && value.temporal_state !== "unknown") {
    context.addIssue({ code: "custom", path: ["temporal_state"], message: "unknown validity has unknown temporal relation" });
  }
}
export const SourceDisclosureSemanticSchema = SourceDisclosureObjectSchema.superRefine(refineSourceDisclosure).readonly();

export type SourceDisclosureSemantic = z.infer<typeof SourceDisclosureSemanticSchema>;

/** Independent of library/result versions: Protocol 19's only live disclosure wire format. */
export const SOURCE_DISCLOSURE_CODEC_VERSION = 1 as const;
const fields = SourceDisclosureSemanticSchema.unwrap().shape;

/** Positional layout derives every value schema and semantic constraint from the named authority. */
const SourceDisclosureTupleSchema = z.tuple([
  z.literal(SOURCE_DISCLOSURE_CODEC_VERSION), fields.material_kind, fields.source_binding,
  fields.source_representation.unwrap().nullable(), fields.evaluated_as_of,
  fields.source_time.unwrap().nullable(), fields.validity, fields.temporal_state, fields.proof_use
]);
export type SourceDisclosure = readonly [
  version: typeof SOURCE_DISCLOSURE_CODEC_VERSION,
  material_kind: SourceDisclosureSemantic["material_kind"], source_binding: SourceDisclosureSemantic["source_binding"],
  source_representation: NonNullable<SourceDisclosureSemantic["source_representation"]> | null,
  evaluated_as_of: SourceDisclosureSemantic["evaluated_as_of"],
  source_time: NonNullable<SourceDisclosureSemantic["source_time"]> | null,
  validity: SourceDisclosureSemantic["validity"], temporal_state: SourceDisclosureSemantic["temporal_state"],
  proof_use: SourceDisclosureSemantic["proof_use"]
];
export const SourceDisclosureSchema: z.ZodType<SourceDisclosure> = SourceDisclosureTupleSchema.superRefine((wire, context) => {
  refineSourceDisclosure(sourceDisclosure(wire), context);
}).readonly().describe("SourceDisclosure codec v1: [1, material_kind, source_binding, source_representation_or_null, evaluated_as_of, source_time_or_null, validity, temporal_state, proof_use]. Null optional slots mean undisclosed, not unknown; nested values retain their named fields. The codec version is independent of library protocol versions.");
/** The qualification paired with a delivered proof kind has one owner. */
export function sourceDisclosureProofUse(kind: keyof typeof PROOF_USE): SourceDisclosureSemantic["proof_use"] {
  return PROOF_USE[kind];
}

function assertCodecVersion(version: unknown): void {
  if (version !== SOURCE_DISCLOSURE_CODEC_VERSION) throw new AlayaError("VALIDATION", "unsupported source disclosure codec version");
}

/** Change read qualification without expanding, recapturing or relabeling source metadata. */
export function qualifySourceDisclosure(wire: SourceDisclosure,
  proofUse: SourceDisclosureSemantic["proof_use"]["kind"], discloseTime = true): SourceDisclosure {
  assertCodecVersion(wire[0]);
  return Object.freeze([SOURCE_DISCLOSURE_CODEC_VERSION, wire[1], wire[2], wire[3], wire[4], discloseTime ? wire[5] : null,
    wire[6], wire[7], sourceDisclosureProofUse(proofUse)] as const);
}

/** Typed access to an admitted disclosure. Null slots mean undisclosed, never unknown. */
export function sourceDisclosure(wire: SourceDisclosure): SourceDisclosureSemantic {
  assertCodecVersion(wire[0]);
  return {
    material_kind: wire[1], source_binding: wire[2],
    ...(wire[3] === null ? {} : { source_representation: wire[3] }), evaluated_as_of: wire[4],
    ...(wire[5] === null ? {} : { source_time: wire[5] }),
    validity: wire[6], temporal_state: wire[7], proof_use: wire[8]
  };
}

/** Capture and validate once before producing the current lossless wire value. */
export function encodeSourceDisclosure(input: SourceDisclosureSemantic): SourceDisclosure {
  const value = SourceDisclosureSemanticSchema.parse(input);
  return Object.freeze([SOURCE_DISCLOSURE_CODEC_VERSION, value.material_kind, value.source_binding,
    value.source_representation ?? null, value.evaluated_as_of, value.source_time ?? null,
    value.validity, value.temporal_state, value.proof_use] as const);
}

/**
 * Offline ordinary-recall archive reader only. Remove when Protocol 14–18
 * captures are retired; never use this adapter for current MCP/worker ingress.
 */
export function decodeHistoricalSourceDisclosure(input: unknown, protocolVersion: 14 | 15 | 16 | 17 | 18): SourceDisclosureSemantic {
  if (![14, 15, 16, 17, 18].includes(protocolVersion)) throw new AlayaError("VALIDATION", "unsupported historical disclosure protocol");
  return SourceDisclosureSemanticSchema.parse(input);
}

/** Each retained text field is independently identified; content selects excerpt or gist. */
export const EvidenceTextDisclosuresSchema = z.object({
  content: SourceDisclosureSchema,
  gist: SourceDisclosureSchema,
  excerpt: SourceDisclosureSchema.optional()
}).strict().readonly();
export type EvidenceTextDisclosures = z.infer<typeof EvidenceTextDisclosuresSchema>;
