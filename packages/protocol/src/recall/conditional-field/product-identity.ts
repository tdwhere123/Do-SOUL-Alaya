import { z } from "zod";
import { BoundedIdSchema } from "../../shared/schema-primitives.js";
import { compareCodeUnits } from "../field-contract/canonical-identity.js";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  ConditionalFieldIdSchema,
  SchemaVersionSchema,
  Sha256DigestSchema
} from "./common.js";

export const CANONICAL_PRODUCT_IDENTITY_VERSION = "product-identity.v1" as const;
export const SourceEvidenceRootKindSchema = z.enum(["evidence_capsule", "source_record"]);

export const MemoryEntryTargetSchema = z
  .object({
    kind: z.literal("memory_entry"),
    workspace_id: BoundedIdSchema,
    object_id: ConditionalFieldIdSchema,
    source_revision: ConditionalFieldIdSchema
  })
  .strict()
  .readonly();

export const SourceEvidenceTargetSchema = z
  .object({
    kind: z.literal("source_evidence"),
    workspace_id: BoundedIdSchema,
    root_kind: SourceEvidenceRootKindSchema,
    root_id: ConditionalFieldIdSchema,
    source_version: ConditionalFieldIdSchema,
    content_digest: Sha256DigestSchema,
    evidence_object_id: ConditionalFieldIdSchema.nullable()
  })
  .strict()
  .readonly();

export const RecallTargetRefSchema = z.discriminatedUnion("kind", [
  MemoryEntryTargetSchema,
  SourceEvidenceTargetSchema
]);

export const ProductStateKeySchema = z
  .object({
    schema_version: SchemaVersionSchema,
    target: RecallTargetRefSchema,
    program_state: ConditionalFieldIdSchema,
    hypothesis_id: ConditionalFieldIdSchema,
    binding_context: ConditionalFieldIdSchema,
    time_state: ConditionalFieldIdSchema
  })
  .strict()
  .readonly();

export type SourceEvidenceRootKind = z.infer<typeof SourceEvidenceRootKindSchema>;
export type MemoryEntryTarget = z.infer<typeof MemoryEntryTargetSchema>;
export type SourceEvidenceTarget = z.infer<typeof SourceEvidenceTargetSchema>;
export type RecallTargetRef = z.infer<typeof RecallTargetRefSchema>;
export type ProductStateKey = z.infer<typeof ProductStateKeySchema>;

export type MemoryProductStateInput = Readonly<{
  readonly workspace_id: string;
  readonly object_id: string;
  readonly source_revision: string;
  readonly program_state: string;
  readonly hypothesis_id: string;
  readonly binding_context: string;
  readonly time_state: string;
}>;

export type SourceProductStateInput = Readonly<{
  readonly workspace_id: string;
  readonly root_kind: SourceEvidenceRootKind;
  readonly root_id: string;
  readonly source_version: string;
  readonly content_digest: string;
  readonly evidence_object_id: string | null;
  readonly program_state: string;
  readonly hypothesis_id: string;
  readonly binding_context: string;
  readonly time_state: string;
}>;

export function memoryRecallTarget(input: Readonly<{
  readonly workspace_id: string;
  readonly object_id: string;
  readonly source_revision: string;
}>): MemoryEntryTarget {
  return MemoryEntryTargetSchema.parse({
    kind: "memory_entry",
    workspace_id: input.workspace_id,
    object_id: input.object_id,
    source_revision: input.source_revision
  });
}

export function sourceRecallTarget(input: Readonly<{
  readonly workspace_id: string;
  readonly root_kind: SourceEvidenceRootKind;
  readonly root_id: string;
  readonly source_version: string;
  readonly content_digest: string;
  readonly evidence_object_id: string | null;
}>): SourceEvidenceTarget {
  return SourceEvidenceTargetSchema.parse({
    kind: "source_evidence",
    workspace_id: input.workspace_id,
    root_kind: input.root_kind,
    root_id: input.root_id,
    source_version: input.source_version,
    content_digest: input.content_digest,
    evidence_object_id: input.evidence_object_id
  });
}

export function memoryProductStateKey(input: MemoryProductStateInput): ProductStateKey {
  return ProductStateKeySchema.parse({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    target: memoryRecallTarget(input),
    program_state: input.program_state,
    hypothesis_id: input.hypothesis_id,
    binding_context: input.binding_context,
    time_state: input.time_state
  });
}

export function sourceProductStateKey(input: SourceProductStateInput): ProductStateKey {
  return ProductStateKeySchema.parse({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    target: sourceRecallTarget(input),
    program_state: input.program_state,
    hypothesis_id: input.hypothesis_id,
    binding_context: input.binding_context,
    time_state: input.time_state
  });
}

export function canonicalProductIdentity(key: ProductStateKey): string {
  return stableCanonicalStringify({
    identity_version: CANONICAL_PRODUCT_IDENTITY_VERSION,
    key
  });
}

export function productSubjectId(key: ProductStateKey): string {
  return key.target.kind === "memory_entry" ? key.target.object_id : key.target.root_id;
}

export function productMemoryObjectId(key: ProductStateKey): string | undefined {
  return key.target.kind === "memory_entry" ? key.target.object_id : undefined;
}

export function recallTargetWorkspaceId(target: RecallTargetRef): string {
  return target.workspace_id;
}

export function sameRecallTarget(left: RecallTargetRef, right: RecallTargetRef): boolean {
  return stableCanonicalStringify(left) === stableCanonicalStringify(right);
}

export function retargetMemoryProduct(
  from: ProductStateKey,
  patch: Readonly<{
    readonly object_id?: string;
    readonly program_state?: string;
    readonly hypothesis_id?: string;
    readonly binding_context?: string;
    readonly time_state?: string;
    readonly source_revision?: string;
    readonly workspace_id?: string;
  }>
): ProductStateKey {
  if (from.target.kind !== "memory_entry") {
    throw new Error("retargetMemoryProduct requires a memory_entry product");
  }
  const workspaceId = patch.workspace_id ?? from.target.workspace_id;
  const sourceRevision = patch.source_revision ?? from.target.source_revision;
  return memoryProductStateKey({
    workspace_id: workspaceId,
    object_id: patch.object_id ?? productSubjectId(from),
    source_revision: sourceRevision,
    program_state: patch.program_state ?? from.program_state,
    hypothesis_id: patch.hypothesis_id ?? from.hypothesis_id,
    binding_context: patch.binding_context ?? from.binding_context,
    time_state: patch.time_state ?? from.time_state
  });
}

export function stableCanonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableCanonicalStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, nested]) => `${key}:${stableCanonicalStringify(nested)}`)
      .join(",")}}`;
  }
  const scalar = JSON.stringify(value);
  return scalar === undefined ? "undefined" : scalar;
}
