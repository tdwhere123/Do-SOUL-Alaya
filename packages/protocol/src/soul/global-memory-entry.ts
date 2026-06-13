import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";
import { MemoryDimensionSchema } from "./memory-entry.js";
import { ScopeClassSchema } from "./object-kind.js";

export const GLOBAL_MEMORY_ENTRY_OBJECT_KIND = "global_memory_entry" as const;

export const GlobalMemoryEntrySchema = z
  .object({
    global_object_id: NonEmptyStringSchema,
    object_kind: z.literal(GLOBAL_MEMORY_ENTRY_OBJECT_KIND),
    canonical_identity: NonEmptyStringSchema,
    dimension: MemoryDimensionSchema,
    scope_class: ScopeClassSchema,
    content: NonEmptyStringSchema,
    domain_tags: z.array(NonEmptyStringSchema).readonly(),
    provenance: NonEmptyStringSchema,
    activation_score: z.number().min(0).max(1).nullable(),
    version: NonNegativeIntSchema,
    created_at: IsoDatetimeStringSchema,
    updated_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export type GlobalMemoryEntry = z.infer<typeof GlobalMemoryEntrySchema>;
