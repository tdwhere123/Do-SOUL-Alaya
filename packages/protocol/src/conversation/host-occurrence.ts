import { z } from "zod";
import { AlayaError } from "../shared/alaya-error.js";
import { BoundedIdSchema, BoundedLabelSchema } from "../shared/schema-primitives.js";
import { canonicalJson } from "../recall/selection/capture/canonical-json.js";
import { FieldContractDigestSchema, formatFieldContractDigest, type FieldContractSha256 } from "../recall/field-contract/canonical-identity.js";

export const HOST_OCCURRENCE_CONTRACT = "host-occurrence-v1" as const;
export const HOST_OCCURRENCE_LIMITS = Object.freeze({ count: 256, inventoryBytes: 65_536, occurrenceBytes: 16_384 });
const bytes = (text: string) => new TextEncoder().encode(text).length;
const Id = BoundedIdSchema.refine(value => bytes(value) <= 1024, "host identifier exceeds byte limit");
const OpenLabel = BoundedLabelSchema.refine(value => bytes(value) <= 4096, "host label exceeds byte limit");
const ScopedReference = z.object({ scope: Id, id: Id }).strict().readonly();

/** References are host assertions, never authenticated human identity. Array order is local order. */
export const HostOccurrenceSchema = z.object({
  occurrence_id: Id,
  utf8_span: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).readonly(),
  role: OpenLabel.nullable(), channel: OpenLabel.nullable(),
  author_ref: ScopedReference.nullable(), container_ref: ScopedReference.nullable(),
  upstream_message_ref: ScopedReference.nullable(),
  upstream_position: z.number().int().nonnegative().nullable(),
  completeness: z.enum(["complete", "excerpt", "unknown"]),
  fidelity: z.enum(["original_bytes", "normalized", "unknown"])
}).strict().superRefine((value, context) => {
  if (value.utf8_span[1] < value.utf8_span[0]) {
    context.addIssue({ code: "custom", message: "invalid host occurrence extent" });
  }
  if (bytes(canonicalJson(value)) > HOST_OCCURRENCE_LIMITS.occurrenceBytes) {
    context.addIssue({ code: "custom", message: "host occurrence exceeds encoded byte limit",
      params: { host_resource_limit: true } });
  }
}).readonly();
export type HostOccurrence = z.infer<typeof HostOccurrenceSchema>;

/** Shared admission/index meaning: empty and incomplete occurrences are not addressable messages. */
export function hostOccurrenceIsMessage(row: Pick<HostOccurrence, "completeness" | "utf8_span">): boolean {
  return row.completeness === "complete" && row.utf8_span[1] > row.utf8_span[0];
}

export const HostCaptureIssuerSchema = z.object({
  namespace: Id, workspace_id: Id, producer: Id,
  basis: z.enum(["reported_excerpt", "pinned_dataset"])
}).strict().readonly();
export type HostCaptureIssuer = z.infer<typeof HostCaptureIssuerSchema>;

export const HostOccurrenceInventorySchema = z.object({
  contract: z.literal(HOST_OCCURRENCE_CONTRACT), issuer: HostCaptureIssuerSchema,
  occurrences: z.array(HostOccurrenceSchema).max(HOST_OCCURRENCE_LIMITS.count).readonly()
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  let end = 0;
  for (const row of value.occurrences) {
    if (seen.has(row.occurrence_id) || row.utf8_span[0] < end) {
      context.addIssue({ code: "custom", message: "host occurrences must be unique, ordered and nonoverlapping" });
    }
    seen.add(row.occurrence_id); end = row.utf8_span[1];
  }
  if (bytes(canonicalJson(value)) > HOST_OCCURRENCE_LIMITS.inventoryBytes) {
    context.addIssue({ code: "custom", message: "host inventory exceeds encoded byte limit",
      params: { host_resource_limit: true } });
  }
}).readonly();
export type HostOccurrenceInventory = z.infer<typeof HostOccurrenceInventorySchema>;

export const HostStructureDescriptorSchema = z.object({
  contract: z.literal(HOST_OCCURRENCE_CONTRACT), digest: FieldContractDigestSchema,
  occurrence_count: z.number().int().min(0).max(HOST_OCCURRENCE_LIMITS.count),
  encoded_bytes: z.number().int().positive().max(HOST_OCCURRENCE_LIMITS.inventoryBytes)
}).strict().readonly();
export type HostStructureDescriptor = z.infer<typeof HostStructureDescriptorSchema>;
export type HostStructureBinding = Readonly<{
  workspace_id: string; source_id: string; source_version: string; content_digest: string;
}>;

/** One canonical equality digest, not a provenance credential or source identity. */
export function describeHostStructure(binding: HostStructureBinding, inventory: HostOccurrenceInventory,
  sha256: FieldContractSha256): HostStructureDescriptor {
  const canonical = canonicalJson(HostOccurrenceInventorySchema.parse(inventory));
  if (inventory.issuer.workspace_id !== binding.workspace_id) throw new AlayaError("VALIDATION", "host issuer workspace mismatch");
  return HostStructureDescriptorSchema.parse({ contract: HOST_OCCURRENCE_CONTRACT,
    digest: formatFieldContractDigest(sha256(canonicalJson({ domain: HOST_OCCURRENCE_CONTRACT,
      workspace_id: binding.workspace_id, source_id: binding.source_id, source_version: binding.source_version,
      content_digest: binding.content_digest, inventory: JSON.parse(canonical) }))),
    occurrence_count: inventory.occurrences.length, encoded_bytes: bytes(canonical) });
}

/** Only canonical resource refusals may leave an optional producer capture unrecorded. */
export function isHostOccurrenceResourceLimit(error: unknown): boolean {
  return error instanceof z.ZodError && error.issues.length > 0 && error.issues.every(issue =>
    issue.code === "custom" && issue.params?.host_resource_limit === true);
}

export function bindHostOccurrenceInventory(value: unknown, content: string): HostOccurrenceInventory {
  const inventory = HostOccurrenceInventorySchema.parse(value);
  const encoded = new TextEncoder().encode(content);
  const boundary = (offset: number) => offset <= encoded.length &&
    (offset === encoded.length || (encoded[offset]! & 0xc0) !== 0x80);
  for (const row of inventory.occurrences) {
    if (!boundary(row.utf8_span[0]) || !boundary(row.utf8_span[1])) {
      throw new AlayaError("VALIDATION", "host occurrence differs from exact UTF-8 source extent");
    }
  }
  return inventory;
}
