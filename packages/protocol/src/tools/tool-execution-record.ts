import { z } from "zod";
import {
  BoundedIdSchema,
  BoundedLabelSchema,
  BoundedReasonSchema,
  IsoDatetimeStringSchema
} from "../shared/schema-primitives.js";
import { ToolPermissionResultSchema, ToolRequestedBySchema } from "./tool-governance.js";
import { ToolAffectedPathsSchema } from "./tool-affected-path.js";

export const ToolExecutionRollbackStatusSchema = z.enum(["none", "attempted", "succeeded", "failed"]);

export const ToolExecutionRecordSchema = z
  .object({
    execution_id: BoundedIdSchema,
    tool_id: BoundedLabelSchema,
    requested_by: ToolRequestedBySchema,
    requesting_run_id: BoundedIdSchema,
    node_id: BoundedIdSchema.optional(),
    governance_decision_ref: BoundedIdSchema,
    permission_result: ToolPermissionResultSchema,
    executed: z.boolean(),
    started_at: IsoDatetimeStringSchema.optional(),
    ended_at: IsoDatetimeStringSchema.optional(),
    result_summary: BoundedReasonSchema.optional(),
    rollback_status: ToolExecutionRollbackStatusSchema,
    post_effect_refs: z.array(BoundedIdSchema).readonly().optional(),
    affected_paths: ToolAffectedPathsSchema.nullable().optional()
  })
  .strict()
  .readonly();

export type ToolExecutionRollbackStatus = z.infer<typeof ToolExecutionRollbackStatusSchema>;
export type ToolExecutionRecord = Readonly<z.infer<typeof ToolExecutionRecordSchema>>;
