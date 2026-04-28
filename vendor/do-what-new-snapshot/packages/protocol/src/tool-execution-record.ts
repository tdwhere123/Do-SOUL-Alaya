import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "./schema-primitives.js";
import { ToolPermissionResultSchema, ToolRequestedBySchema } from "./tool-governance.js";
import { ToolAffectedPathsSchema } from "./tool-affected-path.js";

export const ToolExecutionRollbackStatusSchema = z.enum(["none", "attempted", "succeeded", "failed"]);

export const ToolExecutionRecordSchema = z
  .object({
    execution_id: NonEmptyStringSchema,
    tool_id: NonEmptyStringSchema,
    requested_by: ToolRequestedBySchema,
    requesting_run_id: NonEmptyStringSchema,
    node_id: NonEmptyStringSchema.optional(),
    governance_decision_ref: NonEmptyStringSchema,
    permission_result: ToolPermissionResultSchema,
    executed: z.boolean(),
    started_at: IsoDatetimeStringSchema.optional(),
    ended_at: IsoDatetimeStringSchema.optional(),
    result_summary: z.string().optional(),
    rollback_status: ToolExecutionRollbackStatusSchema,
    post_effect_refs: z.array(NonEmptyStringSchema).readonly().optional(),
    affected_paths: ToolAffectedPathsSchema.nullable().optional()
  })
  .strict()
  .readonly();

export type ToolExecutionRollbackStatus = z.infer<typeof ToolExecutionRollbackStatusSchema>;
export type ToolExecutionRecord = Readonly<z.infer<typeof ToolExecutionRecordSchema>>;
