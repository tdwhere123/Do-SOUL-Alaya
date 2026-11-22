import { z } from "zod";
import { SourceIndexConfigurationSchema, SourceIndexGenerationStatusSchema,
  SourceIndexLexicalBindingSchema, SourceIndexLexicalSelectionSchema,
  SourceSemanticAcquisitionSchema } from "@do-soul/alaya-protocol";
import type { SourceIndexSnapshotFact } from "@do-soul/alaya-storage";

export { readSourceIndexSnapshotFact } from "@do-soul/alaya-storage";

const Count = z.number().int().nonnegative();
const Selection = z.object({ workspace_id: z.string(), selection_revision: Count, config_id: z.string(),
  profile_id: z.string(), configuration: SourceIndexConfigurationSchema }).strict();
export const SourceIndexSnapshotFactSchema: z.ZodType<SourceIndexSnapshotFact> = z.object({
  workspace_id: z.string(), source_epoch: Count,
  query_state: SourceSemanticAcquisitionSchema.unwrap().shape.vector.unwrap().shape.state.unwrap(),
  selection: Selection.nullable(), generation: z.object({ selection: Selection, generation_id: z.string(), source_epoch: Count,
    status: SourceIndexGenerationStatusSchema, enumeration_complete: z.boolean(), after_source_id: z.string().nullable(),
    target_count: Count, completed_count: Count, reason: z.string().nullable(),
    preparation_revision: Count, records_complete: z.boolean(), after_capsule_cursor: z.string().nullable() }).strict().nullable(),
  lexical: z.object({ selection: SourceIndexLexicalSelectionSchema.nullable(),
    selected: z.union([z.object({ status: z.literal("legacy") }).strict(),
      z.object({ status: z.literal("unavailable"), reason: z.string() }).strict(),
      z.object({ status: z.enum(["ready", "partial", "valid_empty"]), binding: SourceIndexLexicalBindingSchema }).strict()]),
    serving: z.enum(["raw", "generation", "unavailable"]) }).strict()
}).strict();
