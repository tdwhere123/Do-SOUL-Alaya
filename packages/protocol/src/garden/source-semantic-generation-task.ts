import { z } from "zod";

/** Declared producer responsibility; it does not certify attention, fidelity or task completion. */
export const SourceSemanticGenerationTaskSchema = z.object({
  contract: z.literal("source-semantic-generation-task-v1"),
  context: z.literal("complete_original_source"),
  original_query: z.string().min(1).max(8192).refine(value => value.trim().length > 0),
  responsibility: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("all_supplied_meaning") }).strict().readonly(),
    z.object({ kind: z.literal("original_query_task"), other_meaning: z.literal("unassessed") }).strict().readonly()
  ])
}).strict().readonly();

export const SourceSemanticGenerationTaskSummarySchema = SourceSemanticGenerationTaskSchema.unwrap()
  .omit({ original_query: true }).readonly();
export type SourceSemanticGenerationTask = z.infer<typeof SourceSemanticGenerationTaskSchema>;
type SourceSemanticGenerationTaskSummary = z.infer<typeof SourceSemanticGenerationTaskSummarySchema>;

/** H identity binds the omitted cue; lightweight descriptors disclose responsibility without copying it. */
export function sourceSemanticGenerationTaskSummary(task: SourceSemanticGenerationTask): SourceSemanticGenerationTaskSummary {
  const { original_query: _query, ...summary } = SourceSemanticGenerationTaskSchema.parse(task);
  return summary;
}
